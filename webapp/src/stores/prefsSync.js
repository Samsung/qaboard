// Users' preferences follow them on every browser where they log in: the server keeps those listed here
// (GET/POST /api/v1/user/preferences), the others stay in the browser (e.g. whether the sidebar is collapsed).
//
// - At login, the server's values win. The preferences it doesn't have yet are sent once, from this browser.
// - Then changes are sent a second after the last one, only the keys that changed.
// - Logged-out users keep their preferences in this browser only.
import { useEffect } from "react";

import { http } from "../api/http";
import { useUser } from "../hooks";
import { usePrefsStore } from "./prefs";

// Not `siderCollapsed` (it depends on the screen) nor `milestones` (they move to the account, see milestones/hooks.js)
export const synced_keys = ['theme', 'commitListDensity', 'favorites', 'milestoneGroupsCollapsed', 'exploreGroups', 'imagePixelValues', 'tuning', 'hide_shared_settings', 'listScope', 'git_emails', 'homeDismissed'];

// What belongs to an account rather than to a browser: never sent from this browser to the account that signs in
// (it may be another person's), e.g. the server reads git_emails to know whose commits are whose
export const account_keys = ['git_emails', 'listScope', 'homeDismissed'];

export const preferences_url = '/api/v1/user/preferences';

const kind = value => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
// preferences are JSON
const same = (a, b) => a === b || JSON.stringify(a) === JSON.stringify(b);
const is_empty = object => Object.keys(object).length === 0;


// At login: what to change in the browser (`apply`), and what to send to the server (`push`).
// - The server's values win, unless they don't have the type the app expects (e.g. saved by another version).
// - We send what the server lacks, except the defaults: they are the same everywhere.
// - `keep`: keys users changed while we were asking the server: theirs win.
export function mergeOnLogin(local, server, { keys = synced_keys, defaults = {}, keep = [] } = {}) {
  const apply = {};
  const push = {};
  for (const key of keys) {
    const server_value = server?.[key];
    const has_server_value = server_value !== undefined && server_value !== null;
    if (has_server_value && !keep.includes(key)) {
      if (local[key] !== undefined && kind(server_value) !== kind(local[key])) continue;
      if (!same(server_value, local[key])) apply[key] = server_value;
    } else if (!has_server_value && local[key] !== undefined && !same(local[key], defaults[key]) && !account_keys.includes(key)) {
      push[key] = local[key];
    }
  }
  return { apply, push };
}

// The synced preferences that differ between two states of the store. `null` removes a key on the server.
export function changedPreferences(previous, next, keys = synced_keys) {
  const changes = {};
  for (const key of keys)
    if (previous?.[key] !== next?.[key] && !same(previous?.[key], next?.[key])) changes[key] = next?.[key] ?? null;
  return changes;
}


// Keeps a store and the server in sync, for one logged-in user: start() at login, stop() at logout.
// It never loops: what we write in the store from the server isn't sent back, and we ignore what POST answers.
export function createPrefsSync({ store = usePrefsStore, client = http, delay = 1000, keys = synced_keys } = {}) {
  let pending = {};
  let timer = null;
  let ready = false;
  let applying = false;
  let stopped = false;

  const flush = options => {
    clearTimeout(timer);
    timer = null;
    if (!ready || is_empty(pending)) return Promise.resolve();
    const preferences = pending;
    pending = {};
    return client.post(preferences_url, { preferences }, { background: true, ...options })
      .then(() => undefined)
      .catch(error => console.warn('Could not save your preferences', error));
  };

  const unsubscribe = store.subscribe((state, previous) => {
    if (applying || stopped) return;
    const changes = changedPreferences(previous, state, keys);
    if (is_empty(changes)) return;
    Object.assign(pending, changes);
    if (!ready) return;
    clearTimeout(timer);
    timer = setTimeout(flush, delay);
  });

  const start = async () => {
    let server;
    try {
      const { data } = await client.get(preferences_url, { background: true });
      server = data?.preferences ?? {};
    } catch {
      // e.g. a server that predates synced preferences: they stay in this browser
      unsubscribe();
      return;
    }
    if (stopped) return;
    const defaults = store.getInitialState?.() ?? {};
    const { apply, push } = mergeOnLogin(store.getState(), server, { keys, defaults, keep: Object.keys(pending) });
    if (!is_empty(apply)) {
      applying = true;
      try {
        store.setState(apply);
      } finally {
        applying = false;
      }
    }
    ready = true;
    Object.assign(pending, push);
    await flush();
  };

  const stop = () => {
    // what changed in the last second is still saved
    flush({ keepalive: true });
    stopped = true;
    unsubscribe();
  };

  return { start, stop, flush };
}


// For logged-in users, rendered once near the root of the app
export function usePrefsSync() {
  const { is_logged, user_id } = useUser();
  useEffect(() => {
    if (!is_logged) return;
    const sync = createPrefsSync();
    sync.start();
    // users may close the tab right after changing something
    const onPageHide = () => sync.flush({ keepalive: true });
    window.addEventListener('pagehide', onPageHide);
    return () => {
      window.removeEventListener('pagehide', onPageHide);
      sync.stop();
    };
  }, [is_logged, user_id]);
}

export const PrefsSync = () => {
  usePrefsSync();
  return null;
};
