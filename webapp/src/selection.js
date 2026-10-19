// What the user is looking at: the project, the commits compared, batches, filters, views...
//
// The URL is the only source of truth: we derive the selection from it, and we "select" by navigating.
// Links can be shared, reloads keep the state, and the browser's back/forward buttons just work.
import { useMemo } from "react";
import qs from "qs";
import { DateTime } from "luxon";

import { history, useRouter, matchRoutes } from "./router";
import { route_paths } from "./route_paths";


// Names in the URL's query string
const url_keys = {
  ref_project: "ref_project",
  new_project: "new_project",
  ref_commit_id: "reference",
  selected_batch_new: "batch",
  selected_batch_ref: "batch_ref",
  filter_batch_new: "filter",
  filter_batch_ref: "filter_ref",
  // the references that are not shown, see `references` below
  other_refs: "compare",
};

const route_names = Object.fromEntries(Object.entries(route_paths).map(([name, path]) => [path, name]));
const page_routes = Object.values(route_paths).map(path => ({ path }));

// What kind of page a route pattern is
export const route_info = path => {
  const name = route_names[path];
  const is_committer = name === 'committer';
  const is_commits = ['project', 'commits', 'branch'].includes(name);
  const is_commit = ['commit', 'latest_commit'].includes(name);
  const is_history = ['history', 'history_branch', 'dashboard', 'dashboard_branch'].includes(name);
  return { is_committer, is_commits, is_commit, is_history, is_list: is_commits || is_committer };
};

