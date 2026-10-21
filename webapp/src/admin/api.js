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
