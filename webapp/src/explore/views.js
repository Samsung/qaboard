// Signed-in users' page views tell which projects people look at (Explore fades the others).
// The server counts them at most once an hour: we don't ask it more often, from each browser.
import { useEffect } from "react";

import { http } from "../api/http";
import { useUser } from "../hooks";

const storage_key = 'qaboard-project-views';
export const view_throttle_ms = 3600 * 1000;

// When this browser last sent views: {[project]: time}. Storage can be missing or throw (private windows...)
const read = () => {
  try {
    return JSON.parse(localStorage.getItem(storage_key) ?? '{}') ?? {};
  } catch {
    return {};
  }
};

// true when we should send the view, and remembers we did
export function claimView(project, now = Date.now()) {
  const sent = read();
  if (now - (sent[project] ?? 0) < view_throttle_ms) return false;
  // forget the old ones, the list stays short
  const kept = Object.fromEntries(Object.entries(sent).filter(([, t]) => now - t < view_throttle_ms));
  try {
    localStorage.setItem(storage_key, JSON.stringify({ ...kept, [project]: now }));
  } catch {
    // without storage, the server's throttle is enough
  }
  return true;
}

export function useRecordProjectView(project) {
  const { is_logged } = useUser();
  useEffect(() => {
    if (!is_logged || !project || !claimView(project)) return;
    // best effort: a failed view isn't worth telling users about
    http.post('/api/v1/project/view', { project }, { background: true }).catch(() => {});
  }, [is_logged, project]);
}
