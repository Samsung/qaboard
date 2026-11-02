// The admin API (design/user-management.md, Appendix A.6). Writes go through http, then refresh the queries.
import { queryOptions, infiniteQueryOptions, keepPreviousData } from "@tanstack/react-query";

import { http } from "../api/http";


export const overviewQuery = queryOptions({
  queryKey: ['admin', 'overview'],
  queryFn: async ({ signal }) => (await http.get('/api/v1/admin/overview', { signal })).data,
  staleTime: 30 * 1000,
});

export const users_page_size = 50;
// {search, status, admin, offset} => {users, total}
export const usersQuery = ({ search = '', status = '', admin = false, offset = 0 }) => queryOptions({
  queryKey: ['admin', 'users', { search, status, admin, offset }],
  queryFn: async ({ signal }) => {
    const params = { search: search || undefined, status: status || undefined, admin: admin ? true : undefined, limit: users_page_size, offset };
    const { data } = await http.get('/api/v1/admin/users', { params, signal });
    return { users: data?.users ?? [], total: data?.total ?? 0 };
  },
  // while users type or change page, keep showing the previous page
  placeholderData: keepPreviousData,
  staleTime: 30 * 1000,
});

// {user, tokens, audit}
export const adminUserQuery = id => queryOptions({
  queryKey: ['admin', 'user', String(id)],
  queryFn: async ({ signal }) => {
    const { data } = await http.get(`/api/v1/admin/users/${id}`, { signal });
    return { user: data?.user, tokens: data?.tokens ?? [], audit: data?.audit ?? [], access_request: data?.access_request ?? null };
  },
  enabled: !!id,
  staleTime: 30 * 1000,
});

const invalidateUsers = queryClient => Promise.all([
  queryClient.invalidateQueries({ queryKey: ['admin'] }),
  queryClient.invalidateQueries({ queryKey: ['tokens'] }),
]);

// {status?: "active"|"disabled", is_admin?: bool} => the user
export const updateUser = async (queryClient, id, changes) => {
  const { data } = await http.post(`/api/v1/admin/users/${id}`, changes);
  invalidateUsers(queryClient);
  return data;
};

// => {revoked: n}
export const revokeUserTokens = async (queryClient, id) => {
  const { data } = await http.post(`/api/v1/admin/users/${id}/revoke-tokens`);
  invalidateUsers(queryClient);
  return data;
};


export const tokens_page_size = 50;
export const adminTokensQuery = ({ status = '', user, offset = 0 }) => queryOptions({
  queryKey: ['admin', 'tokens', { status, user, offset }],
  queryFn: async ({ signal }) => {
    const { data } = await http.get('/api/v1/admin/tokens', { params: { status: status || undefined, user, limit: tokens_page_size, offset }, signal });
    return { tokens: data?.tokens ?? [], total: data?.total ?? 0 };
  },
  placeholderData: keepPreviousData,
  staleTime: 30 * 1000,
});

export const adminRevokeToken = async (queryClient, id) => {
  const { data } = await http.delete(`/api/v1/admin/tokens/${id}`);
  invalidateUsers(queryClient);
  return data;
};


// Keyset pagination: each page gives the id to continue before
export const audit_page_size = 100;
export const auditQuery = ({ action = '', actor = '', target_type = '', target_id = '' }) => infiniteQueryOptions({
  queryKey: ['admin', 'audit', { action, actor, target_type, target_id }],
  queryFn: async ({ signal, pageParam }) => {
    const params = {
      action: action || undefined,
      actor: actor || undefined,
      target_type: target_type || undefined,
      target_id: target_id || undefined,
      before_id: pageParam,
      limit: audit_page_size,
    };
    const { data } = await http.get('/api/v1/admin/audit', { params, signal });
    return { events: data?.events ?? [], next_before_id: data?.next_before_id ?? null };
  },
  initialPageParam: undefined,
  getNextPageParam: last_page => last_page.next_before_id ?? undefined,
  placeholderData: keepPreviousData,
  staleTime: 30 * 1000,
});

