// Hooks that components use to read the app's state: server data from TanStack Query,
// the selection from the URL, preferences from the zustand store.
import { createContext, createElement, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  siteConfigQuery, default_site_config, userQuery, logged_out_user,
  projectsQuery, projectQuery, branchesQuery, commitsQuery, commitsPagesQuery, commits_of, commits_page_size, commitQuery,
  findCachedCommit, invalidateCommit,
} from "./api/queries";
import { errorMessage } from "./api/http";
import { usePrefsStore, usePrivateMilestones } from "./stores/prefs";
import { useSelected, updateSelected } from "./selection";
import { available_batch, compute_batches, compute_config } from "./selectors/batches";
import { default_project } from "./defaults";

export { useSelected, updateSelected };


// With defaults for what the server doesn't say, or while it doesn't answer
export const useSiteConfig = () => {
  const { data } = useQuery(siteConfigQuery);
  return useMemo(() => ({ ...default_site_config, ...data }), [data]);
};

export const useUser = () => useQuery(userQuery).data ?? logged_out_user;

export const useProjects = () => useQuery(projectsQuery);

// The project's most recently active branches matching `search`
export const useBranches = (project, search, { enabled = true } = {}) => useQuery({ ...branchesQuery(project, search), enabled: !!project && enabled });


// A project's metadata and configuration, with the user's preferences
export function useProjectData(project) {
  const { data: from_list } = useQuery({ ...projectsQuery, select: projects => projects?.[project] });
  const { data: from_project } = useQuery(projectQuery(project));
  const is_favorite = usePrefsStore(state => !!state.favorites[project]);
  const milestones = usePrivateMilestones(project);
  return useMemo(() => {
    // The list of projects has their dates and number of commits, and only qaboard.yaml's `project` from their
    // configuration; /api/v1/project has their whole configuration and metrics.
    return {
      ...default_project,
      ...from_list,
      ...from_project,
      data: { ...default_project.data, ...from_list?.data, ...from_project?.data },
      is_favorite,
      milestones,
    };
  }, [from_list, from_project, is_favorite, milestones]);
}


// e.g. "404 Sorry, we could not find..."
const commit_error = error => {
  if (!error) return undefined;
  const { status, data } = error.response ?? {};
  return data?.error ? `${status} ${data.error}` : errorMessage(error);
};


// A commit and its batches. Without an id: the latest commit on the branch (by default the project's reference branch).
// While it loads, we show what we know about it from lists of commits.
// When disabled, we show the commit from the list we're given: it's fresher than what we may have cached.
// Returns undefined when there is nothing to show, null when id is '' (meaning: nothing selected).
export function useCommit({ project, id, branch, enabled = true, placeholder }) {
  const queryClient = useQueryClient();
  const query = useQuery({
    ...commitQuery({ project, id, branch }),
    enabled: enabled && !!project && id !== '',
    placeholderData: () => placeholder ?? findCachedCommit(queryClient, project, id),
  });
  const { data, isPlaceholderData, error, isFetched } = query;
  const is_loaded = isFetched && !isPlaceholderData;
  const error_str = commit_error(error);
  return useMemo(() => {
    if (id === '') return null;
    if (!enabled) return placeholder && { ...placeholder, is_loaded: false };
    if (data) return { ...data, is_loaded, error: error_str };
    if (error_str) return { id, batches: {}, is_loaded, error: error_str };
    if (project) return { id, batches: {}, is_loaded: false };
    return undefined;
  }, [id, data, is_loaded, error_str, enabled, project, placeholder]);
}

// To refresh a commit after acting on it: refresh(project, id)
export function useRefreshCommit() {
  const queryClient = useQueryClient();
  return (project, id) => invalidateCommit(queryClient, project, id);
}


