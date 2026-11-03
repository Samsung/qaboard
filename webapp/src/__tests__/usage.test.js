// Usage events, sent to QA-Board's own server (docs/design/usage-analytics.md): batched, never in the way
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

import { track, initUsage, flushUsage, _resetUsageForTests, _usageQueueForTests } from '../analytics';

const sent = fetch => fetch.mock.calls.map(([url, init]) => [url, JSON.parse(init.body)]);

describe('usage events', () => {
  let fetch;
  beforeEach(() => {
    _resetUsageForTests();
    localStorage.clear();
    fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    _resetUsageForTests();
  });

  it('keeps the events of a visit until the server configuration says whether it records them', () => {
    // the first page view happens before the configuration is known
    track('page_view', { route: 'commit' }, { project_id: 'a/b' });
    track('release_notes_popup', { slug: '2026-11' });
    expect(_usageQueueForTests()).toHaveLength(0);
    initUsage({});
    expect(_usageQueueForTests().map(e => e.event)).toEqual(['page_view', 'release_notes_popup']);
    vi.advanceTimersByTime(10 * 1000);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sent(fetch)[0][1].events[0]).toMatchObject({ event: 'page_view', project_id: 'a/b' });
  });

  it('drops them when the server does not record events', () => {
    track('page_view', { route: 'commit' });
    initUsage({ analytics_enabled: false });
    track('page_view', { route: 'commit' });
    expect(_usageQueueForTests()).toHaveLength(0);
    vi.advanceTimersByTime(10 * 1000);
    expect(fetch).not.toHaveBeenCalled();
    initUsage({ analytics_enabled: true });
    track('page_view', { route: 'commit' }, { project_id: 'a/b' });
    expect(_usageQueueForTests()).toHaveLength(1);
  });

  it('keeps at most 50 events while waiting', () => {
    for (let i = 0; i < 60; i++) track('image_viewer_use', { feature: 'compare' });
    initUsage({});
    // 50 waited, flushed by 20 as they're queued: 40 sent, 10 wait for the timer
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(_usageQueueForTests()).toHaveLength(10);
  });

  it('queues events with the project, the browser id and the time, and sends them later in one request', () => {
    initUsage({});
    track('page_view', { route: 'commit', has_reference: true }, { project_id: 'repo/sub', client_time: new Date('2026-11-03T10:00:00Z') });
    track('output_open', { viewer: 'images' });
    expect(fetch).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10 * 1000);
    expect(fetch).toHaveBeenCalledTimes(1);
    const [[url, body]] = sent(fetch);
    expect(url).toBe('/api/v1/events');
    expect(body.source).toBe('webapp');
    expect(body.events).toHaveLength(2);
    expect(body.events[0]).toMatchObject({ event: 'page_view', properties: { route: 'commit', has_reference: true }, project_id: 'repo/sub', timestamp: '2026-11-03T10:00:00.000Z' });
    expect(body.events[1].project_id).toBeUndefined();
    expect(body.events[0].client_id).toBe(body.events[1].client_id);
    // the browser keeps its id
    expect(localStorage.getItem('qaboard:client_id')).toBe(body.events[0].client_id);
    expect(fetch.mock.calls[0][1]).toMatchObject({ method: 'POST', credentials: 'same-origin', keepalive: true });
    expect(_usageQueueForTests()).toHaveLength(0);
  });

  it('sends right away once 20 events wait', () => {
    initUsage({});
    for (let i = 0; i < 19; i++) track('image_viewer_use', { feature: 'compare' });
    expect(fetch).not.toHaveBeenCalled();
    track('image_viewer_use', { feature: 'region' });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(sent(fetch)[0][1].events).toHaveLength(20);
  });

  it('uses a beacon when the page hides, so that the events survive it', () => {
    const sendBeacon = vi.fn(() => true);
    Object.defineProperty(navigator, 'sendBeacon', { value: sendBeacon, configurable: true });
    try {
      initUsage({});
      track('page_view', { route: 'home' });
      Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
      document.dispatchEvent(new Event('visibilitychange'));
      expect(sendBeacon).toHaveBeenCalledTimes(1);
      const [url, blob] = sendBeacon.mock.calls[0];
      expect(url).toBe('/api/v1/events');
      // text/plain: no CORS preflight, the server parses it as JSON
      expect(blob.type).toBe('text/plain');
      expect(fetch).not.toHaveBeenCalled();
      expect(_usageQueueForTests()).toHaveLength(0);
    } finally {
      Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
      delete navigator.sendBeacon;
    }
  });

  it('drops events the server did not take, without telling users', async () => {
    const debug = vi.spyOn(console, 'debug').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    fetch.mockRejectedValue(new TypeError('Failed to fetch'));
    initUsage({});
    track('page_view', { route: 'home' });
    flushUsage();
    await vi.runAllTimersAsync();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(debug).toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
    expect(_usageQueueForTests()).toHaveLength(0);
  });
});