export const auditActionsQuery = queryOptions({
  queryKey: ['admin', 'audit-actions'],
  queryFn: async ({ signal }) => (await http.get('/api/v1/admin/audit/actions', { signal })).data?.actions ?? [],
  staleTime: 5 * 60 * 1000,
});


export const settingsQuery = queryOptions({
  queryKey: ['admin', 'settings'],
  queryFn: async ({ signal }) => (await http.get('/api/v1/admin/settings', { signal })).data?.settings ?? [],
  staleTime: 30 * 1000,
});

// `null` resets to the default. The server answers with all the settings.
export const saveSetting = async (queryClient, key, value) => {
  const { data } = await http.post('/api/v1/admin/settings', { [key]: value });
  if (Array.isArray(data?.settings)) queryClient.setQueryData(settingsQuery.queryKey, data.settings);
  queryClient.invalidateQueries({ queryKey: ['admin', 'overview'] });
  // e.g. whether sign-in is required
  queryClient.invalidateQueries({ queryKey: ['config'] });
  return data?.settings;
};


// => {revoked: n}. Users are signed out of every browser: they sign in again.
export const revokeUserSessions = async (queryClient, id) => {
  const { data } = await http.post(`/api/v1/admin/users/${id}/revoke-sessions`);
  invalidateUsers(queryClient);
  return data;
};


// Users waiting for an admin, with their message (design/user-management.md, Appendix C.4).
// `status`: "pending" or "all". Approving and denying are status changes of the user (updateUser).
export const accessRequestsQuery = (status = 'pending', { background = false } = {}) => queryOptions({
  queryKey: ['admin', 'access-requests', status],
  queryFn: async ({ signal }) => (await http.get('/api/v1/admin/access-requests', { params: { status }, signal, background })).data?.requests ?? [],
  staleTime: 60 * 1000,
});


// Admin → Sign-in: {providers, can_encrypt: whether secrets can be stored here (QABOARD_ENCRYPTION_KEY), public_url}
export const signInAdminQuery = queryOptions({
  queryKey: ['admin', 'sign-in'],
  queryFn: async ({ signal }) => {
    const { data } = await http.get('/api/v1/admin/sign-in', { signal });
    return { providers: data?.providers ?? [], can_encrypt: !!data?.can_encrypt, public_url: data?.public_url ?? '' };
  },
  staleTime: 30 * 1000,
});

const invalidateProviders = queryClient => Promise.all([
  queryClient.invalidateQueries({ queryKey: ['admin', 'sign-in'] }),
  queryClient.invalidateQueries({ queryKey: ['auth', 'providers'] }),
]);

// OIDC providers. `id` only when creating. => the provider
export const saveProvider = async (queryClient, { id, ...fields }, { create = false } = {}) => {
  const { data } = create
    ? await http.post('/api/v1/admin/sign-in/providers', { id, ...fields })
    : await http.post(`/api/v1/admin/sign-in/providers/${encodeURIComponent(id)}`, fields);
  invalidateProviders(queryClient);
  return data;
};

export const deleteProvider = async (queryClient, id) => {
  const { data } = await http.delete(`/api/v1/admin/sign-in/providers/${encodeURIComponent(id)}`);
  invalidateProviders(queryClient);
  return data;
};

// The checks of `qaboard-admin check-sign-in`: {checks: [{check, ok, detail}], ok}. `user_name`: for LDAP, a user to look up.
export const testProvider = async (id, { user_name } = {}) =>
  (await http.post(`/api/v1/admin/sign-in/providers/${encodeURIComponent(id)}/test`, user_name ? { user_name } : {})).data;


// Groups of users (design/user-management.md, Appendix D.3): members added by admins, or by rules on the claims of
// their sign-in. {groups: [{id, name, description, member_count, rule_count}], sync: {last_job, schedule}}:
// the daily update of users' groups (backend/jobs/groups.py). Refreshed while it runs.
export const groupsQuery = queryOptions({
  queryKey: ['admin', 'groups'],
  queryFn: async ({ signal }) => {
    const { data } = await http.get('/api/v1/admin/groups', { signal });
    return { groups: data?.groups ?? [], sync: data?.sync ?? null };
  },
  staleTime: 30 * 1000,
  refetchInterval: query => isActiveJob(query.state.data?.sync?.last_job) ? 2000 : false,
});

