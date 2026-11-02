// Server state: what we fetch from the API, cached and kept fresh by TanStack Query.
// https://tanstack.com/query/latest/docs/framework/react/guides/query-options
//
// Query keys start with the resource, then the project, so that we can invalidate e.g. all the
// commit lists of a project with queryClient.invalidateQueries({ queryKey: ['commits', project] })
import { queryOptions, infiniteQueryOptions } from "@tanstack/react-query";

import { http, errorMessage, errorReason } from "./http";
import { normalize_projects, normalize_project, normalize_commit } from "./normalize";
import { setPathMappings, setDefaultGitHostname } from "../utils";


export const default_site_config = {
  image_servers: { default: '/iiif/2/' },
  login_type: 'LOCAL',
  login_required: false,
  sandbox_html: false,
  sentry_dsn: null,
  posthog_api_key: null,
  posthog_host: null,
  path_mappings: [],
  docs_root: '/',
  avatar_url_template: null,
  sentry_traces_sample_rate: 0.2,
  sentry_environment: 'production',
  sentry_trace_lifecycle: 'static',
  git_web_url: 'https://gitlab.com',
  git_hosts: [],
  support_url: 'https://github.com/Samsung/qaboard/issues',
  login_hint: null,
  webcde_installer: null,
  // whether users can ask for an email when the batches they start end
  email_notifications: false,
  // whether runs sent without a token are accepted: "off", "warn" (accepted, marked unverified) or "token"
  ingest_auth: 'off',
  // the lifetime of the tokens users create (null: no maximum, tokens without an expiry date are allowed)
  tokens: { default_lifetime_days: 90, max_lifetime_days: null },
};

// Some helpers read the site's configuration outside of React
export const applySiteConfig = config => {
  setPathMappings(config?.path_mappings ?? default_site_config.path_mappings);
  setDefaultGitHostname(config?.git_web_url ?? default_site_config.git_web_url);
};

export const siteConfigQuery = queryOptions({
  queryKey: ['config'],
  // When it fails (e.g. during a deploy), useSiteConfig() gives defaults, and we retry
  queryFn: async ({ signal }) => {
    const { data } = await http.get('/api/v1/config', { signal });
    applySiteConfig(data);
    return data;
  },
  staleTime: 5 * 60 * 1000,
});


export const logged_out_user = {
  is_logged: false,
  user_id: null,
  user_name: null,
  full_name: null,
  email: null,
  is_admin: false,
};

// Who we are. With a disabled or pending account we are signed out, and say why with `reason` ("user_disabled",
// "user_pending") and `error` (the server's sentence). Servers answer it once, with 200 {is_authenticated: false, reason,
// error} (older ones: 401), then close the session: the next answers are plain anonymous, so we keep the reason until
// users sign in again. Pending users keep their session: `pending` is what their page shows
// ({user_name, full_name, email, request: {message, status, created_at...} or null, reviewers: [names]}).
const account_reasons = ['user_disabled', 'user_pending'];
const signedOut = (previous, reason, error, pending = null) => {
  if (account_reasons.includes(reason)) return { ...logged_out_user, reason, error: error || null, ...(pending ? { pending } : {}) };
  if ((!reason || reason === 'sign_in_required') && !previous?.is_logged && account_reasons.includes(previous?.reason)) return previous;
  return logged_out_user;
};

export const userQuery = queryOptions({
  queryKey: ['me'],
  queryFn: async ({ signal, client }) => {
    const previous = client?.getQueryData(['me']);
    let data;
    try {
      data = (await http.get('/api/v1/user/me/', { signal })).data;
    } catch (error) {
      if (error?.response?.status !== 401) throw error;
      const reason = errorReason(error);
      return signedOut(previous, reason, reason ? errorMessage(error) : null);
    }
    const { is_authenticated, user_id, user_name, full_name, email, login_type, is_admin, status, kind, token } = data ?? {};
    if (!is_authenticated) return signedOut(previous, data?.reason ?? null, typeof data?.error === 'string' ? data.error : null, data?.pending ?? null);
    return { is_logged: true, user_id, user_name, full_name, email, login_type, is_admin: !!is_admin, status: status ?? 'active', kind: kind ?? 'human', token: token ?? null };
  },
  staleTime: 5 * 60 * 1000,
});


// All the projects, with only what lists need from their data (git info, qaboard.yaml's project section):
// sites have hundreds of projects. The rest comes with projectQuery.
export const projectsQuery = queryOptions({
  queryKey: ['projects'],
  queryFn: async ({ signal }) => normalize_projects((await http.get('/api/v1/projects', { params: { summary: true }, signal })).data),
  staleTime: 60 * 1000,
});

export const projectQuery = project => queryOptions({
  queryKey: ['project', project],
  // the API answers with the project's data, /api/v1/projects with {[id]: {data, ...}}
  queryFn: async ({ signal }) => normalize_project({ id: project, data: (await http.get('/api/v1/project', { params: { project }, signal })).data }),
  enabled: !!project,
  staleTime: 60 * 1000,
});

