/**
 * Preferences follow users in every browser: the server's values win at login, what it lacks is sent once,
 * then changes are sent a second later, only the keys that changed.
 * Run with: cd webapp && npm test -- prefsSync
 */
import { act } from '@testing-library/react';
import { createStore } from 'zustand/vanilla';

import { mergeOnLogin, changedPreferences, createPrefsSync, synced_keys, preferences_url, PrefsSync } from '../prefsSync';
import { usePrefsStore } from '../prefs';
import { renderWithProviders } from '../../test-utils';
import { userQuery, logged_out_user } from '../../api/queries';


const defaults = { theme: 'system', commitListDensity: 'comfortable', favorites: {}, tuning: {}, siderCollapsed: false };

describe('mergeOnLogin', () => {
  it("never sends what belongs to an account: the browser may have been someone else's", () => {
    const { apply, push } = mergeOnLogin({ git_emails: ['previous@user.org'], listScope: { 'a/b': 'all' }, theme: 'dark' }, {}, { keys: ['git_emails', 'listScope', 'theme'], defaults: { git_emails: [], listScope: {}, theme: 'system' } });
    expect(push).toEqual({ theme: 'dark' });
    expect(apply).toEqual({});
  });

  const keys = ['theme', 'commitListDensity', 'favorites', 'tuning'];

  it("applies the server's values", () => {
    const local = { ...defaults, theme: 'light' };
    const { apply, push } = mergeOnLogin(local, { theme: 'dark', favorites: { 'a/b': true } }, { keys, defaults });
    expect(apply).toEqual({ theme: 'dark', favorites: { 'a/b': true } });
    expect(push).toEqual({});
  });

  it('sends what the server lacks, but not the defaults', () => {
    const local = { ...defaults, commitListDensity: 'compact', tuning: { 'a/b': { batch: 'x' } } };
    const { apply, push } = mergeOnLogin(local, {}, { keys, defaults });
    expect(apply).toEqual({});
    expect(push).toEqual({ commitListDensity: 'compact', tuning: { 'a/b': { batch: 'x' } } });
  });

  it('changes nothing when they agree', () => {
    const local = { ...defaults, favorites: { 'a/b': true } };
    expect(mergeOnLogin(local, { favorites: { 'a/b': true }, theme: 'system' }, { keys, defaults })).toEqual({ apply: {}, push: {} });
  });

  it('ignores values of the wrong type, and keys it does not sync', () => {
    const { apply } = mergeOnLogin(defaults, { theme: 3, favorites: ['a/b'], siderCollapsed: true }, { keys, defaults });
    expect(apply).toEqual({});
  });

  it('keeps what users changed meanwhile', () => {
    const local = { ...defaults, theme: 'dark' };
    expect(mergeOnLogin(local, { theme: 'light' }, { keys, defaults, keep: ['theme'] }).apply).toEqual({});
  });

  it('syncs the preferences that follow users, not the sidebar', () => {
    for (const key of ['theme', 'commitListDensity', 'favorites', 'milestoneGroupsCollapsed', 'imagePixelValues', 'tuning'])
      expect(synced_keys).toContain(key);
    expect(synced_keys).not.toContain('siderCollapsed');
    // they all exist in the store
    for (const key of synced_keys)
      expect(usePrefsStore.getInitialState()).toHaveProperty(key);
  });
});

describe('changedPreferences', () => {
  it('lists the synced keys that changed', () => {
    const before = { ...defaults };
    expect(changedPreferences(before, { ...before, theme: 'dark', siderCollapsed: true })).toEqual({ theme: 'dark' });
    // same content, new object
    expect(changedPreferences(before, { ...before, favorites: {} })).toEqual({});
  });
});


// the defaults, then what users changed in this browser
const makeStore = state => {
  const store = createStore(() => defaults);
  store.setState(state ?? {});
  return store;
};
const makeClient = (preferences = {}) => ({
  get: vi.fn().mockResolvedValue({ data: { preferences, updated_at: '2026-10-01T00:00:00Z' } }),
  post: vi.fn().mockResolvedValue({ data: {} }),
});