// The metrics the commits endpoint aggregates per batch (median, average), with their targets:
// History's (dashboard_metrics), else the default and main metrics, which the commit list and the branch's chart show.
// Metrics without a target need one: JSON leaves out undefined values, and the server would not aggregate them.
export const aggregation_metrics = (qatools_metrics, { dashboard = false } = {}) => {
  const { available_metrics = {}, default_metric, main_metrics = [], dashboard_metrics } = qatools_metrics ?? {};
  const keys = dashboard ? (dashboard_metrics ?? main_metrics) : [default_metric, ...main_metrics];
  return Object.fromEntries(keys
    .filter(m => available_metrics[m] !== undefined)
    .map(m => [m, available_metrics[m].target ?? 0]));
};

const has_batches = c => Object.keys(c.batches ?? {}).length > 0;

// Pages can overlap when new commits arrive between their requests
const unique_commits = commits => {
  const seen = new Set();
  return commits.filter(c => !seen.has(c.id) && seen.add(c.id));
};

// The commits shown on the current page: the project's latest, a branch's or a committer's,
// in the date range from the URL. On the History page they come with all their outputs.
// On lists of commits they come in pages (fetchNextPage, hasNextPage...), and the `search` from the URL
// searches all the commits on the server. `ignore_search` gives the list without the search,
// e.g. for the commits selected by default.
function useCommitsListState(selected, project_data, { enabled, refetchInterval, ignore_search = false }) {
  const { project, branch, committer, date_range, route, selected_batch_new } = selected;
  const paginated = !route.is_history;
  const search = paginated && !ignore_search ? selected.search.trim() : '';
  const dashboard = route.is_history;
  // On branches, metrics can differ from the project's: once we know the latest commit, we ask once more with its metrics.
  const [branch_metrics, setBranchMetrics] = useState({ key: null, qatools_metrics: undefined });
  const list_key = `${project}|${branch}`;
  const known_branch_metrics = branch && branch_metrics.key === list_key ? branch_metrics.qatools_metrics : undefined;
  const project_metrics = project_data.data?.qatools_metrics;
  // History picks its metrics and loads every run: asking again with the latest commit's would load them twice
  const requested_metrics = (!dashboard && known_branch_metrics) || project_metrics;
  const metrics = useMemo(
    () => aggregation_metrics(requested_metrics, { dashboard }),
    [requested_metrics, dashboard],
  );
  const params = {
    project,
    branch: branch ?? undefined,
    committer: committer ?? undefined,
    // searches look at all the commits
    from: search ? undefined : date_range[0].toISOString(),
    to: search ? undefined : date_range[1].toISOString(),
    metrics,
    ...(dashboard ? { with_outputs: true, only_ci_batches: selected_batch_new === 'default' } : {}),
  };
  // We wait for the project's metrics (only /api/v1/project has them): the list depends on them, it's heavy to fetch twice
  const { isFetched: project_fetched } = useQuery(projectQuery(project));
  const can_fetch = enabled && !!project && project_fetched;
  const all_query = useQuery({ ...commitsQuery(params), enabled: can_fetch && !paginated, refetchInterval });
  // Branch pages show their metrics over time: we get the whole date range at once
  const page_size = branch && !search ? 1000 : commits_page_size;
  // Infinite queries refetch all their pages one after the other: we only refresh lists users didn't scroll through
  const pages_refetch_interval = refetchInterval && (query => (query.state.data?.pages?.length ?? 0) > 1 ? false : refetchInterval);
  const pages_query = useInfiniteQuery({ ...commitsPagesQuery({ ...params, q: search || undefined, page_size }), enabled: can_fetch && paginated, refetchInterval: pages_refetch_interval });
  const query = paginated ? pages_query : all_query;

  const default_branch = project_data.data?.git?.default_branch ?? project_data.data?.qatools_config?.project?.reference_branch;
  const { data: query_data, isPlaceholderData } = query;
  const data = useMemo(() => paginated ? unique_commits(commits_of(query_data)) : query_data, [paginated, query_data]);
  const latest_metrics = branch && !search && !isPlaceholderData ? data?.[0]?.data?.qatools_metrics : undefined;
  // once per branch, even if its latest commit's metrics keep changing
  if (latest_metrics && branch_metrics.key !== list_key)
    setBranchMetrics({ key: list_key, qatools_metrics: latest_metrics });
  const qatools_metrics = latest_metrics ?? known_branch_metrics ?? project_metrics;
  // Thanks to TanStack Query's structural sharing, refetches that bring nothing new keep the same arrays
  const derived = useMemo(() => {
    const all = data ?? [];
    // Hide commits without results, except recent ones: their CI may still be running
    const commits = all.some(has_batches) ? all.filter(c => c.is_recent || has_batches(c)) : all;
    const latest_commit = branch ? all[0] : all.find(c => c.branch === default_branch);
    return { commits, ids: all.map(c => c.id), latest_commit };
  }, [data, branch, default_branch]);

  // The project's latest commit on its default branch may not be in the pages we loaded:
  // other branches can have many more recent commits. We then ask for it.
  const wants_latest = enabled && !!project && paginated && !branch && !committer && !!default_branch && query.isSuccess && !derived.latest_commit;
  const { data: latest_on_default } = useQuery({
    ...commitsQuery({ project, branch: default_branch, from: params.from, to: params.to, metrics, limit: 1 }),
    enabled: wants_latest,
    refetchInterval,
  });
  const latest_commit = derived.latest_commit ?? (wants_latest ? latest_on_default?.[0] : undefined);

  return { ...query, data, ...derived, latest_commit, date_range, project, search, paginated, qatools_metrics };
}


