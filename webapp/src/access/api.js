// Who can see and change a project (design/user-management.md, Appendix D.5). Writes go through http, then refresh
// the project's access, and what it changes: the project pages a new viewer can now open.
import { queryOptions, keepPreviousData } from "@tanstack/react-query";

import { http } from "../api/http";


// {project, my_role, via, can_manage, visibility: {own, effective, inherited_from, default}, owners, grants, requests,
// my_request}. Non-managers get no grants nor requests.
export const projectAccessQuery = project => queryOptions({
  queryKey: ['access', project],
  queryFn: async ({ signal }) => {
    const { data } = await http.get('/api/v1/project/access', { params: { project }, signal });
    return {
      ...data,
      project: data?.project ?? project,
      my_role: data?.my_role ?? null,
      can_manage: !!data?.can_manage,
      visibility: { own: null, effective: null, inherited_from: null, default: null, ...data?.visibility },
      owners: data?.owners ?? [],
      grants: data?.grants ?? [],
      requests: data?.requests ?? [],
      my_request: data?.my_request ?? null,
    };
  },
  enabled: !!project,
  staleTime: 30 * 1000,
});

const invalidateAccess = (queryClient, project) => Promise.all([
  queryClient.invalidateQueries({ queryKey: ['access', project] }),
  // e.g. the project page that answered 403
  queryClient.invalidateQueries({ queryKey: ['project', project] }),
]);

// `visibility`: public, internal, private, or null to inherit it
export const setVisibility = async (queryClient, project, visibility) => {
  const { data } = await http.post('/api/v1/project/access/visibility', { project, visibility });
  await invalidateAccess(queryClient, project);
  return data;
};

// Adds a member, or changes their role: one grant per subject and project. => the grant
export const saveGrant = async (queryClient, project, { subject, role, expires_at }) => {
  const { data } = await http.post('/api/v1/project/access/grants', {
    project,
    subject: { type: subject.type, id: subject.id },
    role,
    ...(expires_at ? { expires_at } : {}),
  });
  await invalidateAccess(queryClient, project);
  return data;
};

// The server refuses to remove the last owner (400, with a sentence)
export const deleteGrant = async (queryClient, project, id) => {
  const { data } = await http.delete(`/api/v1/project/access/grants/${id}`);
  await invalidateAccess(queryClient, project);
  return data;
};

// => the request
export const requestAccess = async (queryClient, project, { role, message }) => {
  const { data } = await http.post('/api/v1/project/access/requests', { project, role, message });
  await invalidateAccess(queryClient, project);
  return data;
};

// `decision`: approve or deny. Approving grants `role`, by default the one asked.
export const decideRequest = async (queryClient, project, id, { decision, role }) => {
  const { data } = await http.post(`/api/v1/project/access/requests/${id}`, { decision, ...(role ? { role } : {}) });
  await invalidateAccess(queryClient, project);
  return data;
};


// Users and groups whose names match `q`, for the member pickers: {users: [{id, user_name, full_name}], groups: [{id, name}]}
export const directoryQuery = q => queryOptions({
  queryKey: ['directory', q],
  queryFn: async ({ signal }) => {
    const { data } = await http.get('/api/v1/directory', { params: { q }, signal });
    return { users: data?.users ?? [], groups: data?.groups ?? [] };
  },
  // while users type, keep showing the previous matches
  placeholderData: keepPreviousData,
  staleTime: 60 * 1000,
});