// {group, members: [{user: {id, user_name, full_name}, source: manual|rule, added_at}], rules: [{id, provider_id, claim, values}]}
// Servers may answer the group's fields at the top level, with its members and rules.
export const groupQuery = id => queryOptions({
  queryKey: ['admin', 'group', String(id)],
  queryFn: async ({ signal }) => {
    const { data } = await http.get(`/api/v1/admin/groups/${encodeURIComponent(id)}`, { signal });
    const { members, rules, group, ...fields } = data ?? {};
    return { group: group ?? fields, members: members ?? group?.members ?? [], rules: rules ?? group?.rules ?? [] };
  },
  enabled: id !== undefined && id !== null,
  staleTime: 30 * 1000,
});

const invalidateGroups = queryClient => Promise.all([
  queryClient.invalidateQueries({ queryKey: ['admin'] }),
  // the member pickers
  queryClient.invalidateQueries({ queryKey: ['directory'] }),
]);
const group_url = id => `/api/v1/admin/groups/${encodeURIComponent(id)}`;

// => the group
export const createGroup = async (queryClient, { name, description }) => {
  const { data } = await http.post('/api/v1/admin/groups', { name, description });
  await invalidateGroups(queryClient);
  return data?.group ?? data;
};

export const updateGroup = async (queryClient, id, changes) => {
  const { data } = await http.post(group_url(id), changes);
  await invalidateGroups(queryClient);
  return data;
};

export const deleteGroup = async (queryClient, id) => {
  const { data } = await http.delete(group_url(id));
  await invalidateGroups(queryClient);
  return data;
};

export const addGroupMember = async (queryClient, id, user_id) => {
  const { data } = await http.post(`${group_url(id)}/members`, { user_id });
  await invalidateGroups(queryClient);
  return data;
};

export const removeGroupMember = async (queryClient, id, user_id) => {
  const { data } = await http.delete(`${group_url(id)}/members/${encodeURIComponent(user_id)}`);
  await invalidateGroups(queryClient);
  return data;
};

// `provider_id`: null for any way of signing in. `values`: any of them matches.
export const addGroupRule = async (queryClient, id, { provider_id, claim, values }) => {
  const { data } = await http.post(`${group_url(id)}/rules`, { provider_id: provider_id ?? null, claim, values });
  await invalidateGroups(queryClient);
  return data;
};

export const deleteGroupRule = async (queryClient, id, rule_id) => {
  const { data } = await http.delete(`${group_url(id)}/rules/${encodeURIComponent(rule_id)}`);
  await invalidateGroups(queryClient);
  return data;
};


// Roles on all projects, private ones included: [{id, subject, role, granted_by, granted_at, expires_at}]
export const instanceGrantsQuery = queryOptions({
  queryKey: ['admin', 'grants', 'instance'],
  queryFn: async ({ signal }) => (await http.get('/api/v1/admin/grants', { params: { resource_type: 'instance' }, signal })).data?.grants ?? [],
  staleTime: 30 * 1000,
});

const invalidateGrants = queryClient => Promise.all([
  queryClient.invalidateQueries({ queryKey: ['admin'] }),
  queryClient.invalidateQueries({ queryKey: ['access'] }),
]);

// `subject`: {type: user|group, id}. Same subject: changes the role. => the grant
export const addInstanceGrant = async (queryClient, { subject, role }) => {
  const { data } = await http.post('/api/v1/admin/grants', { subject: { type: subject.type, id: subject.id }, role });
  await invalidateGrants(queryClient);
  return data;
};

export const deleteInstanceGrant = async (queryClient, id) => {
  const { data } = await http.delete(`/api/v1/admin/grants/${encodeURIComponent(id)}`);
  await invalidateGrants(queryClient);
  return data;
};