// Commits are often selected by a short id, as "the latest on a branch", or a branch or tag name.
// Once we know their full id, we put it in the URL, so that the page can be shared.
function useCommitIdsInUrl(selected, new_commit, ref_commit) {
  const queryClient = useQueryClient();
  const { new_project, ref_project, new_commit_id, ref_commit_id } = selected;
  const sync = (commit, commit_project, selected_id, attribute) => {
    if (!commit?.is_loaded || commit.error || !commit.id) return;
    if (selected_id === '' || selected_id === commit.id) return;
    // the page will ask for the full id: it's in the cache already
    const key = commitQuery({ project: commit_project, id: selected_id ?? undefined }).queryKey;
    queryClient.setQueryData(commitQuery({ project: commit_project, id: commit.id }).queryKey, queryClient.getQueryData(key));
    updateSelected({ [attribute]: commit.id }, { replace: true });
  };
  useEffect(() => sync(new_commit, new_project, new_commit_id, 'new_commit_id'));
  useEffect(() => sync(ref_commit, ref_project, ref_commit_id, 'ref_commit_id'));
}


// What the project pages show, computed once for the sidebar, the navbar and the page:
// the commits listed, the new and reference commits we compare, their batches, configuration and metrics.
function useComparisonState() {
  const selected = useSelected();
  const { project, new_project, route } = selected;
  const project_data = useProjectData(project);
  const new_project_data = useProjectData(new_project);

  // On the commit page, the commits are fetched with all their outputs, elsewhere they come from the list of commits
  const on_commit_page = route.is_commit;
  const list_options = {
    enabled: !on_commit_page,
    // new commits appear on lists of commits
    refetchInterval: route.is_list ? 60 * 1000 : undefined,
  };
  const searched_list = useCommitsListState(selected, project_data, list_options);
  // Searching doesn't change the commits compared by default, nor the project's latest commit.
  // Without a search, both are the same queries: this one only observes them.
  const unsearched_list = useCommitsListState(selected, project_data, { ...list_options, enabled: list_options.enabled && !!searched_list.search, ignore_search: true });
  const default_list = searched_list.search ? unsearched_list : searched_list;
  const pick = (id, index) => {
    if (id === '') return '';
    if (on_commit_page) return id ?? undefined;
    return id ?? default_list.ids[index];
  };
  const new_id = pick(selected.new_commit_id, 0);
  const ref_id = pick(selected.ref_commit_id, 1);
  const from_list = id => on_commit_page ? undefined : (default_list.data?.find(c => c.id === id) ?? searched_list.data?.find(c => c.id === id));
  const new_commit = useCommit({ project: new_project, id: new_id, enabled: on_commit_page, placeholder: from_list(new_id) });
  const ref_commit = useCommit({ project: selected.ref_project, id: ref_id, enabled: on_commit_page, placeholder: from_list(ref_id) });
  useCommitIdsInUrl(selected, new_commit, ref_commit);

  // The configuration comes from the batch shown (not filtered), else its commit, else the project:
  // it changes only with the data, not when users filter or sort outputs
  const { selected_batch_new, selected_batch_ref, filter_batch_new, filter_batch_ref, sort_by, sort_order, selected_metrics } = selected;
  const raw_new_batch = new_commit?.batches?.[available_batch(new_commit, selected_batch_new)];
  const config = useMemo(
    () => compute_config({ new_batch: raw_new_batch, new_commit, project_data: new_project_data, selected: { selected_metrics } }),
    [raw_new_batch, new_commit, new_project_data, selected_metrics],
  );
  const default_metric = config.metrics.default_metric;
  const batches = useMemo(() => compute_batches({
    new_commit: new_commit || undefined,
    ref_commit: ref_commit || undefined,
    selected: { selected_batch_new, selected_batch_ref, filter_batch_new, filter_batch_ref, sort_by, sort_order },
    metrics: { default_metric },
  }), [new_commit, ref_commit, selected_batch_new, selected_batch_ref, filter_batch_new, filter_batch_ref, sort_by, sort_order, default_metric]);

  const default_tab = config.config.outputs?.default_tab_details ?? project_data.data?.qatools_config?.outputs?.default_tab_details ?? 'summary';
  const default_views = useMemo(() => [].concat(default_tab).map(v => v.replace('_', '-')), [default_tab]);
  const selected_views = useMemo(
    () => selected.selected_views ?? default_views,
    [selected.selected_views, default_views],
  );

  return useMemo(
    () => ({ selected, project, project_data, list: searched_list, unsearched_list: default_list, new_commit, ref_commit, ...batches, ...config, selected_views, default_views }),
    [selected, project, project_data, searched_list, default_list, new_commit, ref_commit, batches, config, selected_views, default_views],
  );
}

