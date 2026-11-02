// Runs activity (api/activity.py): what waits and runs now, what ended recently, and the batches that start soon.
import { queryOptions, keepPreviousData } from "@tanstack/react-query";

import { http } from "../api/http";


// What the URL says => the API's parameters. `scope`: me (default), all, or user (with `user`).
export const whoseParams = ({ scope, user }) => ({ scope: scope || 'me', user: scope === 'user' ? user : undefined });
export const filterParams = ({ project, window, status, search, option }) => ({
  project: project || undefined,
  window: window || undefined,
  status: status || undefined,
  search: search || undefined,
  option: option || undefined,
});

// Pages that show what runs now refresh by themselves, unless users pause it
export const refresh_interval = 15 * 1000;
const refreshing = live => live ? refresh_interval : false;

export const overviewQuery = (filters, { live = true } = {}) => queryOptions({
  queryKey: ['activity', 'overview', whoseParams(filters), filterParams({ ...filters, status: '', option: '' })],
  queryFn: async ({ signal }) => (await http.get('/api/v1/activity/overview', {
    params: { ...whoseParams(filters), ...filterParams({ ...filters, status: '', option: '' }) }, signal, background: true,
  })).data,
  placeholderData: keepPreviousData,
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
  placeholderData: keepPreviousData,
  staleTime: 5 * 1000,
  refetchInterval: refreshing(live),
});

export const runs_page_size = 50;
// The runs, maybe only those of a group: {runs, total}
export const runsQuery = (filters, { group, key, offset = 0, live = true } = {}) => queryOptions({
  queryKey: ['activity', 'runs', group ?? '', key ?? '', whoseParams(filters), filterParams(filters), offset],
  queryFn: async ({ signal }) => (await http.get('/api/v1/activity/runs', {
    params: { group: group || undefined, key: group ? key : undefined, ...whoseParams(filters), ...filterParams(filters), offset, limit: runs_page_size },
    signal, background: true,
  })).data,
  placeholderData: keepPreviousData,
  staleTime: 5 * 1000,
  refetchInterval: refreshing(live),
});

// Marks pending runs as failed: those of a group ({group, key}), or some runs ({ids}). With dry_run: how many it would.
// => {runs, batches, projects: {project: runs}, dry_run}
export const failRuns = async (queryClient, { group, key, ids, filters, dry_run = false }) => {
  const { data } = await http.post('/api/v1/activity/fail', {
    group: group || undefined, key: group ? key : undefined, ids: ids || undefined,
    ...whoseParams(filters), filters: filterParams({ ...filters, status: '' }), dry_run,
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
