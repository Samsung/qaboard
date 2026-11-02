// Storage usage, for users (api/storage.py): usage by project, batch, commit, branch and folder, deleting runs' files.
import { queryOptions, keepPreviousData } from "@tanstack/react-query";

import { http } from "../api/http";


// What the URL says => the API's parameters. `scope`: me (default), all, or user (with `user`).
export const whoseParams = ({ scope, user }) => ({ scope: scope || 'me', user: scope === 'user' ? user : undefined });
export const filterParams = ({ project, folder, branch, older, search }) => ({
  project: project || undefined,
  folder: folder || undefined,
  branch: branch || undefined,
  older_than_days: older || undefined,
  search: search || undefined,
});

export const overviewQuery = filters => queryOptions({
  queryKey: ['storage', 'overview', whoseParams(filters), filters.project ?? ''],
  queryFn: async ({ signal }) => (await http.get('/api/v1/storage/overview', { params: { ...whoseParams(filters), project: filters.project || undefined }, signal })).data,
  placeholderData: keepPreviousData,
  staleTime: 30 * 1000,
  // while the usage is being computed
  refetchInterval: query => query.state.data?.building ? 10 * 1000 : false,
});

export const items_page_size = 50;
// {items, total, totals, group}
export const itemsQuery = (group, filters, { sort = 'size', offset = 0 } = {}) => queryOptions({
  queryKey: ['storage', 'items', group, whoseParams(filters), filterParams(filters), sort, offset],
  queryFn: async ({ signal }) => (await http.get('/api/v1/storage/items', {
    params: { group, ...whoseParams(filters), ...filterParams(filters), sort, offset, limit: items_page_size }, signal,
  })).data,
  // the previous page or filters while the next load, never another tab's: batches, commits and branches have other fields
  placeholderData: (previous, previousQuery) => previousQuery?.queryKey[2] === group ? previous : undefined,
  staleTime: 30 * 1000,
});

// Who uses the most, everyone's runs with the filters: {users, total, totals, me, can_delete_others}
export const usersQuery = filters => queryOptions({
  queryKey: ['storage', 'users', filterParams(filters)],
  queryFn: async ({ signal }) => (await http.get('/api/v1/storage/users', { params: { ...filterParams(filters), limit: 200 }, signal })).data,
  placeholderData: keepPreviousData,
  staleTime: 30 * 1000,
});

// {path, children, here, partial}
export const foldersQuery = (path, filters) => queryOptions({
  queryKey: ['storage', 'folders', path ?? '/', whoseParams(filters), filterParams({ ...filters, folder: null })],
  queryFn: async ({ signal }) => (await http.get('/api/v1/storage/folders', {
    params: { path: path || undefined, ...whoseParams(filters), ...filterParams({ ...filters, folder: null }) }, signal,
  })).data,
  placeholderData: keepPreviousData,
  staleTime: 30 * 1000,
});

// What a selection would delete: {group, keys} (or no keys: everything that matches the filters)
const selectionBody = ({ group, keys, filters }) => ({ group, keys: keys ?? undefined, ...whoseParams(filters), filters: filterParams(filters) });
export const previewDeletion = async selection => (await http.post('/api/v1/storage/preview', selectionBody(selection))).data;

// => {job, preview}
export const deleteSelection = async (queryClient, selection, confirm) => {
  const { data } = await http.post('/api/v1/storage/delete', { ...selectionBody(selection), confirm: confirm || undefined });
  queryClient.invalidateQueries({ queryKey: ['storage', 'jobs'] });
  return data;
};

const active = job => job?.status === 'queued' || job?.status === 'running';
export const isActiveDeletion = active;

export const deletionsQuery = queryOptions({
  queryKey: ['storage', 'jobs'],
  queryFn: async ({ signal }) => (await http.get('/api/v1/storage/jobs', { signal })).data?.jobs ?? [],
  refetchInterval: query => query.state.data?.some(active) ? 2000 : false,
});

export const deletionErrorsQuery = id => queryOptions({
  queryKey: ['storage', 'jobs', id, 'errors'],
  queryFn: async ({ signal }) => (await http.get(`/api/v1/storage/jobs/${id}/errors`, { signal })).data,
});

export const cancelDeletion = async (queryClient, id) => {
  const { data } = await http.post(`/api/v1/storage/jobs/${id}/cancel`);
  queryClient.invalidateQueries({ queryKey: ['storage', 'jobs'] });
  return data;
};

// After a deletion: the numbers change
export const refreshUsage = queryClient => queryClient.invalidateQueries({ queryKey: ['storage'] });


// What deletes results, when, and what it keeps. Without a project: every rule. {rules, settings, project}
export const rulesQuery = project => queryOptions({
  queryKey: ['storage', 'rules', project || ''],
  queryFn: async ({ signal }) => (await http.get('/api/v1/storage/rules', { params: { project: project || undefined }, signal })).data,
  staleTime: 5 * 60 * 1000,
});

// The exports QA-Board tracks: {exports, totals: {count, bytes, linked_bytes}}
export const exportsQuery = (filters, sort = 'size') => queryOptions({
  queryKey: ['storage', 'exports', whoseParams(filters), filters.project ?? '', sort],
  queryFn: async ({ signal }) => (await http.get('/api/v1/storage/exports', {
    params: { ...whoseParams(filters), project: filters.project || undefined, sort }, signal,
  })).data,
  placeholderData: keepPreviousData,
  staleTime: 30 * 1000,
});

// => {job}
export const deleteExports = async (queryClient, ids) => {
  const { data } = await http.post('/api/v1/storage/exports/delete', { ids });
  queryClient.invalidateQueries({ queryKey: ['storage', 'jobs'] });
  return data;
};

export const measureExport = async (queryClient, id) => {
  const { data } = await http.post(`/api/v1/storage/exports/${id}/measure`);
  queryClient.invalidateQueries({ queryKey: ['storage', 'exports'] });
  return data;
};

// What the latest storage scan found that QA-Board doesn't track, owned by the user: {scan, totals, entries, user}.
// Admins see everyone's (user: null) or someone's, like the runs.
export const untrackedQuery = filters => queryOptions({
  queryKey: ['storage', 'untracked', whoseParams(filters)],
  queryFn: async ({ signal }) => (await http.get('/api/v1/storage/untracked', { params: whoseParams(filters), signal })).data,
  placeholderData: keepPreviousData,
  staleTime: 60 * 1000,
});

// => {job}
export const deleteUntracked = async (queryClient, paths) => {
  const { data } = await http.post('/api/v1/storage/untracked/delete', { paths });
  queryClient.invalidateQueries({ queryKey: ['storage', 'jobs'] });
  return data;
};
