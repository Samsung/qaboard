// Changing the demo stack's state for a shot through its API, as a persona, and undoing it afterwards: who owns a
// project, access requests. The snapshot has none of them (docs-media/README.md#the-demo-stack-and-its-data), and CI
// restores it before capturing: what a capture leaves (denied requests, audit events) doesn't last.
import { request as playwrightRequest, type APIRequestContext, type APIResponse } from '@playwright/test';
import { DEMO_PASSWORD, type Demo } from './lib/demo';

// The admin of the demo stack (QABOARD_ADMINS in docs-media/compose.demo.yml)
export const ADMIN = 'adaeze';

async function json(response: APIResponse, what: string) {
  if (!response.ok()) throw new Error(`[shots] could not ${what}: ${response.status()} ${await response.text()}`);
  return response.json();
}

/** An API client signed in as the persona */
export async function apiAs(d: Demo, user: string): Promise<APIRequestContext> {
  const api = await playwrightRequest.newContext({ baseURL: d.baseUrl });
  await json(await api.post('/api/v1/user/auth/', { form: { username: user, password: DEMO_PASSWORD } }), `sign in as ${user}`);
  return api;
}

export async function userId(api: APIRequestContext, user: string): Promise<number> {
  const { users } = await json(await api.get('/api/v1/directory', { params: { q: user } }), `find ${user}`);
  const found = (users as Array<{ id: number; user_name: string }>).find(u => u.user_name === user);
  if (!found) throw new Error(`[shots] no user ${user} in the demo stack`);
  return found.id;
}

interface Grant { id: number; role: string; inherited: boolean; subject: { type: string; id: number; name: string } }
interface AccessRequest { id: number; role: string; user: { user_name: string } | null }

/** The project's Access page, as the API gives it to the caller (grants and requests: for owners and admins) */
export async function projectAccess(api: APIRequestContext, project: string): Promise<{ grants?: Grant[]; requests?: AccessRequest[] }> {
  return json(await api.get('/api/v1/project/access', { params: { project } }), `read the access of ${project}`);
}

/** Makes the users members of the project, with these roles, granted now: existing grants are removed first */
export async function setMembers(admin: APIRequestContext, project: string, members: Record<string, 'viewer' | 'developer' | 'owner'>) {
  await removeMembers(admin, project, Object.keys(members));
  for (const [user, role] of Object.entries(members)) {
    const subject = { type: 'user', id: await userId(admin, user) };
    await json(await admin.post('/api/v1/project/access/grants', { data: { project, subject, role } }), `make ${user} ${role} of ${project}`);
  }
}

/** Removes the users' own grants on the project (admins can remove the last owner) */
export async function removeMembers(admin: APIRequestContext, project: string, users: string[]) {
  const { grants = [] } = await projectAccess(admin, project);
  for (const grant of grants)
    if (!grant.inherited && grant.subject.type === 'user' && users.includes(grant.subject.name))
      await json(await admin.delete(`/api/v1/project/access/grants/${grant.id}`), `remove ${grant.subject.name} from ${project}`);
}

/** Denies the pending access requests of these users (there's no way to delete them) */
export async function denyRequests(manager: APIRequestContext, project: string, users: string[]) {
  const { requests = [] } = await projectAccess(manager, project);
  for (const request of requests)
    if (request.user && users.includes(request.user.user_name))
      await json(await manager.post(`/api/v1/project/access/requests/${request.id}`, { data: { decision: 'deny' } }), `deny ${request.user.user_name}'s request`);
}

/** The persona asks for a role on the project, now */
export async function requestAccess(d: Demo, user: string, project: string, role: string, message: string) {
  const api = await apiAs(d, user);
  try {
    await json(await api.post('/api/v1/project/access/requests', { data: { project, role, message } }), `ask for access to ${project} as ${user}`);
  } finally {
    await api.dispose();
  }
}

/** Waits until the jobs worker has computed the storage usage: it does when the backend first starts on a database */
export async function storageUsageReady(admin: APIRequestContext, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const overview = await json(await admin.get('/api/v1/storage/overview', { params: { scope: 'all' } }), 'read the storage usage');
    if (overview.totals?.bytes > 0) return;
    if (Date.now() > deadline) throw new Error('[shots] the storage usage is still empty: did the backend\'s jobs worker start? (Admin → Storage)');
    await new Promise(resolve => setTimeout(resolve, 2_000));
  }
}
