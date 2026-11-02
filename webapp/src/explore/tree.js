// Explore's tree of projects. Project ids are paths ("group/repo/sub/dir", see the monorepo docs): projects go under
// their closest ancestor project, or under a group for a prefix several projects share without a project of its own.
// Quiet projects (only the CI ran them lately, e.g. subprojects whose tests nobody looks at) fade into "N quiet projects".
import { match_query } from "../utils";

export const quiet_after_days = 90;
const day_ms = 24 * 3600 * 1000;

// The server's dates are UTC, some without a timezone
export const time = date => date ? new Date(/(Z|[+-]\d\d:?\d\d)$/.test(date) ? date : `${date}Z`).getTime() : null;

export const quiet_tooltip = `Only the CI ran them in the last ${quiet_after_days} days: nobody started batches from the web app or their terminal. `
  + "Pin a project to keep it in view.";

// Projects that lists show: those with a qaboard.yaml and commits.
// Not those imported from older tools (backend/backend/scripts/migrate_legacy_commits.py)
export const is_listed = details => !details.data?.legacy
  && details.data?.qatools_config?.project?.name !== undefined
  && details.latest_commit_datetime !== undefined && details.latest_commit_datetime !== null;

// What happened last: people's batches first, else any run, else the latest commit
export const last_activity = details => {
  if (details.latest_human_activity) return { date: details.latest_human_activity, kind: 'human' };
  const run = details.latest_output_datetime || details.data?.latest_output_datetime;
  if (run) return { date: run, kind: 'run' };
  return { date: details.latest_commit_datetime ?? null, kind: 'commit' };
};

// Only the CI ran it in 90 days: nobody did from the web app or a terminal. Views don't count: people glancing at
// CI results don't make a project interesting to explore. Servers that don't say aren't guessed.
export const is_quiet = (details, { pinned = false, now = Date.now() } = {}) => {
  if (pinned) return false;
  if (details.latest_human_activity === undefined) return false;
  return !(time(details.latest_human_activity) >= now - quiet_after_days * day_ms);
};

const add_activity = (a, b) => {
  if (!a) return b ?? null;
  if (!b) return a;
  return a.map((n, i) => n + (b[i] ?? 0));
};
const latest = (a, b) => (time(b?.date) ?? -Infinity) > (time(a?.date) ?? -Infinity) ? b : a;

// Pinned first, then the most recently active, then by name
const by_relevance = (a, b) => (b.has_pinned - a.has_pinned)
  || ((time(b.last_activity?.date) ?? 0) - (time(a.last_activity?.date) ?? 0))
  || a.id.localeCompare(b.id);

/**
 * projects: {[id]: details} from /api/v1/projects, favorites: {[id]: true}.
 * Nodes: {id, name (relative to its parent), project (null for groups), children, quiet_children,
 *   nb_projects (below it), last_activity, activity (with what's below), has_pinned, pinned, quiet (with all below)}
 */
export function build_tree(projects, { favorites = {}, now = Date.now() } = {}) {
  const ids = Object.keys(projects).sort();
  // a trie of path segments
  const root = { path: '', children: new Map() };
  for (const id of ids) {
    let node = root;
    for (const segment of id.split('/')) {
      const path = node.path ? `${node.path}/${segment}` : segment;
      if (!node.children.has(segment)) node.children.set(segment, { path, children: new Map() });
      node = node.children.get(segment);
    }
    node.project = projects[id];
  }

  const finish = (node, children) => {
    const own = node.project;
    const pinned = !!own && !!favorites[node.id];
    let activity = own?.activity ?? null;
    let last = own ? last_activity(own) : null;
    let nb_projects = 0;
    for (const child of children) {
      activity = add_activity(activity, child.activity);
      last = latest(last, child.last_activity);
      nb_projects += child.nb_projects + (child.project ? 1 : 0);
    }
    const has_pinned = pinned || children.some(c => c.has_pinned);
    const own_quiet = own ? is_quiet(own, { pinned, now }) : true;
    const quiet = own_quiet && children.every(c => c.quiet);
    children.sort(by_relevance);
    return {
      ...node, pinned, has_pinned, quiet, activity, last_activity: last, nb_projects,
      children: children.filter(c => !c.quiet),
      quiet_children: children.filter(c => c.quiet),
    };
  };

  // the nodes a trie node gives, under a parent at `parent_path`
  const collapse = (trie, parent_path) => {
    const relative = path => parent_path ? path.slice(parent_path.length + 1) : path;
    if (trie.project) {
      const children = descendants(trie, trie.path);
      return [finish({ id: trie.path, name: relative(trie.path), project: trie.project }, children)];
    }
    const inner = descendants(trie, parent_path);
    // a prefix shared by several projects is a group, else its only project goes up
    if (inner.length < 2) return inner;
    const regrouped = inner.map(node => ({ ...node, name: node.id.slice(trie.path.length + 1) }));
    return [finish({ id: trie.path, name: relative(trie.path), project: null }, regrouped)];
  };
  const descendants = (trie, parent_path) => [...trie.children.values()].flatMap(child => collapse(child, parent_path));

  const top = descendants(root, '');
  top.sort(by_relevance);
  return { nodes: top.filter(n => !n.quiet), quiet_nodes: top.filter(n => n.quiet) };
}

// How many projects are in those nodes, them included
export const count_projects = nodes => nodes.reduce((n, node) => n + node.nb_projects + (node.project ? 1 : 0), 0);

// With a filter: the matching projects, flat, quiet ones included
export function filter_projects(projects, query, { favorites = {}, now = Date.now() } = {}) {
  const matcher = match_query(query);
  return Object.entries(projects)
    .filter(([id]) => matcher(id))
    .map(([id, project]) => {
      const pinned = !!favorites[id];
      return {
        id, name: id, project, pinned, has_pinned: pinned, children: [], quiet_children: [], nb_projects: 0,
        activity: project.activity ?? null, last_activity: last_activity(project), quiet: is_quiet(project, { pinned, now }),
      };
    })
    .sort(by_relevance);
}

// The subprojects of a project, everywhere below it
export const subprojects_of = (projects, project) => Object.keys(projects ?? {}).filter(id => id.startsWith(`${project}/`));

// "group/repo/sub" => [{name: "group", path: "group", is_project}, ...], for breadcrumbs
export const path_segments = (project, projects = {}) => {
  const segments = project.split('/');
  return segments.map((name, i) => {
    const path = segments.slice(0, i + 1).join('/');
    return { name, path, is_project: !!projects[path] };
  });
};
