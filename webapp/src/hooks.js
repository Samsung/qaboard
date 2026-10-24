// Hooks that components use to read the app's state: server data from TanStack Query,
// the selection from the URL, preferences from the zustand store.
import { createContext, createElement, useContext, useEffect, useMemo, useRef, useState } from "react";
import { useInfiniteQuery, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { create } from "zustand";

import {
  siteConfigQuery, default_site_config, userQuery, logged_out_user,
  projectsQuery, projectQuery, branchesQuery, commitsQuery, commitsPagesQuery, commits_of, commits_page_size, commitQuery,
  commitSummaryQuery, findCachedCommit, invalidateCommit, batchesPagesQuery,
} from "./api/queries";
import { errorMessage } from "./api/http";
import { usePrefsStore } from "./stores/prefs";
import { useSelected, updateSelected, reference_names, side_colors, is_default_name } from "./selection";
import { available_batch, compute_batches, compute_config } from "./selectors/batches";
import { default_project } from "./defaults";
import { milestonesQuery, milestones_of, milestone_name, no_milestones } from "./milestones/api";
import { side_color } from "./sideColors";
import { with_undeclared_metrics } from "./utils";

// The keys of a Set of metrics, as a string that only changes when they do
export const used_metrics_signature = used_metrics => [...(used_metrics ?? [])].sort().join('\n');

// The project's metrics with all those of the runs (`used_metrics_key`, from used_metrics_signature), declared or not.
// The same object when no metric is missing.
export const with_used_metrics = (metrics, used_metrics_key) => {
  const available_metrics = with_undeclared_metrics(metrics?.available_metrics, used_metrics_key ? used_metrics_key.split('\n') : []);
  return available_metrics === metrics?.available_metrics ? metrics : { ...metrics, available_metrics };
};

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
  return useMemo(() => {
    // The list of projects has their dates and number of commits, and only qaboard.yaml's `project` from their
    // configuration; /api/v1/project has their whole configuration and metrics.
    return {
      ...default_project,
      ...from_list,
      ...from_project,
      data: { ...default_project.data, ...from_list?.data, ...from_project?.data },
      is_favorite,
      // Until then, its configuration is the defaults (e.g. the reference branch)
      is_loaded: !!(from_list || from_project),
    };
  }, [from_list, from_project, is_favorite]);
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
// Hovering a commit, or focusing one of its links, for a moment starts loading its page: the commit with its outputs,
// and the reference it's compared to by default. Returns the props to put on the commit's element.
export function usePrefetchCommitPage(project, commit_id) {
  const queryClient = useQueryClient();
  const timer = useRef(null);
  const cancel = () => clearTimeout(timer.current);
  useEffect(() => cancel, []);
  const prefetch = () => {
    if (!project || !commit_id) return;
    cancel();
    timer.current = setTimeout(() => {
      queryClient.prefetchQuery(commitQuery({ project, id: commit_id }));
      queryClient.prefetchQuery(commitQuery({ project }));
    }, 150);
  };
  return { onMouseEnter: prefetch, onFocus: prefetch, onMouseLeave: cancel };
}

export function useRefreshCommit() {
  const queryClient = useQueryClient();
  return (project, id) => invalidateCommit(queryClient, project, id);
}


// The metrics the commits endpoint aggregates per batch (median, average), with their targets:
// History's (dashboard_metrics), else the default and main metrics, which the commit list and the branch's chart show.
// Metrics without a target need one: JSON leaves out undefined values, and the server would not aggregate them.
// They don't need to be declared.
export const aggregation_metrics = (qatools_metrics, { dashboard = false } = {}) => {
  const { available_metrics = {}, default_metric, main_metrics = [], dashboard_metrics } = qatools_metrics ?? {};
  // lists, see normalize_metrics: but the cache may have metrics files from before it
  const main = Array.isArray(main_metrics) ? main_metrics : [];
  const keys = dashboard ? (Array.isArray(dashboard_metrics) ? dashboard_metrics : main) : [default_metric, ...main];
  return Object.fromEntries(keys
    .filter(m => !!m)
    .map(m => [m, available_metrics[m]?.target ?? 0]));
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
// Whose commits the project's pages list: the URL says, else what users last picked in this project, else theirs
// ("mine") if they're signed in. Branch and committer pages, and History, are about everyone's.
// {scope, is_default}: the default falls back to everyone's when users have nothing in the project.
// `ready`: we know who the user is, lists wait for it rather than show everyone's, then theirs.
export function useListScope(selected) {
  const { data: user_data, isPending: user_pending } = useQuery(userQuery);
  const user = user_data ?? logged_out_user;
  const remembered = usePrefsStore(state => state.listScope?.[selected.project]);
  const fallen_back = useFallbacks(state => !!state.keys[`${user.user_id}|${selected.project}`]);
  const { route, branch } = selected;
  const has_scope = route.is_commits && !branch;
  const info = { has_scope, ready: !user_pending, user_id: user.user_id ?? null };
  if (!has_scope) return { ...info, scope: 'all', is_default: true };
  if (selected.scope) return { ...info, scope: !user.is_logged ? 'all' : selected.scope, is_default: false };
  if (!user.is_logged) return { ...info, scope: 'all', is_default: true };
  const scope = remembered ?? 'mine';
  return { ...info, scope: scope === 'mine' && fallen_back ? 'all' : scope, is_default: true, fell_back: scope === 'mine' && fallen_back };
}

// The projects where users have nothing, for the session: they see everyone's. Shared by the page and the sidebar.
const useFallbacks = create(set => ({
  keys: {},
  add: key => set(state => ({ keys: { ...state.keys, [key]: true } })),
}));

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
  // only mine, without the CI's (see useListScope)
  const scope_info = useListScope(selected);
  const { scope, fell_back } = scope_info;
  const addFallback = useFallbacks(state => state.add);
  const hide_ci = (route.is_commits || route.is_committer) && selected.hide_ci;
  const params = {
    project,
    branch: branch ?? undefined,
    committer: committer ?? undefined,
    scope: scope === 'mine' ? 'mine' : undefined,
    // lists of mine are the user's: not shared between accounts in the cache
    viewer: scope === 'mine' ? scope_info.user_id : undefined,
    origin: hide_ci ? 'webapp,local' : undefined,
    // searches look at all the commits
    from: search ? undefined : date_range[0].toISOString(),
    to: search ? undefined : date_range[1].toISOString(),
    metrics,
    ...(dashboard ? { with_outputs: true, only_ci_batches: selected_batch_new === 'default' } : {}),
  };
  // We wait for the project's metrics (only /api/v1/project has them): the list depends on them, it's heavy to fetch twice
  const { isFetched: project_fetched } = useQuery(projectQuery(project));
  const can_fetch = enabled && !!project && project_fetched && scope_info.ready;
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
  // users with nothing in the project see everyone's, unless they asked for theirs: no commits of theirs
  // (the server looks further back than the dates when there are none in them) and no batches
  const may_fall_back = scope === 'mine' && scope_info.is_default && !search && query.isSuccess && !isPlaceholderData && (data?.length ?? 0) === 0;
  const { data: my_batches } = useInfiniteQuery({ ...batchesPagesQuery({ project, scope: 'mine', viewer: scope_info.user_id, page_size: 1 }), enabled: may_fall_back });
  if (may_fall_back && my_batches && my_batches.pages[0]?.batches?.length === 0)
    addFallback(`${scope_info.user_id}|${project}`);
  // Thanks to TanStack Query's structural sharing, refetches that bring nothing new keep the same arrays
  const derived = useMemo(() => {
    const all = data ?? [];
    // Hide commits without results, except recent ones: their CI may still be running
    const commits = all.some(has_batches) ? all.filter(c => c.is_recent || has_batches(c)) : all;
    // lists of my commits, or without the CI's, may not have the default branch's latest commit: we ask for it.
    // Branch and committer pages keep their latest listed commit.
    const filtered = scope === 'mine' || (hide_ci && !branch && !committer);
    const latest_commit = filtered ? undefined : branch ? all[0] : all.find(c => c.branch === default_branch);
    return { commits, ids: all.map(c => c.id), latest_commit };
  }, [data, branch, committer, default_branch, scope, hide_ci]);

  // The project's latest commit on its default branch may not be in the pages we loaded:
  // other branches can have many more recent commits. We then ask for it.
  const wants_latest = enabled && !!project && paginated && !branch && !committer && !!default_branch && query.isSuccess && !derived.latest_commit;
  const { data: latest_on_default } = useQuery({
    ...commitsQuery({ project, branch: default_branch, from: params.from, to: params.to, metrics, limit: 1 }),
    enabled: wants_latest,
    refetchInterval,
  });
  const latest_commit = derived.latest_commit ?? (wants_latest ? latest_on_default?.[0] : undefined);

  // Only what pages use: TanStack Query re-renders components when the fields they read change, and spreading
  // the whole query would read them all (dataUpdatedAt, isStale, failureCount...)
  const { error, refetch, isPending, isSuccess, isFetching, hasNextPage, fetchNextPage, isFetchingNextPage } = query;
  const has_scope = scope_info.has_scope;
  return useMemo(() => ({
    data, ...derived, latest_commit, date_range, project, search, paginated, qatools_metrics, scope, has_scope, fell_back, hide_ci,
    error, refetch, isPending, isSuccess, isFetching, isPlaceholderData, hasNextPage, fetchNextPage, isFetchingNextPage,
  }), [data, derived, latest_commit, date_range, project, search, paginated, qatools_metrics, scope, has_scope, fell_back, hide_ci,
    error, refetch, isPending, isSuccess, isFetching, isPlaceholderData, hasNextPage, fetchNextPage, isFetchingNextPage]);
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


// Milestones are called by their name, unless users called them something else on this page (names we give, like
// "ref 2", don't count)
const side_label = (milestone, label, fallback) => label && !is_default_name(label) ? label
  : milestone ? milestone_name(milestone) : label || fallback;

// The references users selected (see `references` in src/selection.js), with what we know about them:
// their commit (without its outputs, unless we have them already), their name, color...
// The one shown is the reference commit we compare with, fetched as before with its outputs.
// TanStack Query keeps the same array while the commits are the same: the comparison changes only when they do
const commits_data = results => results.map(result => result.data);

function useReferences(selected, ref_commit, milestones, enabled) {
  const queryClient = useQueryClient();
  const { references, ref_index, color_new } = selected;
  // Not the one shown: it's ref_commit, that refreshes while its runs are running.
  // While they load, their commit with its outputs if we have it, e.g. after we compared with them.
  const others = references.filter((_, index) => index !== ref_index);
  const cached_others = useQueries({
    combine: commits_data,
    queries: others.map(side => ({
      ...commitSummaryQuery({ project: side.project, id: side.commit_id ?? undefined }),
      enabled: enabled && !!side.commit_id,
      placeholderData: () => queryClient.getQueryData(commitQuery({ project: side.project, id: side.commit_id }).queryKey)
        ?? findCachedCommit(queryClient, side.project, side.commit_id),
    })),
  });
  return useMemo(() => {
    const names = reference_names(references);
    // what a reference is called if users clear its name
    const default_name = index => reference_names(references.map((r, i) => i === index ? { ...r, label: '' } : r))[index];
    const colors = side_colors(color_new, references).slice(1);
    return references.map((side, index) => {
      const is_shown = index === ref_index;
      const commit = is_shown ? ref_commit : cached_others[index < ref_index ? index : index - 1];
      // e.g. the default reference: the latest commit on the reference branch
      const commit_id = side.commit_id ?? (is_shown ? ref_commit?.id ?? null : null);
      const [milestone] = milestones_of(milestones, { project: side.project, commit: commit_id ?? undefined, batch: side.batch, filter: side.filter });
      const number = index + 1;
      return {
        ...side,
        commit_id,
        index,
        number,
        is_shown,
        commit: commit ?? undefined,
        milestone,
        // what the tabs, the reference's bar and the viewers call it: its milestone's name, else what users called it,
        // else "ref", "ref 2"... (see reference_names). Numbers, not letters: blind tests call images A and B.
        display_label: side_label(milestone, names[index]),
        default_label: milestone ? milestone_name(milestone) : default_name(index),
        color: side_color(colors[index]),
      };
    });
  }, [references, ref_index, color_new, ref_commit, cached_others, milestones]);
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
  // new commits appear on lists of commits, unless they end before today (searches ignore the dates)
  const [loaded_at] = useState(() => Date.now());
  const may_get_new_commits = !!selected.search?.trim() || selected.date_range[1] >= loaded_at;
  const list_options = {
    enabled: !on_commit_page,
    refetchInterval: route.is_list && may_get_new_commits ? 60 * 1000 : undefined,
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
  // to name what we compare
  const { data: milestones = no_milestones } = useQuery({ ...milestonesQuery(project), enabled: !!project && on_commit_page });
  const references = useReferences(selected, ref_commit, milestones, on_commit_page);

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

  // What the page compares, in order: the new results, then the reference. Viewers can use it instead of
  // new_* and ref_*, it's how we'll compare more than two. Their labels: their milestone's name, else new/reference...
  const new_milestone = milestones_of(milestones, {
    project: new_project, commit: new_commit?.id ?? selected.new_commit_id ?? undefined, batch: selected_batch_new, filter: filter_batch_new,
  })[0];
  const shown_reference = references[selected.ref_index];
  const new_label = side_label(new_milestone, selected.label_new, 'new');
  const [new_color] = side_colors(selected.color_new, selected.references);
  const compared = useMemo(() => [
    {
      key: 'new', label: new_label, default_label: new_milestone ? milestone_name(new_milestone) : 'new', color: side_color(new_color), project: new_project, commit: new_commit,
      batch: batches.new_batch, filter: filter_batch_new, milestone: new_milestone,
    },
    {
      key: 'reference', label: shown_reference.display_label, default_label: shown_reference.default_label, color: shown_reference.color, number: shown_reference.number,
      project: selected.ref_project, commit: ref_commit, batch: batches.ref_batch, filter: filter_batch_ref, milestone: shown_reference.milestone,
    },
  ], [new_label, new_color, new_project, new_commit, batches, filter_batch_new, new_milestone, shown_reference, selected.ref_project, ref_commit, filter_batch_ref]);
  // what viewers call the new and reference results, and their colors: labels.new, labels.colors.reference...
  const labels = useMemo(() => ({
    new: compared[0].label,
    reference: compared[1].label,
    colors: { new: compared[0].color, reference: compared[1].color },
  }), [compared]);

  // All the metrics of the runs, declared or not. The batch's used metrics are a new Set when users filter or sort runs:
  // the metrics change only with their keys, so that output cards don't re-render.
  const used_metrics_key = used_metrics_signature(batches.new_batch.used_metrics);
  const metrics = useMemo(
    () => with_used_metrics(config.metrics, used_metrics_key),
    [config.metrics, used_metrics_key],
  );

  return useMemo(
    () => ({ selected, project, project_data, list: searched_list, unsearched_list: default_list, new_commit, ref_commit, ...batches, ...config, metrics, selected_views, default_views, references, compared, labels }),
    [selected, project, project_data, searched_list, default_list, new_commit, ref_commit, batches, config, metrics, selected_views, default_views, references, compared, labels],
  );
}

export const ComparisonContext = createContext(null);

export const ComparisonProvider = ({ children }) =>
  createElement(ComparisonContext.Provider, { value: useComparisonState() }, children);

// Everything about the comparison of the new and reference commits: commits, batches, configuration and metrics
export const useComparison = () => useContext(ComparisonContext);

// What viewers call the new and reference results, and their colors: { new, reference, colors: { new, reference } }.
// Those given, else the page's (useComparison().labels): milestones' names, what users called them...
export const useLabels = labels => {
  const comparison = useContext(ComparisonContext);
  return labels ?? comparison?.labels;
};

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
