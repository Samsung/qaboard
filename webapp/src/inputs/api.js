// Inputs and collections (docs/design/inputs-and-collections.md, rollout 1).
// - The Inputs tab lists every input the project's runs (and its subprojects') used: /<project>/inputs
// - Collections are named, versioned lists of inputs of a project: /<project>/collections/<id>
// The API is backend/backend/api/inputs.py and collections.py, documented in backend/backend/openapi.yaml.
import { queryOptions, infiniteQueryOptions } from "@tanstack/react-query";

import { http } from "../api/http";
import { path_segment, stringify_query } from "../selection";


// -- Inputs

// What the Inputs page asks for, from its URL: ?q=&folder=&database=&live=0&sort=path
export const inputs_defaults = { q: '', folder: '', database: '', live: true, sort: 'last_run' };
export const inputs_sorts = [
  { value: 'last_run', label: 'Last used', title: 'The inputs runs used most recently first' },
  { value: 'path', label: 'Path', title: 'In alphabetical order of their path' },
];

const text = value => typeof value === 'string' ? value : '';
export const inputs_filters_from_query = query => ({
  q: text(query.q),
  folder: normalize_folder(text(query.folder)),
  database: text(query.database),
  live: query.live !== '0' && query.live !== 'false',
  sort: inputs_sorts.some(s => s.value === query.sort) ? query.sort : inputs_defaults.sort,
});

// Pages of inputs: the grid loads them as users scroll
export const inputs_page_size = 200;

// The parameters of GET /inputs: only those that aren't the defaults, so that equal filters share their cache
export const inputs_params = (project, { q, folder, database, live, sort } = {}) => ({
  project,
  q: q?.trim() || undefined,
  folder: folder || undefined,
  database: database || undefined,
  live: live === false ? 0 : 1,
  sort: sort || inputs_defaults.sort,
});

// {inputs: [Input], total, databases: [{database, count}], folders: [{folder, count}]}, by pages.
// The server counts total, databases and folders for the first page only (null or missing on the next ones): read them on pages[0].
export const inputs_total = pages => pages?.[0]?.total ?? null;
export const inputs_next_offset = (last, pages) => {
  const loaded = pages.reduce((n, page) => n + (page.inputs?.length ?? 0), 0);
  const total = inputs_total(pages);
  // without a total (an older server, or an error), go on while pages are full
  const more = total === null ? (last.inputs?.length ?? 0) >= inputs_page_size : loaded < total;
  return (last.inputs?.length ?? 0) > 0 && more ? loaded : undefined;
};
export const inputsQuery = (project, filters) => {
  const params = inputs_params(project, filters);
  return infiniteQueryOptions({
    queryKey: ['inputs', project, { ...params, project: undefined }],
    queryFn: async ({ pageParam, signal }) => (await http.get('/api/v1/inputs', { params: { ...params, limit: inputs_page_size, offset: pageParam }, signal })).data,
    initialPageParam: 0,
    getNextPageParam: inputs_next_offset,
    enabled: !!project,
    staleTime: 60 * 1000,
  });
};

// The most inputs a collection's version holds: "Select all matching" selects up to that many
export const max_collection_inputs = 50000;

// The ids of every input that matches the filters, in the list's order: {ids, total, too_many, max}.
// More than max_collection_inputs: too_many, no ids (users narrow the filters).
export const fetchMatchingIds = async (project, filters, { signal } = {}) => {
  const data = (await http.get('/api/v1/inputs', { params: { ...inputs_params(project, filters), fields: 'id' }, signal })).data ?? {};
  return { ids: data.ids ?? [], total: data.total ?? null, too_many: !!data.too_many, max: data.max ?? max_collection_inputs };
};

// What identifies a set of matching inputs (the sort only orders them)
export const filters_key = filters => JSON.stringify({ ...inputs_params('', filters), project: undefined, sort: undefined });

// The filters in words: ['search "night"', 'folder night/street', 'hiding inputs whose runs were deleted']
export const describe_filters = ({ q, folder, database, live } = {}) => [
  q?.trim() && `search "${q.trim()}"`,
  folder && `folder ${folder}`,
  database && `database ${database}`,
  live !== false && 'hiding inputs whose runs were deleted',
].filter(Boolean);

