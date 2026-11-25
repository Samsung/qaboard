// Changing the demo stack's state for a shot through its API, as a persona, and undoing it afterwards: who owns a
// project, access requests. The snapshot has none of them (docs-media/README.md#the-demo-stack-and-its-data), and CI
// restores it before capturing: what a capture leaves (denied requests, audit events) doesn't last.
import { request as playwrightRequest, type APIRequestContext, type APIResponse } from '@playwright/test';
import { signIn, type Demo } from './lib/demo';

// The admin of the demo stack (QABOARD_ADMINS in docs-media/compose.demo.yml)
export const ADMIN = 'adaeze';

async function json(response: APIResponse, what: string) {
  if (!response.ok()) throw new Error(`[shots] could not ${what}: ${response.status()} ${await response.text()}`);
  return response.json();
}

/** An API client signed in as the persona */
export async function apiAs(d: Demo, user: string): Promise<APIRequestContext> {
  const api = await playwrightRequest.newContext({ baseURL: d.baseUrl });
  await signIn(api, d.baseUrl, user);
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

/** Sets the project rules of the quality gate (Admin → Quality gate), or removes them with null */
export async function setProjectGate(manager: APIRequestContext, project: string, gate: Record<string, unknown> | null) {
  await json(await manager.post('/api/v1/project/settings/gate', { data: { project, gate } }), `set the gate rules of ${project}`);
}

/**
 * Rebuilds the storage usage of every batch (the "storage_usage" job, Admin → Jobs) and waits until it's done.
 * The jobs worker only computes it in full when it first starts on a database, and that's on the empty database seed.py
 * starts from: then it only updates the commits that got runs in the last hour (backend/jobs/worker.py), and seeded
 * runs are dated in the past. The snapshot keeps that partial usage, and the same job row, so a restore doesn't
 * rebuild it either.
 */
export async function storageUsageReady(admin: APIRequestContext, timeoutMs = 300_000) {
  const deadline = Date.now() + timeoutMs;
  const created = await admin.post('/api/v1/admin/jobs', { data: { kind: 'storage_usage', params: {} } });
  // 409: a rebuild is already queued or running, we wait for it
  if (!created.ok() && created.status() !== 409)
    throw new Error(`[shots] could not rebuild the storage usage: ${created.status()} ${await created.text()}`);
  const body = await created.json();
  const id: number = (created.status() === 409 ? body.job : body).id;
  for (;;) {
    const job = await json(await admin.get(`/api/v1/admin/jobs/${id}`), 'read the storage usage job');
    if (job.status === 'done') break;
    if (!['queued', 'running'].includes(job.status))
      throw new Error(`[shots] the storage usage job ${id} ended ${job.status}: ${job.error ?? ''}`);
    if (Date.now() > deadline) throw new Error(`[shots] the storage usage job ${id} is still ${job.status}: did the backend's jobs worker start? (Admin → Jobs)`);
    await new Promise(resolve => setTimeout(resolve, 2_000));
  }
  const overview = await json(await admin.get('/api/v1/storage/overview', { params: { scope: 'all' } }), 'read the storage usage');
  if (!(overview.totals?.bytes > 0)) throw new Error('[shots] the storage usage is empty after a rebuild');
}

interface ProjectServiceAccount { id: number; user_name: string; status?: string; ci_trust?: Array<{ id: string }> }

/**
 * The project's service account `name` (e.g. `ci`), with this role, created by the caller (an owner of the project).
 * Deleted accounts can't be created again, only disabled (backend/service_accounts.py): one a previous capture deleted
 * is enabled again by the admin, with its role and without the CI jobs it trusted.
 */
export async function projectServiceAccount(d: Demo, owner: APIRequestContext, project: string, name: string, role: 'viewer' | 'developer' | 'owner', description = ''): Promise<ProjectServiceAccount> {
  const user_name = `${project}/${name}[bot]`;
  const admin = await apiAs(d, ADMIN);
  let account: ProjectServiceAccount | undefined;
  try {
    const { users } = await json(await admin.get('/api/v1/admin/users', { params: { search: user_name, limit: 10, offset: 0 } }), `find ${user_name}`);
    const found = (users as ProjectServiceAccount[]).find(u => u.user_name === user_name);
    if (found?.status === 'disabled')
      await json(await admin.post(`/api/v1/admin/users/${found.id}`, { data: { status: 'active' } }), `enable ${user_name} again`);
    if (found) account = found;
  } finally {
    await admin.dispose();
  }
  if (!account)
    return json(await owner.post('/api/v1/service-accounts', { data: { project, name, role, description } }), `create ${user_name}`);
  await json(await owner.post(`/api/v1/service-accounts/${account.id}`, { data: { role } }), `make ${user_name} ${role}`);
  const current: ProjectServiceAccount = await json(await owner.get(`/api/v1/service-accounts/${account.id}`), `read ${user_name}`);
  for (const policy of current.ci_trust ?? [])
    await json(await owner.delete(`/api/v1/service-accounts/${account.id}/ci-trust/${policy.id}`), `stop trusting CI jobs as ${user_name}`);
  return current;
}

/** Deletes the service account (it's disabled: its tokens and roles are removed), after removing the CI jobs it trusts */
export async function deleteProjectServiceAccount(owner: APIRequestContext, account: ProjectServiceAccount) {
  const current: ProjectServiceAccount = await json(await owner.get(`/api/v1/service-accounts/${account.id}`), `read ${account.user_name}`);
  for (const policy of current.ci_trust ?? [])
    await json(await owner.delete(`/api/v1/service-accounts/${account.id}/ci-trust/${policy.id}`), `stop trusting CI jobs as ${account.user_name}`);
  await json(await owner.delete(`/api/v1/service-accounts/${account.id}`), `delete ${account.user_name}`);
}

/** The service account trusts these CI jobs (Trust CI jobs, backend/ci_trust.py), e.g. {provider: 'github', repository: 'kitefin/detector', ref: 'main'} */
export async function trustCiJobs(owner: APIRequestContext, account: ProjectServiceAccount, policy: Record<string, string>) {
  await json(await owner.post(`/api/v1/service-accounts/${account.id}/ci-trust`, { data: policy }), `trust CI jobs as ${account.user_name}`);
}

/** Starts a `qa auth login` from this computer (OAuth device flow), as the CLI does: its code, e.g. WDJB-MJHT */
export async function startCliSignIn(d: Demo, hostname: string): Promise<string> {
  const api = await playwrightRequest.newContext({ baseURL: d.baseUrl });
  try {
    const { user_code } = await json(await api.post('/api/v1/auth/device/code', { data: { client_name: `qa CLI on ${hostname}`, hostname } }), 'start a qa auth login');
    return user_code;
  } finally {
    await api.dispose();
  }
}

/** Approves or denies a `qa auth login`, as the signed-in user (a pending one: else it's already answered or expired) */
export async function answerCliSignIn(user: APIRequestContext, code: string, approve: boolean) {
  const response = await user.post('/api/v1/auth/device', { data: { code, approve } });
  if (!response.ok() && response.status() !== 409) await json(response, `answer the sign-in ${code}`);
}

/** An OpenID Connect provider of Admin → Sign-in (api/admin_sign_in.py), saved now: an existing one is replaced */
export async function setSignInProvider(admin: APIRequestContext, provider: Record<string, unknown> & { id: string }) {
  await deleteSignInProvider(admin, provider.id);
  return json(await admin.post('/api/v1/admin/sign-in/providers', { data: provider }), `add the sign-in provider ${provider.id}`);
}

export async function deleteSignInProvider(admin: APIRequestContext, id: string) {
  const response = await admin.delete(`/api/v1/admin/sign-in/providers/${encodeURIComponent(id)}`);
  if (response.status() !== 404) await json(response, `delete the sign-in provider ${id}`);
}

export interface DemoGroup {
  name: string;
  description: string;
  members: string[];
  rules: Array<{ provider_id: string | null; claim: string; values: string[] }>;
}

/** Creates the groups of Admin → Groups, with their members and rules: groups with these names are replaced */
export async function setGroups(admin: APIRequestContext, groups: DemoGroup[]) {
  await deleteGroups(admin, groups.map(group => group.name));
  for (const { name, description, members, rules } of groups) {
    const group = await json(await admin.post('/api/v1/admin/groups', { data: { name, description } }), `create the group ${name}`);
    const id = group.group?.id ?? group.id;
    for (const user of members)
      await json(await admin.post(`/api/v1/admin/groups/${id}/members`, { data: { user_id: await userId(admin, user) } }), `add ${user} to ${name}`);
    for (const rule of rules)
      await json(await admin.post(`/api/v1/admin/groups/${id}/rules`, { data: rule }), `add a rule to ${name}`);
  }
}

export async function deleteGroups(admin: APIRequestContext, names: string[]) {
  const { groups } = await json(await admin.get('/api/v1/admin/groups'), 'list the groups');
  for (const group of groups as Array<{ id: number; name: string }>)
    if (names.includes(group.name))
      await json(await admin.delete(`/api/v1/admin/groups/${group.id}`), `delete the group ${group.name}`);
}

interface ServiceAccount { id: number; user_name: string; ci_trust?: unknown[] }

/**
 * An instance service account (Admin → Service accounts), with its role on all projects and the CI jobs it trusts.
 * Deleting one keeps its name taken (backend/service_accounts.py): a deleted one is enabled again.
 */
export async function setServiceAccount(admin: APIRequestContext, account: {
  name: string; description: string; role: string | null; ci_trust: Array<Record<string, unknown>>;
}): Promise<ServiceAccount> {
  const user_name = `${account.name}[bot]`;
  let created: ServiceAccount;
  const response = await admin.post('/api/v1/service-accounts', { data: { name: account.name, description: account.description, role: account.role } });
  if (response.status() === 409) {
    const { users } = await json(await admin.get('/api/v1/admin/users', { params: { search: user_name, limit: 50 } }), `find ${user_name}`);
    const user = (users as Array<{ id: number; user_name: string }>).find(u => u.user_name === user_name);
    if (!user) throw new Error(`[shots] ${user_name} is taken, but not by a user the admin sees`);
    await json(await admin.post(`/api/v1/admin/users/${user.id}`, { data: { status: 'active' } }), `enable ${user_name} again`);
    created = await json(await admin.post(`/api/v1/service-accounts/${user.id}`, { data: { role: account.role } }), `set the role of ${user_name}`);
  } else {
    created = await json(response, `create ${user_name}`);
  }
  for (const policy of account.ci_trust) {
    const trust = await admin.post(`/api/v1/service-accounts/${created.id}/ci-trust`, { data: policy });
    // it trusts these jobs already (an account enabled again)
    if (trust.status() !== 409) created = await json(trust, `make ${user_name} trust CI jobs`);
  }
  return created;
}

/** Deletes the instance service account (its name stays taken) */
export async function deleteServiceAccount(admin: APIRequestContext, name: string) {
  const { service_accounts } = await json(await admin.get('/api/v1/service-accounts'), 'list the service accounts');
  for (const account of service_accounts as ServiceAccount[])
    if (account.user_name === `${name}[bot]`)
      await json(await admin.delete(`/api/v1/service-accounts/${account.id}`), `delete ${account.user_name}`);
}
