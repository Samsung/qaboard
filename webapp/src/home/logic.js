// What goes where on the home page: the user's projects, the batches that need attention, the "Learn" links.
// Pure functions, tested in __tests__/logic.test.js.
import { is_listed, last_activity, time } from "../explore/tree";
import { attention_days } from "./api";

const day_ms = 24 * 3600 * 1000;
export const my_projects_days = 90;

/**
 * The projects where users ran batches, committed, or looked lately, and those they pinned, the most recent first.
 * projects: {[id]: details} from /api/v1/projects, batches: theirs, from /api/v1/batches.
 * => [{id, details, pinned, last_activity, my_time}]
 */
export function my_projects(projects, { favorites = {}, batches = [], now = Date.now() } = {}) {
  const since = now - my_projects_days * day_ms;
  const mine = {};
  const bump = (id, date) => {
    const t = time(date);
    if (t !== null && t >= since && !(mine[id] >= t)) mine[id] = t;
  };
  for (const [id, details] of Object.entries(projects)) {
    bump(id, details.my_latest_activity);
    bump(id, details.my_last_view);
  }
  for (const batch of batches) bump(batch.project, batch.latest_output_datetime);
  const ids = new Set([...Object.keys(mine), ...Object.keys(favorites).filter(id => favorites[id])]);
  return [...ids]
    .filter(id => projects[id] && (is_listed(projects[id]) || favorites[id]))
    .map(id => {
      const details = projects[id];
      const activity = last_activity(details);
      return { id, details, pinned: !!favorites[id], last_activity: activity, my_time: mine[id] ?? null, sort: mine[id] ?? time(activity.date) ?? 0 };
    })
    .sort((a, b) => (b.sort - a.sort) || a.id.localeCompare(b.id));
}

export const is_running = batch => batch.pending_outputs > 0;

// Finished in the last week with failed runs, unless users dismissed it (it comes back when it runs again: more
// failures, or the same number after a redo)
export const needs_attention = (batches, dismissed = {}, now = Date.now()) => batches.filter(b => {
  if (!(b.failed_outputs > 0) || is_running(b)) return false;
  if (time(b.latest_output_datetime) < now - attention_days * day_ms) return false;
  const seen = dismissed[b.id];
  return !(seen && seen.failed >= b.failed_outputs && (!seen.latest || seen.latest === b.latest_output_datetime));
});

// For the docs: what users haven't tried yet, else what's useful to everyone. Paths are under docs_root.
const learn_links = [
  { id: 'first-review', when: ({ has_batches }) => !has_batches, title: 'Review your first results', description: 'Find your commit, compare it with its reference, open the outputs.', path: 'docs/user-guide/first-review' },
  { id: 'webapp', when: ({ has_webapp }) => !has_webapp, title: 'Tune from the web app', description: 'Start batches and tuning experiments without a terminal.', path: 'docs/user-guide/running-from-the-webapp' },
  { id: 'activity', when: ({ has_running }) => has_running, title: 'Follow your runs', description: 'What waits, runs and ended, on every project.', path: 'docs/user-guide/runs-activity' },
  { id: 'compare', when: ({ has_batches }) => has_batches, title: 'Compare two batches', description: 'Tick them in a project’s Batches, then Compare.', path: 'docs/user-guide/comparing-results#compare-two-batches-of-the-same-commit' },
  { id: 'milestones', when: () => true, title: 'Save milestones', description: 'Name the results you compare against.', path: 'docs/user-guide/milestones' },
  { id: 'image-viewer', when: () => true, title: 'Compare images', description: 'Side by side, with a wipe, or as their difference.', path: 'docs/user-guide/image-viewer' },
];

// has_batches: any of theirs, has_webapp: one started from the web app, has_running: now
export const learn = (usage, { max = 3 } = {}) => learn_links.filter(link => link.when(usage)).slice(0, max);
