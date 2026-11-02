// Service accounts: bots for CI and scripts, the instance's (admins) or a project's (its owners), and their tokens.
// `project` is null for the instance's. Writes go through http, then refresh the lists and the project's members.
import { queryOptions } from "@tanstack/react-query";

import { http } from "../api/http";


// [{id, name, user_name, description, owner_type, project, role, status, created_at, created_by, active_tokens, last_used_at}]
export const serviceAccountsQuery = project => queryOptions({
  queryKey: ['service-accounts', project ?? null],
  queryFn: async ({ signal }) => {
    const { data } = await http.get('/api/v1/service-accounts', { params: project ? { project } : {}, signal });
    return data?.service_accounts ?? [];
  },
  staleTime: 30 * 1000,
});

// The account, with its `tokens`
export const serviceAccountQuery = id => queryOptions({
  queryKey: ['service-accounts', 'detail', id],
  queryFn: async ({ signal }) => (await http.get(`/api/v1/service-accounts/${id}`, { signal })).data,
  staleTime: 30 * 1000,
});

const invalidate = (queryClient, project) => Promise.all([
  queryClient.invalidateQueries({ queryKey: ['service-accounts'] }),
  // they're members of the project, or have a role on all projects
  project ? queryClient.invalidateQueries({ queryKey: ['access', project] }) : queryClient.invalidateQueries({ queryKey: ['admin'] }),
  // the instance's are offered as members
  queryClient.invalidateQueries({ queryKey: ['directory'] }),
]);

// {name, role, description} => the account
export const createServiceAccount = async (queryClient, project, account) => {
  const { data } = await http.post('/api/v1/service-accounts', { ...account, ...(project ? { project } : {}) });
  await invalidate(queryClient, project);
  return data;
};

// `role`: null removes the role of an instance's account
export const setServiceAccountRole = async (queryClient, account, role) => {
  const { data } = await http.post(`/api/v1/service-accounts/${account.id}`, { role });
  await invalidate(queryClient, account.project);
  return data;
};

// Its tokens stop working
export const deleteServiceAccount = async (queryClient, account) => {
  const { data } = await http.delete(`/api/v1/service-accounts/${account.id}`);
  await invalidate(queryClient, account.project);
  return data;
};

// {name, scopes, projects, expires_in_days} => the token, with its secret in `token`
export const createServiceAccountToken = async (queryClient, account, token) => {
  const { data } = await http.post(`/api/v1/service-accounts/${account.id}/tokens`, token);
  await invalidate(queryClient, account.project);
  return data;
};

export const revokeServiceAccountToken = async (queryClient, account, token_id) => {
  const { data } = await http.delete(`/api/v1/service-accounts/${account.id}/tokens/${token_id}`);
  await invalidate(queryClient, account.project);
  return data;
};