const count_inputs = n => `${n.toLocaleString('en-US')} input${n === 1 ? '' : 's'}`;
// Where a selection of the Inputs page came from, for the notes of the version it saves (users can edit them):
//   From Inputs: search "night", folder night/street, hiding inputs whose runs were deleted — 212 inputs
//   From Inputs: search "night", hiding inputs whose runs were deleted — 211 of the 212 matching inputs   (some unselected)
//   From Inputs, picked by hand: folder night/street, hiding inputs whose runs were deleted — 12 inputs
// `matching`: the selection's {filters, count} after "Select all" (else it was picked by hand, in `filters`)
export const selection_provenance = ({ count, filters, matching }) => {
  const words = f => describe_filters(f).join(', ') || 'all inputs';
  if (matching && matching.count === count) return `From Inputs: ${words(matching.filters)} — ${count_inputs(count)}`;
  if (matching) return `From Inputs: ${words(matching.filters)} — ${count.toLocaleString('en-US')} of the ${count_inputs(matching.count).replace(/inputs?$/, 'matching inputs')}`;
  return `From Inputs, picked by hand: ${words(filters)} — ${count_inputs(count)}`;
};

// An input, with the runs of the project that used it (the 50 latest)
export const inputQuery = (project, id) => queryOptions({
  queryKey: ['input', id, project],
  queryFn: async ({ signal }) => (await http.get(`/api/v1/inputs/${id}`, { params: { project }, signal })).data,
  enabled: id !== undefined && id !== null && !!project,
  staleTime: 60 * 1000,
});

export const thumbnail_url = (input, size = 256) => size === 256 && input?.thumbnail_url ? input.thumbnail_url : `/api/v1/inputs/${input.id}/thumbnail?size=${size}`;
export const input_file_url = input => `/api/v1/inputs/${input.id}/file`;

// Formats browsers decode: the image viewer opens their file. For the others (raw...), the server's preview.
export const is_browser_image = path => /\.(png|jpe?g|webp|gif|bmp|avif)$/i.test(path ?? '');

// "night/IMG_0042.raw" => "IMG_0042.raw"
export const input_name = input => input?.name || (input?.path ?? '').split(/[\\/]/).filter(Boolean).at(-1) || String(input?.path ?? input?.id ?? '');

// "/data/indoor/2024" => "indoor/2024": the end of a database's path says which it is
export const database_label = database => {
  const parts = String(database ?? '').split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).join('/') || String(database ?? '');
};


// -- Folders: inputs' paths, relative to their database

// " /night//street/ " => "night/street"
export const normalize_folder = folder => String(folder ?? '').split(/[\\/]/).map(part => part.trim()).filter(Boolean).join('/');

// The breadcrumb of a folder: "night/street" => [{name: "All", folder: ""}, {name: "night", folder: "night"}, {name: "street", folder: "night/street"}]
export const folder_breadcrumb = folder => {
  const parts = normalize_folder(folder).split('/').filter(Boolean);
  return [{ name: 'All folders', folder: '' }, ...parts.map((name, i) => ({ name, folder: parts.slice(0, i + 1).join('/') }))];
};

// A subfolder's name, as listed under its parent: the server may answer full paths or names
export const subfolder_name = (folder, parent) => {
  const full = normalize_folder(folder);
  const prefix = normalize_folder(parent);
  return prefix && full.startsWith(`${prefix}/`) ? full.slice(prefix.length + 1) : full.split('/').at(-1) ?? full;
};
// ...and its full path, to filter with
export const subfolder_path = (folder, parent) => {
  const full = normalize_folder(folder);
  const prefix = normalize_folder(parent);
  return !prefix || full.startsWith(`${prefix}/`) ? full : `${prefix}/${full}`;
};


// -- Collections

// Names: 1-200 characters, segments of [A-Za-z0-9._ -] joined by "/", " night / hard " => "night/hard" (like the server)
export const max_name_length = 200;
export const normalize_name = name => String(name ?? '').split('/').map(part => part.trim().replace(/\s+/g, ' ')).filter(Boolean).join('/');
// Why a name can't be saved, else null
export const name_problem = name => {
  const normalized = normalize_name(name);
  if (!normalized) return 'Give the collection a name.';
  if (normalized.length > max_name_length) return `Names have at most ${max_name_length} characters.`;
  const wrong = [...new Set(normalized.replace(/[A-Za-z0-9._ /-]/g, ''))];
  if (wrong.length > 0) return `Names can have letters, digits, spaces, “.”, “_” and “-”, and “/” for groups, not ${wrong.map(c => `“${c}”`).join(' ')}.`;
  return null;
};

// "night/hard-cases" => ["night", "hard-cases"]
export const name_parts = name => normalize_name(name).split('/').filter(Boolean);
// The name without its groups: "hard-cases"
export const short_name = name => name_parts(name).at(-1) ?? '';
// "night / hard-cases": easier to read
export const pretty_name = name => name_parts(name).join(' / ');

// What code and batch files call a collection: "night/hard@2", or "a/b:night/hard@2" for a collection of another project
// `version`: a number, "latest", or nothing (the latest version when it's used)
export const collection_ref = (collection, version) => {
  const base = collection?.ref || (collection?.inherited ? `${collection.project}:${collection.name}` : collection?.name) || '';
  return version === undefined || version === null || version === '' ? base : `${base}@${version}`;
};