// The most recently active branches whose name contains `search`
export const branches_limit = 50;
export const branchesQuery = (project, search = '') => queryOptions({
  queryKey: ['branches', project, search],
  queryFn: async ({ signal }) => {
    const { data } = await http.get('/api/v1/project/branches', { params: { project, q: search, limit: branches_limit }, signal });
    return [...new Set(data.map(branch => branch.replace('origin/', '')))];
  },
  enabled: !!project,
  // while users type, keep showing the previous matches (of the same project)
  placeholderData: (previous, previous_query) => previous_query?.queryKey[1] === project ? previous : undefined,
  staleTime: 5 * 60 * 1000,
});


// commits pushed in the last seconds are shown even without results: their CI may still be running
const normalize_commits = data => {
  const now = Date.now();
  return data.map(commit => ({ ...normalize_commit(commit), is_recent: now - new Date(commit.authored_datetime) < 15 * 1000 }));
};

// The commits of a project, a branch or a committer, in a date range.
// `metrics` are aggregated over each commit's batches by the server.
export const commitsQuery = ({ project, branch, committer, from, to, metrics, ...extra_params }) => queryOptions({
  queryKey: ['commits', project, { branch, committer, from, to, metrics, ...extra_params }],
  queryFn: async ({ signal }) => {
    const url = committer ? '/api/v1/commits/' : `/api/v1/commits/${branch ?? ''}`;
    const { data } = await http.get(url, {
      params: { project, committer, from, to, metrics: JSON.stringify(metrics ?? {}), ...extra_params },
      signal,
    });
    return normalize_commits(data);
  },
  enabled: !!project,
  // when the date range or branch changes, keep showing the previous list until the new one is there.
  // Not when the project changes: we'd show another project's commits.
  placeholderData: (previous, previous_query) => previous_query?.queryKey[1] === project ? previous : undefined,
  staleTime: 30 * 1000,
  // with all their outputs, lists can take tens of MB
  gcTime: extra_params.with_outputs ? 60 * 1000 : undefined,
});


// The same, one page at a time, newest first. With `q`, the server searches the whole history
// (unless from/to are given), e.g. "fix -wip branch:dev committer:alice" (see backend/backend/search.py).
// Pages are {commits, has_more}.
export const commits_page_size = 50;
const commits_url = ({ branch, committer }) => committer ? '/api/v1/commits/' : `/api/v1/commits/${branch ?? ''}`;
// `scope`: "mine" for the commits users wrote or have batches in, `origin`: e.g. "webapp,local" to leave out the CI's
// `viewer`: whose lists of "mine" they are, only for the cache.
export const commitsPagesQuery = ({ project, branch, committer, from, to, metrics, q, scope, origin, viewer, page_size = commits_page_size }) => infiniteQueryOptions({
  queryKey: ['commits', project, { branch, committer, from, to, metrics, q, scope, origin, viewer, page_size, pages: true }],
  queryFn: async ({ signal, pageParam }) => {
    const { data, headers } = await http.get(commits_url({ branch, committer }), {
      params: { project, committer, from, to, q, scope, origin, metrics: JSON.stringify(metrics ?? {}), limit: page_size, offset: pageParam },
      signal,
    });
    // servers that predate pagination answer with everything at once, without the header
    return { commits: normalize_commits(data), has_more: headers?.get('X-Has-More') === 'true' };
  },
  initialPageParam: 0,
  getNextPageParam: (last_page, pages, last_offset) => last_page.has_more ? last_offset + last_page.commits.length : undefined,
  enabled: !!project,
  // like commitsQuery: the previous list until the new one is there, unless the project changed
  placeholderData: (previous, previous_query) => previous_query?.queryKey[1] === project ? previous : undefined,
  staleTime: 30 * 1000,
});

// How many commits the lists would show: {all, mine, without_ci}. `mine` is null for anonymous users.
export const commitCountsQuery = ({ project, branch, committer, from, to }) => queryOptions({
  queryKey: ['commits', project, { branch, committer, from, to, counts: true }],
  queryFn: async ({ signal }) => {
    const { data } = await http.get('/api/v1/commit-counts', { params: { project, branch, committer, from, to }, signal });
    return data;
  },
  enabled: !!project,
  placeholderData: (previous, previous_query) => previous_query?.queryKey[1] === project ? previous : undefined,
  staleTime: 30 * 1000,
});

// While runs wait or run, we refresh what shows them every `interval`. Runs can wait for hours (busy queues, stuck
// jobs): when refreshes bring nothing new, we wait as long as nothing has changed, up to 5 minutes.
// Refreshes that bring the same data keep it as is (structural sharing): when we got it is when it last changed.
const changed_at = new WeakMap();
const pendingRefetchInterval = (query, interval = 15 * 1000) => {
  const { data, dataUpdatedAt } = query.state;
  if (!changed_at.has(data)) changed_at.set(data, dataUpdatedAt);
  const unchanged_for = dataUpdatedAt - changed_at.get(data);
  return Math.min(Math.max(interval, unchanged_for), 5 * 60 * 1000);
};