describe('createPrefsSync', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("applies the server's values at login, sends the others once, and doesn't send back what it applied", async () => {
    const store = makeStore({ commitListDensity: 'compact' });
    const client = makeClient({ theme: 'dark' });
    const sync = createPrefsSync({ store, client, keys: ['theme', 'commitListDensity'] });
    await sync.start();
    expect(store.getState().theme).toBe('dark');
    expect(client.post).toHaveBeenCalledTimes(1);
    expect(client.post).toHaveBeenCalledWith(preferences_url, { preferences: { commitListDensity: 'compact' } }, expect.objectContaining({ background: true }));
    await vi.advanceTimersByTimeAsync(5000);
    expect(client.post).toHaveBeenCalledTimes(1);
    sync.stop();
  });

  it('sends changes a second after the last one, only the keys that changed', async () => {
    const store = makeStore();
    const client = makeClient({});
    const sync = createPrefsSync({ store, client, keys: ['theme', 'commitListDensity'] });
    await sync.start();
    expect(client.post).not.toHaveBeenCalled();
    store.setState({ theme: 'light' });
    await vi.advanceTimersByTimeAsync(500);
    store.setState({ theme: 'dark', siderCollapsed: true });
    await vi.advanceTimersByTimeAsync(999);
    expect(client.post).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(client.post).toHaveBeenCalledTimes(1);
    expect(client.post.mock.calls[0][1]).toEqual({ preferences: { theme: 'dark' } });
    // what the server answers isn't applied: nothing loops
    await vi.advanceTimersByTimeAsync(5000);
    expect(client.post).toHaveBeenCalledTimes(1);
    sync.stop();
  });

  it('saves the last changes when it stops', async () => {
    const store = makeStore();
    const client = makeClient({});
    const sync = createPrefsSync({ store, client, keys: ['theme'] });
    await sync.start();
    store.setState({ theme: 'dark' });
    sync.stop();
    expect(client.post).toHaveBeenCalledWith(preferences_url, { preferences: { theme: 'dark' } }, expect.objectContaining({ keepalive: true }));
    store.setState({ theme: 'light' });
    await vi.advanceTimersByTimeAsync(5000);
    expect(client.post).toHaveBeenCalledTimes(1);
  });

  it('keeps preferences in the browser when the server does not have them', async () => {
    const store = makeStore();
    const client = { get: vi.fn().mockRejectedValue(new Error('404')), post: vi.fn() };
    const sync = createPrefsSync({ store, client, keys: ['theme'] });
    await sync.start();
    store.setState({ theme: 'dark' });
    await vi.advanceTimersByTimeAsync(5000);
    expect(client.post).not.toHaveBeenCalled();
    sync.stop();
    expect(client.post).not.toHaveBeenCalled();
  });
});


describe('PrefsSync', () => {
  const json = data => Promise.resolve(new Response(JSON.stringify(data), { headers: { 'Content-Type': 'application/json' } }));
  afterEach(() => vi.restoreAllMocks());

  it('does nothing for logged-out users', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(() => json({ preferences: {} }));
    renderWithProviders(<PrefsSync/>, { user: logged_out_user });
    await act(() => Promise.resolve());
    expect(fetch).not.toHaveBeenCalled();
  });

  it("gets the user's preferences at login", async () => {
    const before = usePrefsStore.getState().theme;
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(() => json({ preferences: { theme: 'dark' } }));
    const { queryClient, unmount } = renderWithProviders(<PrefsSync/>, { user: logged_out_user });
    await act(async () => queryClient.setQueryData(userQuery.queryKey, { ...logged_out_user, is_logged: true, user_id: 1, user_name: 'alice' }));
    await vi.waitFor(() => expect(usePrefsStore.getState().theme).toBe('dark'));
    expect(fetch.mock.calls[0][0]).toBe(preferences_url);
    unmount();
    usePrefsStore.setState({ theme: before });
  });
});