// "a/b:night/hard@2" => {project: "a/b", name: "night/hard", version: 2}. version: a number, "latest" or null
export const parse_ref = ref => {
  const match = /^(?:([^:@]+):)?([^:@]+?)(?:@(\d+|latest))?$/.exec(String(ref ?? '').trim());
  if (!match) return null;
  const [, project, name, version] = match;
  return { project: project ?? null, name: normalize_name(name), version: version === undefined ? null : version === 'latest' ? 'latest' : Number(version) };
};

export const collection_path = (project, collection, version) => `/${path_segment(project)}/collections/${collection.id ?? collection}${version ? `?version=${version}` : ''}`;
export const collections_index_path = project => `/${path_segment(project)}/collections`;
export const inputs_path = (project, query = {}) => {
  const search = stringify_query(Object.fromEntries(Object.entries(query).filter(([, v]) => v !== undefined && v !== null && v !== '')));
  return `/${path_segment(project)}/inputs${search ? `?${search}` : ''}`;
};

// Python, for the collection's page
export const python_snippet = (ref, project) => [
  'from qaboard import collections',
  '',
  `collection = collections.get("${ref}"${project ? `, project="${project}"` : ''})`,
  'print(collection.version, len(collection))',
  'for item in collection:',
  '    print(item.absolute_path)  # item.database / item.path',
].join('\n');

// A batch name from a collection's: "night/hard-cases" => "hard-cases"
export const batch_name = name => (short_name(name) || 'collection').toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'collection';

// A batch that runs on it, for the collection's page: in a batch file, listed in qaboard.yaml's inputs.batches.
// Collections have their own key, next to `inputs`
export const yaml_snippet = (ref, name, configurations = ['base']) => [
  `${batch_name(name)}:`,
  `  configurations: [${configurations.join(', ')}]`,
  '  collections:',
  `    - ${ref}`,
].join('\n');

export const export_yaml_url = (collection, version) => `/api/v1/collections/${collection.id}/export.yaml${version ? `?version=${version}` : ''}`;


// {collections: [Collection], ...}: the project's and its ancestors'.
// Optional, when the server says: `my_groups` ([{id, name}], the user's groups, to pin for) and `can_pin_everyone`.
export const collectionsQuery = (project, { archived = false } = {}) => queryOptions({
  queryKey: ['collections', project, { archived: !!archived }],
  queryFn: async ({ signal }) => {
    const data = (await http.get('/api/v1/collections', { params: { project, archived: archived ? 1 : 0 }, signal })).data;
    return { ...data, collections: data?.collections ?? [] };
  },
  enabled: !!project,
  staleTime: 60 * 1000,
});

// A collection, a version of it (the latest by default) and its versions
// `project`: the project users look from, the collection's or a subproject's
export const collectionQuery = (id, version, project) => queryOptions({
  queryKey: ['collection', Number(id), version ? Number(version) : 'latest', project ?? null],
  queryFn: async ({ signal }) => (await http.get(`/api/v1/collections/${id}`, { params: { version: version || undefined, project: project || undefined }, signal })).data,
  enabled: id !== undefined && id !== null && !Number.isNaN(Number(id)),
  retry: false,
  staleTime: 60 * 1000,
});

// The inputs of a version, in their order. The server answers {inputs, total}, or a list
const as_members = data => Array.isArray(data) ? { inputs: data, total: data.length } : { ...data, inputs: data?.inputs ?? [], total: data?.total ?? data?.inputs?.length ?? 0 };
export const collectionInputsQuery = (id, version, { q, project } = {}) => infiniteQueryOptions({
  queryKey: ['collection-inputs', Number(id), version ? Number(version) : 'latest', { q: q?.trim() || undefined, project: project || undefined }],
  queryFn: async ({ pageParam, signal }) => as_members((await http.get(`/api/v1/collections/${id}/inputs`, {
    params: { version: version || undefined, q: q?.trim() || undefined, project: project || undefined, limit: inputs_page_size, offset: pageParam }, signal,
  })).data),
  initialPageParam: 0,
  getNextPageParam: (last, pages) => {
    const loaded = pages.reduce((n, page) => n + page.inputs.length, 0);
    return last.inputs.length > 0 && loaded < last.total ? loaded : undefined;
  },
  enabled: id !== undefined && id !== null,
  staleTime: 5 * 60 * 1000,
});

// Every input id of a version, in order: to save the next version with all of them
export const fetchMemberIds = async (id, version, { page = 5000, project } = {}) => {
  const ids = [];
  for (let offset = 0; ; offset += page) {
    const { inputs, total } = as_members((await http.get(`/api/v1/collections/${id}/inputs`, { params: { version: version || undefined, project: project || undefined, limit: page, offset } })).data);
    ids.push(...inputs.map(i => i.id));
    if (inputs.length === 0 || ids.length >= total) return ids;
  }
};