// Admin → Storage: server jobs (hard deletes, old results), their errors and schedules (api/admin_jobs.py).
const active_statuses = ['queued', 'running'];
export const isActiveJob = job => active_statuses.includes(job?.status);

// {jobs, next_before_id, workers: {online, last_seen_at}, kinds}. Refreshed while jobs run.
export const jobsQuery = ({ status = '', kind = '' } = {}) => infiniteQueryOptions({
  queryKey: ['admin', 'jobs', { status, kind }],
  queryFn: async ({ signal, pageParam }) => {
    const { data } = await http.get('/api/v1/admin/jobs', { params: { status: status || undefined, kind: kind || undefined, before_id: pageParam, limit: 30 }, signal });
    return { jobs: data?.jobs ?? [], next_before_id: data?.next_before_id ?? null, workers: data?.workers ?? { online: [], last_seen_at: null } };
  },
  initialPageParam: undefined,
  getNextPageParam: last_page => last_page.next_before_id ?? undefined,
  refetchInterval: query => query.state.data?.pages?.some(page => page.jobs.some(isActiveJob)) ? 3000 : 30000,
});

export const jobQuery = id => queryOptions({
  queryKey: ['admin', 'job', String(id)],
  queryFn: async ({ signal }) => (await http.get(`/api/v1/admin/jobs/${id}`, { signal })).data,
  enabled: !!id,
  refetchInterval: query => isActiveJob(query.state.data) ? 2000 : false,
});

export const jobErrorsQuery = (id, { kind = '', owner = '', project = '', offset = 0 } = {}, { active = false } = {}) => queryOptions({
  queryKey: ['admin', 'job', String(id), 'errors', { kind, owner, project, offset }],
  queryFn: async ({ signal }) => (await http.get(`/api/v1/admin/jobs/${id}/errors`, {
    params: { kind: kind || undefined, owner: owner || undefined, project: project || undefined, offset, limit: job_errors_page_size }, signal,
  })).data,
  placeholderData: keepPreviousData,
  refetchInterval: active ? 5000 : false,
});
export const job_errors_page_size = 100;

const invalidateJobs = queryClient => queryClient.invalidateQueries({ queryKey: ['admin'] });

// 409 when a job of the same kind is queued or running: error.response.data.job is that job
export const startJob = async (queryClient, kind, params) => {
  const { data } = await http.post('/api/v1/admin/jobs', { kind, params });
  invalidateJobs(queryClient);
  return data;
};

// `force`: don't wait for its worker, e.g. stuck reading a storage that doesn't answer
export const cancelJob = async (queryClient, id, { force = false } = {}) => {
  const { data } = await http.post(`/api/v1/admin/jobs/${id}/cancel`, force ? { force } : undefined);
  invalidateJobs(queryClient);
  return data;
};

// The same job again. `changes`: e.g. {dry_run: false} to run a dry run for real
export const retryJob = async (queryClient, id, changes = {}) => {
  const { data } = await http.post(`/api/v1/admin/jobs/${id}/retry`, changes);
  invalidateJobs(queryClient);
  return data;
};

// {total, projects: {id: count}, timeout}: how many deleted runs a hard delete would look at
export const estimateJob = async (kind, params) => (await http.post('/api/v1/admin/jobs/estimate', { kind, params })).data;

// The projects that patterns select: {total, projects (the first 200)}
export const matchingProjectsQuery = ({ projects, exclude_projects }) => queryOptions({
  queryKey: ['admin', 'jobs-projects', { projects, exclude_projects }],
  queryFn: async ({ signal }) => (await http.get('/api/v1/admin/jobs/projects', { params: { projects, exclude_projects }, signal })).data,
  placeholderData: keepPreviousData,
  staleTime: 60 * 1000,
});

export const schedulesQuery = queryOptions({
  queryKey: ['admin', 'job-schedules'],
  queryFn: async ({ signal }) => (await http.get('/api/v1/admin/job-schedules', { signal })).data?.schedules ?? [],
  refetchInterval: 30 * 1000,
});