const ComparisonContext = createContext(null);

export const ComparisonProvider = ({ children }) =>
  createElement(ComparisonContext.Provider, { value: useComparisonState() }, children);

// Everything about the comparison of the new and reference commits: commits, batches, configuration and metrics
export const useComparison = () => useContext(ComparisonContext);

// The commits listed on the current page. With `ignore_search`, the list without the search from the URL
export const useCommitsList = ({ ignore_search = false } = {}) => {
  const comparison = useContext(ComparisonContext);
  return ignore_search ? comparison.unsearched_list : comparison.list;
};


// For text inputs that edit the URL, e.g. filters: [text, onChange].
// Navigation happens in a React transition: an input bound to the URL directly would lose keystrokes.
// Instead, we keep what users type, and update the URL when they pause.
export function useUrlText(url_value = '', commit, delay = 200) {
  const [text, setText] = useState(url_value);
  // the last value from the URL we know about, to catch changes made elsewhere (back button, links...)
  const [known, setKnown] = useState(url_value);
  // what we wrote in the URL, until it gets there
  const [pending, setPending] = useState(null);
  if (url_value !== known) {
    setKnown(url_value);
    // While our own updates are on their way, users' text wins
    if (pending === null) setText(url_value);
    else if (url_value === pending) setPending(null);
  }
  const timer = useRef(null);
  useEffect(() => () => clearTimeout(timer.current), []);
  const onChange = event => {
    const value = event?.target ? event.target.value : event;
    setText(value);
    clearTimeout(timer.current);
    // if users go to another page in the meantime, the text was meant for this one
    const pathname = window.location.pathname;
    timer.current = setTimeout(() => {
      if (window.location.pathname !== pathname) return;
      // when the URL already has it, nothing will change
      setPending(value === known ? null : value);
      commit(value);
    }, delay);
  };
  return [text, onChange];
}