const decode = value => {
  if (value === undefined || value === null) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

// qs turns long lists into objects unless we raise its limit, and reads ?a=1 as a string
export const parse_query = search => qs.parse(search.replace(/^\?/, ''), { arrayLimit: 10000 });
const as_list = value => {
  if (value === undefined || value === null) return undefined;
  if (value === '') return [];
  return typeof value === 'object' && !Array.isArray(value) ? Object.values(value) : [].concat(value);
};

// For paths: project ids and branches have slashes, but also e.g. '#'
export const path_segment = value => String(value).split('/').map(encodeURIComponent).join('/');

const day = /^\d{4}-\d{2}-\d{2}$/;

// The commits we show are in this date range: ?from=YYYY-MM-DD&to=YYYY-MM-DD, by default the last 3 days
export const date_range_from_query = query => {
  const from = day.test(query.from ?? '') ? DateTime.fromISO(query.from) : DateTime.now().minus({ days: 3 });
  const to = day.test(query.to ?? '') ? DateTime.fromISO(query.to) : DateTime.now();
  return [from.startOf('day').toJSDate(), to.endOf('day').toJSDate()];
};

const to_day = date => DateTime.fromJSDate(date).toISODate();


// Users can select several references, and compare the new commit with one of them at a time.
// The one shown is in ?reference=&batch_ref=&filter_ref=&ref_project= as before, so that existing links and code
// keep working. The others are in ?compare=: commit ids, or {commit, batch, filter, project} when not the defaults.
// ?ref_index= is where the shown one is in the list: switching references keeps their order.
// A "side" of the comparison: { project, commit_id, batch, filter }, project defaults to the page's.
const side_from_query = (item, project) => {
  const value = typeof item === 'object' && item !== null ? item : { commit: item };
  return {
    project: value.project || project,
    commit_id: value.commit ?? null,
    batch: value.batch || 'default',
    filter: value.filter ?? '',
  };
};

const side_to_query = (side, project) => {
  const value = {
    commit: side.commit_id ?? undefined,
    batch: side.batch && side.batch !== 'default' ? side.batch : undefined,
    filter: side.filter || undefined,
    project: side.project && side.project !== project ? side.project : undefined,
  };
  const fields = Object.entries(value).filter(([, v]) => v !== undefined);
  return fields.length === 1 && fields[0][0] === 'commit' ? value.commit : Object.fromEntries(fields);
};

// Plain commit ids are repeated: ?compare=a&compare=b, else qs's indices: ?compare[0][commit]=a&compare[0][batch]=b
const other_refs_to_query = (sides, project) => {
  const items = sides.map(side => side_to_query(side, project));
  if (items.length === 0) return undefined;
  return items.every(item => typeof item === 'string') ? items : Object.fromEntries(items.map((item, index) => [index, item]));
};

export const same_side = (a, b) => !!a && !!b
  && (a.commit_id ?? null) === (b.commit_id ?? null)
  && a.project === b.project
  && (a.batch || 'default') === (b.batch || 'default')
  && (a.filter ?? '') === (b.filter ?? '');

const new_side = selected => ({
  project: selected.new_project,
  commit_id: selected.new_commit_id,
  batch: selected.selected_batch_new,
  filter: selected.filter_batch_new,
});

// The selection changes to show `references` (a list of sides), with the one at `index` compared with the new commit
export const references_changes = (references, index) => {
  const shown = references[index];
  return {
    ref_project: shown.project,
    ref_commit_id: shown.commit_id ?? undefined,
    selected_batch_ref: shown.batch || 'default',
    filter_batch_ref: shown.filter ?? '',
    other_refs: references.filter((_, i) => i !== index),
    ref_index: index,
  };
};

// What to change in the selection to... (pure: they take the selection, and return the changes for updateSelected)
// ...compare the new commit with another of the references
export const show_reference = (selected, index) => references_changes(selected.references, index);

// ...add a reference, and show it. If we have it already, we show it.
export const add_reference = (selected, side) => {
  const side_ = { project: selected.project, batch: 'default', filter: '', ...side };
  const { references } = selected;
  const existing = references.findIndex(r => same_side(r, side_));
  if (existing >= 0) return references_changes(references, existing);
  return references_changes([...references, side_], references.length);
};

// ...remove a reference. Removing the one shown shows the next one. The last one can't be removed.
export const remove_reference = (selected, index) => {
  const { references, ref_index } = selected;
  if (references.length <= 1) return {};
  const remaining = references.filter((_, i) => i !== index);
  const shown = index === ref_index ? Math.min(index, remaining.length - 1) : ref_index - (index < ref_index ? 1 : 0);
  return references_changes(remaining, shown);
};

// ...see a reference as the new results: the new commit takes its place in the references
export const show_as_new = (selected, index) => {
  const { references, ref_index } = selected;
  const side = references[index];
  if (!side?.commit_id || !selected.new_commit_id) return {};
  const swapped = references.map((r, i) => i === index ? new_side(selected) : r);
  return {
    ...references_changes(swapped, ref_index),
    new_project: side.project,
    new_commit_id: side.commit_id,
    selected_batch_new: side.batch || 'default',
    filter_batch_new: side.filter ?? '',
  };
};


// Pure, so it's easy to test: (route match, location.search) => selection
export const selection_from_url = (match, search) => {
  const { path, params } = match;
  const query = parse_query(search);
  const route = route_info(path);
  const project = decode(params.project_id) ?? query.project ?? null;

  // '' is a special value: nothing should be selected
  let new_commit_id;
  if (route.is_commit)
    new_commit_id = query.new_commit_id === '' ? '' : (decode(params.name) ?? null);
  else
    new_commit_id = query.commit ?? null;

  const selected_views = as_list(query.selected_views)?.map(v => v.replace('_', '-'));

  const ref_side = {
    project: query.ref_project || project,
    commit_id: query.reference ?? query.commit_ref_folder ?? null,
    batch: query.batch_ref || "default",
    filter: query.filter_ref ?? "",
  };
  const other_refs = (as_list(query.compare) ?? []).filter(item => item !== '').map(item => side_from_query(item, project));
  const ref_index = Math.min(Math.max(0, Math.trunc(Number(query.ref_index)) || 0), other_refs.length);
  // All the references, in the order users picked them. The one at ref_index is compared with the new commit.
  const references = [...other_refs.slice(0, ref_index), ref_side, ...other_refs.slice(ref_index)];
  return {
    project,
    route,
    // everything in the URL's query string, e.g. options of plots
    query,
    // the project page shows all the latest commits, or those from a branch or committer
    branch: ((route.is_commits || route.is_history) ? decode(params.name) : query.branch) || null,
    committer: decode(params.committer) || query.committer || null,

    // users can compare results from different projects
    new_project: query.new_project || project,
    ref_project: query.ref_project || project,

    new_commit_id,
    ref_commit_id: ref_side.commit_id,

    selected_batch_new: query.batch || query.batch_new || "default",
    selected_batch_ref: ref_side.batch,
    filter_batch_new: query.filter ?? "",
    filter_batch_ref: ref_side.filter,

    // the reference compared is references[ref_index], the same as ref_commit_id, selected_batch_ref...
    references,
    ref_index,

    // filter the list of commits
    search: query.search ?? "",
    sort_order: Number(query.sort_order ?? -1),
    sort_by: query.sort_by || undefined, // undefined: we use the default metric
    selected_views,
    selected_metrics: as_list(query.selected_metrics),
    date_range: date_range_from_query(query),
  };
};


export function useSelected() {
  const { match, location } = useRouter();
  return useMemo(() => selection_from_url(match, location.search), [match, location.search]);
}


// Values we don't need in the URL: URLs stay short and readable, and links follow the defaults
const selection_defaults = {
  selected_batch_new: 'default',
  selected_batch_ref: 'default',
  filter_batch_new: '',
  filter_batch_ref: '',
  search: '',
  sort_order: -1,
  ref_index: 0,
};
const same_value = (value, default_value) => Array.isArray(value) || Array.isArray(default_value)
  ? JSON.stringify([].concat(value)) === JSON.stringify([].concat(default_value))
  : String(value) === String(default_value);

// The project's own page lists its latest commits, selecting one opens it
const route_names_project = matched => route_names[matched?.route.path] === 'project';

// Where to go to apply changes to the selection.
// Pure as well, takes the current URL: (changes, {pathname, search}, defaults) => {pathname, search}
// Values equal to their default are removed from the URL. Callers give the defaults of their own options.
export const url_for_selection = (selected, { pathname, search }, defaults = {}) => {
  defaults = { ...selection_defaults, ...defaults };
  const query = parse_query(search);
  const matched = matchRoutes(page_routes, pathname);
  const route = route_info(matched?.route.path ?? '');
  const project = decode(matched?.match.params.project_id);
  const project_path = `/${path_segment(project)}`;
  const on_commit_page = route.is_commit;
  // the project page lists commits, but selecting one opens it
  const on_list_page = route.is_history || (route.is_list && !route_names_project(matched));

  // Branches and committers have their own pages
  if ('branch' in selected || 'committer' in selected) {
    const { branch, committer, ...rest } = selected;
    delete query.branch;
    delete query.committer;
    if (committer)
      pathname = `${project_path}/committer/${path_segment(committer)}`;
    else if (branch)
      pathname = `${project_path}/commits/${path_segment(branch)}`;
    else
      pathname = project_path;
    selected = rest;
  }

  if ('new_commit_id' in selected) {
    const { new_commit_id } = selected;
    delete query.commit;
    delete query.new_commit_id;
    if (new_commit_id === '') {
      if (on_commit_page) {
        pathname = `${project_path}/commit`;
        query.new_commit_id = '';
      }
    } else if (new_commit_id) {
      // On lists of commits we stay there: e.g. hovering commits in plots selects them
      if (on_list_page && !on_commit_page)
        query.commit = new_commit_id;
      else
        pathname = `${project_path}/commit/${path_segment(new_commit_id)}`;
    }
  }

  if ('other_refs' in selected) {
    const { other_refs, ...rest } = selected;
    const value = other_refs_to_query(other_refs ?? [], project);
    if (value === undefined) delete query.compare;
    else query.compare = value;
    selected = rest;
  }

  for (const [key, value] of Object.entries(selected)) {
    if (key === 'new_commit_id') continue;
    const url_key = url_keys[key] ?? key;
    if (key === 'selected_batch_new') delete query.batch_new; // legacy name
    if (value === undefined || value === null || (key in defaults && same_value(value, defaults[key])))
      delete query[url_key];
    else if (Array.isArray(value))
      query[url_key] = value.length === 0 ? '' : value;
    else if (value instanceof Date)
      query[url_key] = to_day(value);
    else
      query[url_key] = value;
  }
  // the page's project is implicit
  if (query.new_project === project) delete query.new_project;
  if (query.ref_project === project) delete query.ref_project;
  // without other references, the reference shown is the only one
  if (!query.compare) delete query.ref_index;
  return { pathname, search: stringify_query(query) };
};


// Changes the selection, by navigating to a new URL.
// By default it adds a browser history entry, use {replace: true} for changes users don't want to "go back" to.
// {defaults}: values that don't need to be in the URL, e.g. {show_all_files: false}
export const updateSelected = (selected = {}, { replace = false, defaults } = {}) => {
  const url = url_for_selection(selected, window.location, defaults);
  if (url.pathname === window.location.pathname && `?${url.search}` === (window.location.search || '?'))
    return;
  (replace ? history.replace : history.push)(url);
};

export const stringify_query = query => qs.stringify(query, { arrayFormat: 'repeat' });