// -- Changes. They answer the collection as the server saved it.
// shared: with the project (developers), else personal: only its creator sees it
export const createCollection = async ({ project, name, description, inputs, notes, shared = false }) => (await http.post('/api/v1/collections', { project, name: normalize_name(name), description: description || undefined, inputs, notes: notes || undefined, shared: !!shared })).data;
export const saveVersion = async (id, { inputs, base_version, notes }) => (await http.post(`/api/v1/collections/${id}/versions`, { inputs, base_version, notes: notes || undefined })).data;
export const updateCollection = async (id, fields) => (await http.patch(`/api/v1/collections/${id}`, fields)).data;
export const setFavorite = async (id, favorite, project) => {
  const options = { params: { project: project || undefined } };
  return (await (favorite ? http.put(`/api/v1/collections/${id}/favorite`, undefined, options) : http.delete(`/api/v1/collections/${id}/favorite`, options))).data;
};
// group: a group id, or null for everyone on the project. In the query string: proxies may drop the body of DELETEs
export const setPin = async (id, group, pinned) => {
  const params = { group: group === null || group === undefined ? '' : group };
  return (await (pinned
    ? http.put(`/api/v1/collections/${id}/pins`, { group: group ?? null }, { params })
    : http.delete(`/api/v1/collections/${id}/pins`, { params }))).data;
};

// The next version's inputs: the version's, without `removed`, then `added` (once each, in order)
export const next_members = (ids, { removed = [], added = [] } = {}) => {
  const removing = new Set(removed);
  const kept = ids.filter(id => !removing.has(id));
  const seen = new Set(kept);
  return [...kept, ...added.filter(id => !seen.has(id) && seen.add(id))];
};

export const is_conflict = error => error?.response?.status === 409;
// 409s say more: the existing collection's `id` (name_taken), or the `latest_version` (stale_version)
export const conflict_data = error => is_conflict(error) ? error.response.data ?? {} : null;


// -- Pins: pinned_for lists groups, {id, name}. Everyone on the project is null, or {id: null}
const is_everyone = group => group === null || group === undefined || (typeof group === 'object' && (group.id === null || group.id === undefined));
export const pin_key = group => is_everyone(group) ? 'everyone' : String(typeof group === 'object' ? group.id : group);
export const pin_label = group => is_everyone(group) ? 'everyone' : String(typeof group === 'object' ? group.name ?? group.id : group);
export const everyone = { id: null, name: null };
export const is_pinned_for = (collection, group) => (collection?.pinned_for ?? []).some(g => pin_key(g) === pin_key(group));


// -- The sidebar's and panel's lists

const by_name = (a, b) => a.name.localeCompare(b.name);
// pinned for everyone or one of the user's groups (the server says), else for anyone
export const is_pinned = c => c.pinned ?? (c.pinned_for ?? []).length > 0;
// Pinned (for one of the user's groups or everyone), favorites, then the others by group ("night/hard" is in "night").
// Collections of ancestor projects are listed apart, by project.
export const organize_collections = (list = [], project) => {
  const is_inherited = c => c.inherited ?? (!!c.project && c.project !== project);
  const own = list.filter(c => !is_inherited(c));
  const inherited = list.filter(is_inherited);
  const pinned = list.filter(is_pinned).sort(by_name);
  const favorites = list.filter(c => c.favorite && !pinned.includes(c)).sort(by_name);
  const ancestors = [...new Set(inherited.map(c => c.project))].sort((a, b) => b.length - a.length)
    .map(p => ({ project: p, collections: inherited.filter(c => c.project === p).sort(by_name) }));
  return { pinned, favorites, own: [...own].sort(by_name), ancestors };
};

// {name, path, groups: [...], collections: [...], count} from names like "night/hard": "/" nests groups
export const collections_tree = (collections, root_path = '') => {
  const root = { name: '', path: root_path, groups: {}, collections: [], count: 0 };
  for (const c of collections) {
    const parts = name_parts(c.name);
    let node = root;
    node.count++;
    for (const part of parts.slice(0, -1)) {
      node = node.groups[part] ??= { name: part, path: `${node.path}/${part}`, groups: {}, collections: [], count: 0 };
      node.count++;
    }
    node.collections.push(c);
  }
  const finish = node => ({ ...node, groups: Object.values(node.groups).map(finish).sort(by_name), collections: [...node.collections].sort(by_name) });
  return finish(root);
};

// What the collections' search box matches
export const collection_search_text = c => [c.name, c.ref, c.description, c.project, c.created_by?.user_name, c.created_by?.full_name, ...(c.pinned_for ?? []).map(pin_label)].filter(Boolean).join(' ');

export const creator_name = c => c?.created_by?.full_name || c?.created_by?.user_name || null;
