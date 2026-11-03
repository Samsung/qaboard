import { describe, it, expect, beforeEach, vi } from 'vitest';
import { scrubUrl, isChunkError, reloadForNewVersion, errorDetails, reportUrl } from '../errors';

describe('scrubUrl', () => {
  it('filters secrets like the backend', () => {
    expect(scrubUrl('http://qa/p/commit/1?token=abc&a=1')).toBe('http://qa/p/commit/1?token=[Filtered]&a=1');
    expect(scrubUrl('/x?private_token=abc#y')).toBe('/x?private_token=[Filtered]#y');
    expect(scrubUrl('/x?selected=a')).toBe('/x?selected=a');
  });
});

describe('isChunkError', () => {
  it('recognizes the browsers\' messages', () => {
    expect(isChunkError(new TypeError('Failed to fetch dynamically imported module: /assets/a.js'))).toBe(true);
    expect(isChunkError(new TypeError('error loading dynamically imported module: /assets/a.js'))).toBe(true);
    expect(isChunkError(new TypeError('Importing a module script failed.'))).toBe(true);
    expect(isChunkError(new TypeError("Cannot read properties of undefined (reading 'x')"))).toBe(false);
    expect(isChunkError(undefined)).toBe(false);
  });
});

describe('reloadForNewVersion', () => {
  beforeEach(() => sessionStorage.clear());

  it('reloads, but not again right after', () => {
    const reload = vi.fn();
    expect(reloadForNewVersion({ now: 1000, reload })).toBe(true);
    expect(reloadForNewVersion({ now: 2000, reload })).toBe(false);
    expect(reload).toHaveBeenCalledTimes(1);
    // e.g. another deploy, later
    expect(reloadForNewVersion({ now: 1000 + 60 * 1000, reload })).toBe(true);
    expect(reload).toHaveBeenCalledTimes(2);
  });
});

describe('errorDetails', () => {
  it('says where, what, and the reference, without secrets', () => {
    window.history.replaceState(null, '', '/group/project/commit/abc?token=secret');
    const details = errorDetails({ error: new TypeError('boom'), componentStack: '\n    at Viewer\n    at OutputCard', eventId: 'e1' });
    expect(details).toMatch(/^Page: http.*\/group\/project\/commit\/abc\?token=\[Filtered\]\n/);
    expect(details).toContain('Error: TypeError: boom');
    expect(details).toContain('Reference: e1');
    expect(details).toMatch(/\n\nComponents:\nat Viewer\nat OutputCard$/);
    expect(details).not.toContain('secret');
    expect(errorDetails({ error: new Error('boom') })).not.toContain('Reference');
  });
});

describe('reportUrl', () => {
  const report = { subject: 'Oops', body: 'a b' };
  it('pre-fills emails', () => {
    expect(reportUrl('mailto:qa@example.com', report)).toBe('mailto:qa@example.com?subject=Oops&body=a%20b');
    expect(reportUrl('mailto:qa@example.com?cc=b@example.com', report)).toBe('mailto:qa@example.com?cc=b@example.com&subject=Oops&body=a%20b');
  });
  it('pre-fills GitHub issues', () => {
    expect(reportUrl('https://github.com/Samsung/qaboard/issues', report)).toBe('https://github.com/Samsung/qaboard/issues/new?title=Oops&body=a%20b');
    expect(reportUrl(null, report)).toBe('https://github.com/Samsung/qaboard/issues/new?title=Oops&body=a%20b');
  });
  it('links to other trackers as they are', () => {
    expect(reportUrl('https://jira.example.com/servicedesk/qa', report)).toBe('https://jira.example.com/servicedesk/qa');
  });
});