// When a cron expression runs next: {next_runs} or an error
export const nextRunsQuery = (cron, timezone) => queryOptions({
  queryKey: ['admin', 'next-runs', cron, timezone],
  queryFn: async ({ signal }) => (await http.get('/api/v1/admin/job-schedules/next-runs', { params: { cron, timezone }, signal })).data?.next_runs ?? [],
  enabled: !!cron?.trim(),
  retry: false,
  staleTime: 60 * 1000,
});

// `id` to update, else creates it
export const saveSchedule = async (queryClient, id, fields) => {
  const { data } = id
    ? await http.post(`/api/v1/admin/job-schedules/${id}`, fields)
    : await http.post('/api/v1/admin/job-schedules', fields);
  invalidateJobs(queryClient);
  return data;
};

export const deleteSchedule = async (queryClient, id) => {
  const { data } = await http.delete(`/api/v1/admin/job-schedules/${id}`);
  invalidateJobs(queryClient);
  return data;
};

// => the job, started now
export const runSchedule = async (queryClient, id) => {
  const { data } = await http.post(`/api/v1/admin/job-schedules/${id}/run`);
  invalidateJobs(queryClient);
  return data;
};


// Storage scans (api/admin_storage.py): what's on disk, what QA-Board tracks or not, and acting on it
export const scansQuery = queryOptions({
  queryKey: ['admin', 'scans'],
  queryFn: async ({ signal }) => (await http.get('/api/v1/admin/scans', { signal })).data?.scans ?? [],
  refetchInterval: query => query.state.data?.some(scan => scan.status === 'running') ? 5000 : false,
});

export const scanQuery = id => queryOptions({
  queryKey: ['admin', 'scan', String(id)],
  queryFn: async ({ signal }) => (await http.get(`/api/v1/admin/scans/${id}`, { signal })).data,
  refetchInterval: query => query.state.data?.status === 'running' ? 5000 : false,
});

// {parent} for a folder's entries (none: the roots), or {flat: true, kind} for all the entries of some kinds
export const scanEntriesQuery = (id, { parent, flat, kind, owner, sort, offset = 0 } = {}) => queryOptions({
  queryKey: ['admin', 'scan', String(id), 'entries', { parent, flat, kind, owner, sort, offset }],
  queryFn: async ({ signal }) => (await http.get(`/api/v1/admin/scans/${id}/entries`, {
    params: { parent: parent || undefined, flat: flat ? true : undefined, kind: kind || undefined, owner: owner || undefined, sort: sort || undefined, offset, limit: 200 }, signal,
  })).data,
  placeholderData: keepPreviousData,
});

const invalidateScan = (queryClient, id) => Promise.all([
  queryClient.invalidateQueries({ queryKey: ['admin', 'scan', String(id)] }),
  queryClient.invalidateQueries({ queryKey: ['admin', 'jobs'] }),
]);

// What the scan found, not the files
export const deleteScan = async (queryClient, id) => {
  await http.delete(`/api/v1/admin/scans/${id}`);
  queryClient.removeQueries({ queryKey: ['admin', 'scan', String(id)] });
  await queryClient.invalidateQueries({ queryKey: ['admin', 'scans'] });
};

// => {job}
export const deleteScanPaths = async (queryClient, id, paths) => {
  const { data } = await http.post(`/api/v1/admin/scans/${id}/delete`, { paths });
  invalidateScan(queryClient, id);
  return data;
};

// => {exports}
export const trackScanExports = async (queryClient, id, paths) => {
  const { data } = await http.post(`/api/v1/admin/scans/${id}/track-exports`, { paths });
  invalidateScan(queryClient, id);
  return data;
};

// => {job}
export const importScanRuns = async (queryClient, id, paths) => {
  const { data } = await http.post(`/api/v1/admin/scans/${id}/import-runs`, { paths });
  invalidateScan(queryClient, id);
  return data;
};