// Batches, the latest first, with their commit: what users ran. Without `project`, the user's in every project (scope "mine").
// Pages are {batches, has_more}. Refreshed while some of their runs wait or run.
export const batches_page_size = 50;
export const batchesPagesQuery = ({ project, branch, scope, origin, metrics, viewer, page_size = batches_page_size }) => infiniteQueryOptions({
  queryKey: ['batches', project ?? null, { branch, scope, origin, metrics, viewer, page_size }],
  queryFn: async ({ signal, pageParam }) => {
    const { data, headers } = await http.get('/api/v1/batches', {
      params: { project, branch, scope, origin, metrics: metrics ? JSON.stringify(metrics) : undefined, limit: page_size, offset: pageParam },
      signal,
    });
    return { batches: data, has_more: headers?.get('X-Has-More') === 'true' };
  },
  initialPageParam: 0,
  getNextPageParam: (last_page, pages, last_offset) => last_page.has_more ? last_offset + last_page.batches.length : undefined,
  placeholderData: (previous, previous_query) => previous_query?.queryKey[1] === (project ?? null) ? previous : undefined,
  staleTime: 15 * 1000,
  refetchInterval: query => (query.state.data?.pages?.length ?? 0) === 1 && query.state.data.pages[0].batches.some(b => b.pending_outputs > 0) ? pendingRefetchInterval(query) : false,
});

// Lists of commits, whether they are paginated or not. Other queries share their key, like the counts: no commits.
export const commits_of = data => data?.pages ? data.pages.flatMap(page => page.commits ?? []) : Array.isArray(data) ? data : [];


// Without an id, the server answers with the latest commit on the branch (by default the project's reference branch)
export const commitQuery = ({ project, id, branch, batch }) => queryOptions({
  queryKey: ['commit', project, id ?? null, { branch, batch }],
  queryFn: async ({ signal }) => {
    const { data } = await http.get(`/api/v1/commit/${id ?? ''}`, { params: { project, branch, batch }, signal });
    return normalize_commit(data);
  },
  enabled: !!project && id !== '',
  staleTime: 10 * 1000,
  // keep up to date while outputs are running. Each refresh downloads all the outputs: 15s per thousand of them at least
  refetchInterval: query => {
    const commit = query.state.data;
    const is_pending = Object.values(commit?.batches ?? {}).some(b => b.pending_outputs > 0);
    return is_pending ? pendingRefetchInterval(query, Math.max(15 * 1000, 15 * nb_outputs(commit))) : false;
  },
});

// A commit without its outputs: its message, branch, and batches with their counts. Commits can have thousands of
// outputs: we use it for the references users stacked but don't look at.
export const commitSummaryQuery = ({ project, id }) => queryOptions({
  queryKey: ['commit-summary', project, id ?? null],
  queryFn: async ({ signal }) => {
    const { data } = await http.get(`/api/v1/commit/${id}`, { params: { project, with_outputs: false }, signal });
    return normalize_commit(data);
  },
  enabled: !!project && !!id,
  staleTime: 60 * 1000,
});

// How many outputs the commit has, in all its batches: what fetching it with its outputs costs
export const nb_outputs = commit => Object.values(commit?.batches ?? {})
  .reduce((n, b) => n + (b.valid_outputs ?? 0) + (b.running_outputs ?? 0) + (b.pending_outputs ?? 0) + (b.failed_outputs ?? 0), 0);

// Where to look for a commit in the cache: its own query, or else any list of commits that includes it
export const findCachedCommit = (queryClient, project, id) => {
  if (!id) return undefined;
  for (const [, data] of queryClient.getQueriesData({ queryKey: ['commits', project] })) {
    const commit = commits_of(data).find(c => c.id === id);
    if (commit) return commit;
  }
  return undefined;
};

// Who users are changes what they can see: we refetch everything
export const setUser = (queryClient, user) => {
  queryClient.setQueryData(userQuery.queryKey, user);
  return queryClient.invalidateQueries({ predicate: query => !['config', 'me'].includes(query.queryKey[0]) });
};

// Files of finished outputs rarely change: only when runs are redone
export const output_files_stale_time = 5 * 60 * 1000;

// A file from outputs or artifacts, cached and shared by all the viewers that show it.
// The raw text with responseType 'text', else JSON when it parses.
export const fileQuery = (url, { is_running = false, responseType } = {}) => queryOptions({
  queryKey: ['file', url, ...(responseType === 'text' ? ['text'] : [])],
  queryFn: ({ signal }) => http.get(url, { signal, responseType }).then(r => r.data),
  enabled: !!url,
  staleTime: is_running ? 0 : output_files_stale_time,
});

export const invalidateOutputFiles = (queryClient, output_dir_url) => queryClient.invalidateQueries({
  predicate: ({ queryKey: [kind, url] }) => ['manifest', 'file'].includes(kind) && typeof url === 'string' && url.startsWith(`${output_dir_url}/`),
});

// After acting on a commit (deleting a batch, a redo...), refresh everything that shows it
export const invalidateCommit = (queryClient, project, id) => Promise.all([
  queryClient.invalidateQueries({ queryKey: ['commit', project, id] }),
  queryClient.invalidateQueries({ queryKey: ['commits', project] }),
]);
