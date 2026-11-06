// Runs activity (api/activity.py): what waits and runs now, what ended recently, and the batches that start soon.
import { queryOptions } from "@tanstack/react-query";

import { http } from "../api/http";


// What the URL says => the API's parameters. `scope`: me (default), all, or user (with `user`).
export const whoseParams = ({ scope, user }) => ({ scope: scope || 'me', user: scope === 'user' ? user : undefined });
// Only the runs of a queue, a batch...: the groups users can filter on (run_activity.MATCHES)
export const match_keys = ['batch', 'commit', 'command', 'branch', 'runner', 'queue', 'platform', 'option_value'];
export const filterParams = ({ project, window, status, search, option, ...rest }) => ({
  project: project || undefined,
  window: window || undefined,
  status: status || undefined,
  search: search || undefined,
  option: option || undefined,
  ...Object.fromEntries(match_keys.map(key => [key, rest[key] || undefined])),
});

// Pages that show what runs now refresh by themselves, unless users pause it. Not after an error: each refresh of a
// query without data shows the spinner again, and users would never see the error (they retry with its button).
export const refresh_interval = 15 * 1000;
const refreshing = live => query => live && query.state.status !== 'error' ? refresh_interval : false;

// While new numbers load, we show the previous ones, but not someone else's: when users switch to everyone's runs,
// their own numbers under "Everyone's" would be wrong.
export const keepIfSameWhose = whose => (previous, previous_query) =>
  previous_query?.queryKey.some(part => JSON.stringify(part) === JSON.stringify(whose)) ? previous : undefined;

// The overview counts every status. It needs the job option only to filter on its value.
const overviewParams = filters => filterParams({ ...filters, status: '', option: filters.option_value ? filters.option : '' });
export const overviewQuery = (filters, { live = true } = {}) => queryOptions({
  queryKey: ['activity', 'overview', whoseParams(filters), overviewParams(filters)],
  queryFn: async ({ signal }) => (await http.get('/api/v1/activity/overview', {
    params: { ...whoseParams(filters), ...overviewParams(filters) }, signal, background: true,
  })).data,
  placeholderData: keepIfSameWhose(whoseParams(filters)),
  staleTime: 5 * 1000,
  refetchInterval: refreshing(live),
});

export const items_page_size = 50;
// {items, total, group}
export const itemsQuery = (group, filters, { sort = 'active', offset = 0, live = true } = {}) => queryOptions({
  queryKey: ['activity', 'items', group, whoseParams(filters), filterParams(filters), sort, offset],
  queryFn: async ({ signal }) => (await http.get('/api/v1/activity/items', {
    params: { group, ...whoseParams(filters), ...filterParams(filters), sort, offset, limit: items_page_size }, signal, background: true,
  })).data,
  placeholderData: keepIfSameWhose(whoseParams(filters)),
  staleTime: 5 * 1000,
  refetchInterval: refreshing(live),
});

export const runs_page_size = 50;
// The runs, maybe only those of a group: {runs, total}
// `filters.sort`: oldest, for the runs pending the longest first
export const runsQuery = (filters, { group, key, offset = 0, live = true } = {}) => queryOptions({
  queryKey: ['activity', 'runs', group ?? '', key ?? '', whoseParams(filters), filterParams(filters), filters.sort === 'oldest' ? 'oldest' : '', offset],
  queryFn: async ({ signal }) => (await http.get('/api/v1/activity/runs', {
    params: { group: group || undefined, key: group ? key : undefined, ...whoseParams(filters), ...filterParams(filters), sort: filters.sort === 'oldest' ? 'oldest' : undefined, offset, limit: runs_page_size },
    signal, background: true,
  })).data,
  placeholderData: keepIfSameWhose(whoseParams(filters)),
  staleTime: 5 * 1000,
  refetchInterval: refreshing(live),
});

// Marks pending runs as failed: those of a group ({group, key}), or some runs ({ids}). With dry_run: how many it would.
// => {runs, batches, projects: {project: runs}, dry_run}
export const failRuns = async (queryClient, { group, key, ids, filters, dry_run = false }) => {
  const { data } = await http.post('/api/v1/activity/fail', {
    group: group || undefined, key: group ? key : undefined, ids: ids || undefined,
    // whatever the status filter, pending runs are marked as failed: only those pending for long if users chose them
    ...whoseParams(filters), filters: filterParams({ ...filters, status: filters.status === 'long' ? 'long' : '' }), dry_run,
  });
  if (!dry_run) queryClient.invalidateQueries({ queryKey: ['activity'] });
  return data;
};

// Stops a batch's runs: its jobs are killed, its pending runs fail (api/batch.py)
export const stopBatch = async (queryClient, id) => {
  const { data } = await http.post('/api/v1/batch/stop/', { id });
  queryClient.invalidateQueries({ queryKey: ['activity'] });
  return data;
};
