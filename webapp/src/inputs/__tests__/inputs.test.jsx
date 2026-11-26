/**
 * Tests for the inputs and collections (docs/design/inputs-and-collections.md): the API's queries, the helpers, the
 * grid's selection, the Inputs page, the dialogs, the Collections page, a collection's page and the collections' panel.
 * Run with: cd webapp && npm test -- inputs
 */
import { screen, fireEvent, waitFor, within, act } from '@testing-library/react';
import { QueryClient } from '@tanstack/react-query';
import { unstable_HistoryRouter as HistoryRouter } from 'react-router';

import { RouteMatch, history } from '../../router';
import { route_paths } from '../../route_paths';
import { renderWithProviders, code } from '../../test-utils';
import { toaster } from '../../toaster';
import {
  inputsQuery, inputs_params, inputs_filters_from_query, collectionQuery, collectionInputsQuery, fetchMemberIds,
  folder_breadcrumb, folder_from, full_path, toggle_meta, stringify_meta, describe_filters, set_meta_range, describe_meta, format_number, parse_meta, normalize_folder, normalize_name, name_problem, collection_ref, parse_ref,
  python_snippet, yaml_snippet, batch_name, next_members, organize_collections, collections_tree, pin_key, pin_label,
  is_pinned_for, thumbnail_url, input_file_url, is_browser_image, input_name, collection_path, inputs_path, database_label, setPin,
  selection_provenance, filters_key, fetchMatchingIds,
} from '../api';
import { click_selection, toggle_selection, select_all, move_focus, empty_selection, select_matching, selected_inputs } from '../gridSelection';
import { grid_layout, default_input_meta, thumbnail_retry, Thumbnail } from '../InputGrid';
import InputsPage from '../InputsPage';
import { facet_kind } from '../Metadata';
import CollectionPage from '../CollectionPage';
import CollectionsPage from '../CollectionsPage';
import { CollectionsPanel } from '../CollectionsPanel';
import { InputViewer, run_location } from '../InputViewer';
import { SaveCollectionDialog, AddToCollectionDialog } from '../CollectionDialogs';
import { copyWithToast } from '../../utils/clipboard';

vi.mock('../../utils/clipboard', async original => ({ ...await original(), copyWithToast: vi.fn() }));


const alice = { is_logged: true, user_id: 1, user_name: 'alice', full_name: 'Alice A' };

const input = (id, fields = {}) => ({
  id, database: '/data/captures', path: `night/street/IMG_${String(id).padStart(4, '0')}.raw`, name: `IMG_${String(id).padStart(4, '0')}.raw`,
  folder: 'night/street', runs: 3, first_run_at: '2026-10-01T10:00:00Z', last_run_at: '2026-11-01T10:00:00Z',
  thumbnail_url: `/api/v1/inputs/${id}/thumbnail?project=p`, ...fields,
});
const inputs = Array.from({ length: 6 }, (_, i) => input(i + 1));

const collection = (fields = {}) => ({
  ref: fields.name ?? 'night/hard-cases',
  id: 7, project: 'p', name: 'night/hard-cases', description: 'Hard night scenes', created_by: { id: 1, user_name: 'alice', full_name: 'Alice A' },
  created_at: '2026-11-01T10:00:00Z', updated_at: '2026-11-02T10:00:00Z', archived: false, latest_version: 2, size: 3,
  favorite: false, pinned_for: [], pinned: false, can_edit: true, inherited: false, ...fields,
});

// Answers the API calls the components make, and records them
const stubApi = (answers = {}) => {
  const calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
    const method = init.method ?? 'GET';
    calls.push({ url, method, body: init.body ? JSON.parse(init.body) : undefined });
    const key = Object.keys(answers).find(k => `${method} ${url}`.startsWith(k));
    const answer = key ? answers[key] : {};
    const [status, body] = typeof answer === 'function' ? answer(url, init) : [200, answer];
    return new Response(JSON.stringify(body), { status });
  }));
  return calls;
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(toaster.show).mockClear();
});

const renderAt = (route, url, ui, options = {}) => {
  history.replace(url);
  const pathname = url.split('?')[0];
  const params = route === 'collection'
    ? { project_id: 'p', collection_id: /\/collections\/(\d+)/.exec(pathname)[1] }
    : { project_id: 'p' };
  return renderWithProviders(
    <HistoryRouter history={history}><RouteMatch match={{ path: route_paths[route], url: pathname, params }}>{ui}</RouteMatch></HistoryRouter>,
    { user: alice, ...options },
  );
};
const query_of = () => Object.fromEntries(new URLSearchParams(window.location.search));


describe('the API', () => {
  test('the ids of every matching input', async () => {
    const calls = stubApi({ 'GET /api/v1/inputs?': { ids: [3, 1], total: 2, too_many: false, max: 50000 } });
    expect(await fetchMatchingIds('p/q', { q: ' night ', folder: 'a/b', live: false, sort: 'path' })).toEqual({ ids: [3, 1], total: 2, too_many: false, max: 50000 });
    const url = new URL(calls[0].url, 'http://x');
    expect(Object.fromEntries(url.searchParams)).toEqual({ project: 'p/q', q: 'night', folder: 'a/b', live: '0', sort: 'path', fields: 'id' });
  });

  test('inputs: the defaults stay out of the cache key, pages follow the total', async () => {
    const options = inputsQuery('p', inputs_filters_from_query({}));
    expect(options.queryKey).toEqual(['inputs', 'p', { project: undefined, q: undefined, folder: undefined, database: undefined, meta: undefined, live: 1, sort: 'last_run' }]);
    const filtered = inputsQuery('p', inputs_filters_from_query({ q: ' night ', folder: '/data//night/', live: '0', sort: 'path', database: '/data/a', meta: '{"weather":["rain"]}' }));
    expect(filtered.queryKey[2]).toEqual({ project: undefined, q: 'night', folder: '/data/night', database: '/data/a', meta: '{"weather":["rain"]}', live: 0, sort: 'path' });
    expect(inputs_params('p', { live: false })).toMatchObject({ project: 'p', live: 0 });
    expect(options.getNextPageParam({ inputs: [1, 2], total: 5 }, [{ inputs: [1, 2], total: 5 }])).toBe(2);
    expect(options.getNextPageParam({ inputs: [5], total: 5 }, [{ inputs: [1, 2, 3, 4], total: 5 }, { inputs: [5] }])).toBeUndefined();
    // the server counts on the first page only: the next ones have total null, or none
    expect(options.getNextPageParam({ inputs: [3], total: null }, [{ inputs: [1, 2], total: 5 }, { inputs: [3], total: null }])).toBe(3);
    expect(options.getNextPageParam({ inputs: [3, 4, 5] }, [{ inputs: [1, 2], total: 5 }, { inputs: [3, 4, 5] }])).toBeUndefined();
    // no total at all: on while pages are full
    const full = Array.from({ length: 200 }, (_, i) => i);
    expect(options.getNextPageParam({ inputs: full }, [{ inputs: full }])).toBe(200);
    expect(options.getNextPageParam({ inputs: [1] }, [{ inputs: full }, { inputs: [1] }])).toBeUndefined();

    const calls = stubApi({ 'GET /api/v1/inputs': { inputs: [input(1)], total: 1, databases: [], folders: [] } });
    const queryClient = new QueryClient();
    await queryClient.fetchInfiniteQuery(filtered);
    expect(calls[0].url).toBe('/api/v1/inputs?project=p&q=night&folder=%2Fdata%2Fnight&database=%2Fdata%2Fa&meta=%7B%22weather%22%3A%5B%22rain%22%5D%7D&live=0&sort=path&limit=200&offset=0');
  });

  test('unknown sorts and folders are normalized from the URL', () => {
    expect(inputs_filters_from_query({ sort: 'size', folder: ' a//b/ ', live: 'false', meta: 'not json' })).toEqual({ q: '', folder: 'a/b', database: '', meta: {}, live: false, sort: 'last_run' });
    expect(inputs_filters_from_query({ meta: '{"iso": [800, true], "x": [], "w": "rain"}' }).meta).toEqual({ iso: ['800', 'true'], w: ['rain'] });
  });

  test('collections: keys, the project users look from, every member', async () => {
    expect(collectionQuery('7', null, 'p/sub').queryKey).toEqual(['collection', 7, 'latest', 'p/sub']);
    expect(collectionQuery(7, '2').queryKey).toEqual(['collection', 7, 2, null]);
    expect(collectionInputsQuery(7, 2, { q: ' ', project: 'p' }).queryKey).toEqual(['collection-inputs', 7, 2, { q: undefined, project: 'p' }]);
    const calls = stubApi({
      'GET /api/v1/collections/7/inputs?version=2&project=p&limit=2&offset=0': { inputs: [input(1), input(2)], total: 3 },
      'GET /api/v1/collections/7/inputs?version=2&project=p&limit=2&offset=2': { inputs: [input(3)], total: 3 },
    });
    expect(await fetchMemberIds(7, 2, { page: 2, project: 'p' })).toEqual([1, 2, 3]);
    expect(calls).toHaveLength(2);
  });

  test('pins are sent in the query string too: proxies drop the body of DELETEs', async () => {
    const calls = stubApi();
    await setPin(7, null, true);
    await setPin(7, 12, false);
    expect(calls[0]).toMatchObject({ method: 'PUT', url: '/api/v1/collections/7/pins?group=', body: { group: null } });
    expect(calls[1]).toMatchObject({ method: 'DELETE', url: '/api/v1/collections/7/pins?group=12' });
  });
});


describe('helpers', () => {
  test('inputs added before any run say so', () => {
    expect(default_input_meta({ runs: 0, database: '/data' })).toMatch(/^no runs yet · /);
    expect(default_input_meta({ runs: 1, database: '/data' })).toMatch(/^1 run · /);
    expect(default_input_meta({ runs: 3 })).toBe('3 runs');
  });

  test("a selection's provenance, for its version's notes", () => {
    const filters = { q: ' night ', folder: 'night/street', database: '', live: true };
    expect(selection_provenance({ count: 212, filters, matching: { filters, count: 212 } }))
      .toBe('From Inputs: search "night", folder night/street, hiding inputs whose runs were deleted — 212 inputs');
    expect(selection_provenance({ count: 2431, filters, matching: { filters: { database: '/data/lab', live: false }, count: 2432 } }))
      .toBe('From Inputs: database /data/lab — 2,431 of the 2,432 matching inputs');
    expect(selection_provenance({ count: 1, filters: { live: false } })).toBe('From Inputs, picked by hand: all inputs — 1 input');
    // the sort orders the same inputs
    expect(filters_key({ ...filters, sort: 'path' })).toBe(filters_key({ ...filters, q: 'night' }));
    expect(filters_key(filters)).not.toBe(filters_key({ ...filters, live: false }));
  });

  test('folders: of the full paths, from the folder every input is in', () => {
    expect(normalize_folder(' /data//night/ ')).toBe('/data/night');
    expect(normalize_folder('night//street/')).toBe('night/street');
    expect(normalize_folder('/')).toBe('');
    // the root is one crumb: its full path
    expect(folder_breadcrumb('/mnt/x', '/mnt/x/night/cam0')).toEqual([
      { name: '/mnt/x', folder: '' }, { name: 'night', folder: '/mnt/x/night' }, { name: 'cam0', folder: '/mnt/x/night/cam0' },
    ]);
    expect(folder_breadcrumb('/mnt/x', '/mnt/x')).toEqual([{ name: '/mnt/x', folder: '' }]);
    expect(folder_breadcrumb('', '/data/a')).toEqual([{ name: '/', folder: '' }, { name: 'data', folder: '/data' }, { name: 'a', folder: '/data/a' }]);
    expect(folder_breadcrumb('', '')).toEqual([{ name: 'All folders', folder: '' }]);
    // a relative folder from an older link
    expect(folder_breadcrumb('/mnt/x', 'night')).toEqual([{ name: '/mnt/x', folder: '' }, { name: 'night', folder: 'night' }]);
    expect(full_path({ database: '/data/', path: '/night/a.png' })).toBe('/data/night/a.png');
    expect(full_path({ database: '.', path: 'a.png' })).toBe('a.png');
    expect(full_path({ full_path: '/x/a.png', database: '/y', path: 'a.png' })).toBe('/x/a.png');
    expect(folder_from('/data/x/night/cam0/1.png', '/data/x')).toBe('night/cam0');
    expect(folder_from('/data/x/1.png', '/data/x')).toBe('');
    expect(folder_from('/data/x/1.png', '')).toBe('data/x');
  });

  test('metadata filters', () => {
    expect(toggle_meta({}, 'weather', 'rain')).toEqual({ weather: ['rain'] });
    expect(toggle_meta({ weather: ['rain'] }, 'weather', 'snow')).toEqual({ weather: ['rain', 'snow'] });
    expect(toggle_meta({ weather: ['rain'] }, 'weather', 'rain')).toEqual({});
    expect(stringify_meta({})).toBe('');
    expect(stringify_meta({ iso: ['800'] })).toBe('{"iso":["800"]}');
    expect(describe_filters({ meta: { weather: ['rain', 'snow'] }, live: false })).toEqual(['weather rain or snow']);
  });

  test('metadata ranges', () => {
    expect(parse_meta('{"iso": {"min": 200, "max": 800}, "lux": {"min": "a", "max": 2}, "x": {"min": null}, "w": ["rain"]}'))
      .toEqual({ iso: { min: 200, max: 800 }, lux: { min: null, max: 2 }, w: ['rain'] });
    expect(set_meta_range({ w: ['rain'] }, 'iso', { min: 200 })).toEqual({ w: ['rain'], iso: { min: 200, max: null } });
    expect(set_meta_range({ iso: { min: 200, max: null } }, 'iso', null)).toEqual({});
    // ticking a value replaces the range
    expect(toggle_meta({ iso: { min: 200, max: 800 } }, 'iso', '100')).toEqual({ iso: ['100'] });
    expect(stringify_meta({ iso: { min: 200, max: null } })).toBe('{"iso":{"min":200,"max":null}}');
    expect(describe_meta('iso', { min: 200, max: 800 })).toBe('iso 200 to 800');
    expect(describe_meta('iso', { min: 200, max: null })).toBe('iso ≥ 200');
    expect(describe_meta('iso', { min: null, max: 1600 })).toBe('iso ≤ 1,600');
    expect(describe_meta('iso', { min: 800, max: 800 })).toBe('iso 800');
    expect(describe_filters({ meta: { lux: { min: 0.00123, max: 2.456 } }, live: false })).toEqual(['lux 0.00123 to 2.46']);
    expect(format_number(0)).toBe('0');
    // numbers with a few values are ticked, a filter in the URL wins
    const iso = { key: 'iso', type: 'number', distinct: 6, histogram: [{ start: 100, end: 255, count: 3 }], values: [] };
    expect(facet_kind(iso, undefined)).toBe('range');
    expect(facet_kind(iso, ['800'])).toBe('values');
    expect(facet_kind({ ...iso, distinct: 3 }, undefined)).toBe('values');
    expect(facet_kind({ ...iso, distinct: 3 }, { min: 1, max: null })).toBe('range');
    expect(facet_kind({ ...iso, type: 'string' }, undefined)).toBe('values');
  });

  test('names, like the server normalizes them', () => {
    expect(normalize_name(' night / hard  cases ')).toBe('night/hard cases');
    expect(name_problem('')).toMatch(/Give the collection a name/);
    expect(name_problem('night/hard-cases_2.v1')).toBeNull();
    expect(name_problem('night:hard?')).toMatch(/not “:” “\?”/);
    expect(name_problem('a'.repeat(201))).toMatch(/at most 200/);
  });

  test('references', () => {
    expect(collection_ref(collection())).toBe('night/hard-cases');
    expect(collection_ref(collection(), 2)).toBe('night/hard-cases@2');
    expect(collection_ref(collection({ ref: undefined, inherited: true, project: 'a' }), 'latest')).toBe('a:night/hard-cases@latest');
    expect(parse_ref('a/b:night/hard@2')).toEqual({ project: 'a/b', name: 'night/hard', version: 2 });
    expect(parse_ref('night/hard')).toEqual({ project: null, name: 'night/hard', version: null });
    expect(parse_ref('night/hard@latest').version).toBe('latest');
    expect(collection_path('a/b', collection(), 2)).toBe('/a/b/collections/7?version=2');
    expect(inputs_path('p', { add_to: 7, q: '' })).toBe('/p/inputs?add_to=7');
  });

  test('code to copy', () => {
    expect(python_snippet('night/hard-cases@2')).toBe([
      'from qaboard import collections', '', 'collection = collections.get("night/hard-cases@2")', 'print(collection.version, len(collection))',
      'for item in collection:', '    print(item.absolute_path)  # item.database / item.path',
    ].join('\n'));
    // objects, not tuples: they will say more about each input
    expect(python_snippet('night/hard-cases@2')).not.toContain('for database, path');
    // collections have their own key, next to `inputs`
    expect(yaml_snippet('night/hard-cases@2', 'night/Hard Cases')).toBe([
      'hard-cases:', '  configurations: [base]', '  collections:', '    - night/hard-cases@2',
    ].join('\n'));
    expect(batch_name('a/!!!')).toBe('collection');
  });

  test('the next version: removed inputs go, added ones come once, at the end', () => {
    expect(next_members([1, 2, 3], { removed: [2], added: [3, 4, 4, 5] })).toEqual([1, 3, 4, 5]);
  });

  test('pinned, favorites, groups, then the ancestors', () => {
    const list = [
      collection({ id: 1, name: 'night/b' }),
      collection({ id: 2, name: 'night/a', favorite: true }),
      collection({ id: 3, name: 'ci', pinned_for: [{ id: null, name: null }], pinned: true }),
      collection({ id: 4, name: 'calib', project: 'parent', inherited: true }),
    ];
    const { pinned, favorites, own, ancestors } = organize_collections(list, 'p');
    expect(pinned.map(c => c.id)).toEqual([3]);
    expect(favorites.map(c => c.id)).toEqual([2]);
    expect(own.map(c => c.id)).toEqual([3, 2, 1]);
    expect(ancestors).toEqual([{ project: 'parent', collections: [list[3]] }]);
    const tree = collections_tree(own, 'x');
    expect(tree.collections.map(c => c.name)).toEqual(['ci']);
    expect(tree.groups[0]).toMatchObject({ name: 'night', path: 'x/night', count: 2 });
    expect(tree.groups[0].collections.map(c => c.name)).toEqual(['night/a', 'night/b']);
    expect(pin_key({ id: null })).toBe('everyone');
    expect(pin_key(null)).toBe('everyone');
    expect(pin_label({ id: 3, name: 'af-team' })).toBe('af-team');
    expect(is_pinned_for(list[2], null)).toBe(true);
  });

  test('inputs', () => {
    // the project it's seen from: the server checks it sees the input
    expect(thumbnail_url('p', input(1))).toBe('/api/v1/inputs/1/thumbnail?project=p');
    expect(thumbnail_url('group/repo', input(1), 1024)).toBe('/api/v1/inputs/1/thumbnail?project=group%2Frepo&size=1024');
    expect(input_file_url('group/repo', input(1))).toBe('/api/v1/inputs/1/file?project=group%2Frepo');
    expect(is_browser_image('a/b.JPG')).toBe(true);
    expect(is_browser_image('a/b.raw')).toBe(false);
    expect(input_name({ id: 3, path: 'a\\b\\c.png' })).toBe('c.png');
    expect(database_label('/data/indoor/2024')).toBe('indoor/2024');
    expect(run_location('a/b', { commit: 'abc', batch: 'nightly' }, { path: 'x/y.raw' })).toBe('/a/b/commit/abc?batch=nightly&filter=x%2Fy.raw');
  });
});


describe('selecting in the grid', () => {
  const loaded = [input(1), input(2), undefined, input(4), input(5)];
  const item_at = i => loaded[i];
  const ids = state => [...state.selected.keys()];

  test('click, ctrl+click, shift+click, ctrl+shift+click', () => {
    let state = click_selection(empty_selection, 0, item_at);
    expect(ids(state)).toEqual([1]);
    state = click_selection(state, 1, item_at, { toggle: true });
    expect(ids(state)).toEqual([1, 2]);
    state = click_selection(state, 1, item_at, { toggle: true });
    expect(ids(state)).toEqual([1]);
    expect(state.anchor).toBe(1);
    // the range skips what isn't loaded
    state = click_selection(click_selection(empty_selection, 0, item_at), 4, item_at, { shift: true });
    expect(ids(state)).toEqual([1, 2, 4, 5]);
    // shift moves the end, not the anchor
    state = click_selection(state, 1, item_at, { shift: true });
    expect(ids(state)).toEqual([1, 2]);
    state = click_selection(click_selection(empty_selection, 4, item_at), 3, item_at, { toggle: true });
    expect(ids(state).sort()).toEqual([4, 5]);
    // ctrl+shift+click adds the range to what was selected
    state = click_selection({ ...state, anchor: 0 }, 1, item_at, { shift: true, toggle: true });
    expect(ids(state).sort()).toEqual([1, 2, 4, 5]);
    expect(click_selection(state, 2, item_at)).toBe(state);
    expect(ids(toggle_selection(state, 0, item_at)).sort()).toEqual([2, 4, 5]);
    expect(ids(select_all(5, item_at))).toEqual([1, 2, 4, 5]);
  });

  test('every matching input, loaded or not', () => {
    const matching = { key: 'k', filters: { q: 'night', live: true } };
    const state = select_matching([9, 1, 2, 7], new Map([[1, input(1)]]), matching);
    // the server's order; those not loaded are known by their id
    expect(ids(state)).toEqual([9, 1, 2, 7]);
    expect(state.matching).toEqual({ ...matching, count: 4 });
    expect(selected_inputs(state, new Map([[2, input(2)]])).map(i => i.id)).toEqual([1, 2]);
    // ctrl+click keeps where the selection came from, a click starts another one
    const toggled = toggle_selection(state, 0, item_at);
    expect(ids(toggled)).toEqual([9, 2, 7]);
    expect(toggled.matching.count).toBe(4);
    expect(click_selection(state, 1, item_at).matching).toBeUndefined();
  });

  test('arrows move in rows and columns', () => {
    expect(move_focus(5, 'ArrowRight', { count: 10, columns: 4 })).toBe(6);
    expect(move_focus(5, 'ArrowDown', { count: 10, columns: 4 })).toBe(9);
    expect(move_focus(8, 'ArrowDown', { count: 10, columns: 4 })).toBe(9);
    expect(move_focus(1, 'ArrowUp', { count: 10, columns: 4 })).toBe(0);
    expect(move_focus(3, 'End', { count: 10, columns: 4 })).toBe(9);
    expect(move_focus(3, 'x', { count: 10, columns: 4 })).toBeNull();
  });

  test('as many columns as fit', () => {
    expect(grid_layout(1000).columns).toBe(5);
    expect(grid_layout(100).columns).toBe(1);
  });
});


const inputs_answer = (list = inputs, fields = {}) => ({
  inputs: list, total: list.length, databases: [{ database: '/data/captures', count: 6 }, { database: '/data/lab', count: 2 }],
  root: '/data', location: '/data/captures/night', here: 0,
  folders: [{ folder: '/data/captures/night/street', name: 'street', count: 6 }],
  metadata: [{ key: 'weather', count: 6, distinct: 2, values: [{ value: 'rain', count: 4 }, { value: 'snow', count: 2 }] }], ...fields,
});

// The first page of `total` matching inputs, the ids of all of them with fields=id
const matching_api = (total, { too_many = false } = {}) => (url) => {
  const params = new URL(url, 'http://x').searchParams;
  if (params.get('fields') === 'id') return [200, too_many ? { ids: [], total: null, too_many: true, max: 50000 } : { ids: Array.from({ length: total }, (_, i) => i + 1), total, too_many: false, max: 50000 }];
  return [200, params.get('offset') === '0' ? inputs_answer(inputs, { total }) : { inputs: [], total: null }];
};

describe('the Inputs page', () => {
  test('select all matching, beyond those loaded, then save them with where they came from', async () => {
    const calls = stubApi({
      'GET /api/v1/inputs?': matching_api(450),
      'GET /api/v1/collections': { collections: [] },
      'POST /api/v1/collections': () => [201, collection({ id: 9, name: 'night/all', latest_version: 1 })],
    });
    renderAt('inputs', '/p/inputs?folder=night&q=street', <InputsPage/>);
    const tile = await screen.findByRole('gridcell', { name: 'IMG_0001.raw' });
    // the thumbnails say the project they're seen from: the server checks it sees the input
    expect(tile.querySelector('img')).toHaveAttribute('src', '/api/v1/inputs/1/thumbnail?project=p');
    fireEvent.click(screen.getByRole('button', { name: /^Select the \d+ shown$/ }));
    const banner = await screen.findByText('All 6 loaded inputs are selected.');
    fireEvent.click(within(banner.parentElement).getByRole('button', { name: 'Select all 450 matching' }));
    expect(await screen.findByText(/matching inputs are selected/)).toBeInTheDocument();
    const ids_call = calls.find(c => c.url.includes('fields=id'));
    expect(ids_call.url).toContain('folder=night');
    expect(ids_call.url).toContain('q=street');
    const bar = screen.getByRole('region', { name: 'Selection' });
    expect(within(bar).getByText('450 inputs selected')).toBeInTheDocument();
    // their paths aren't all loaded
    expect(within(bar).getByRole('button', { name: 'Copy paths' })).toHaveAttribute('aria-disabled', 'true');

    fireEvent.click(within(bar).getByRole('button', { name: 'Save as collection' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('450')).toBeInTheDocument();
    const notes = 'From Inputs: search "street", folder night, hiding inputs whose runs were deleted — 450 inputs';
    expect(within(dialog).getByLabelText(/Notes for version 1/)).toHaveValue(notes);
    fireEvent.change(within(dialog).getByLabelText('Collection name'), { target: { value: 'night/all' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save collection' }));
    await waitFor(() => expect(calls.some(c => c.method === 'POST')).toBe(true));
    const body = calls.find(c => c.method === 'POST').body;
    expect(body.inputs).toEqual(Array.from({ length: 450 }, (_, i) => i + 1));
    expect(body.notes).toBe(notes);
    await waitFor(() => expect(toaster.show).toHaveBeenCalled());
    expect(vi.mocked(toaster.show).mock.calls.at(-1)[0].action.text).toBe('Open collection');
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Selection' })).not.toBeInTheDocument());
  });

  test('a ctrl+click after selecting all matching unselects one, Escape clears', async () => {
    stubApi({ 'GET /api/v1/inputs?': matching_api(450), 'GET /api/v1/collections': { collections: [] } });
    renderAt('inputs', '/p/inputs', <InputsPage/>);
    await screen.findByRole('gridcell', { name: 'IMG_0001.raw' });
    fireEvent.click(screen.getAllByRole('button', { name: 'Select all 450 matching' })[0]);
    const bar = await screen.findByRole('region', { name: 'Selection' });
    await waitFor(() => expect(within(bar).getByText('450 inputs selected')).toBeInTheDocument());
    fireEvent.click(screen.getByRole('gridcell', { name: 'IMG_0002.raw' }), { ctrlKey: true });
    expect(within(bar).getByText('449 inputs selected')).toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('grid'), { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Selection' })).not.toBeInTheDocument());
  });

  test('filters that match more than a collection holds ask to narrow them', async () => {
    const calls = stubApi({ 'GET /api/v1/inputs?': matching_api(60000), 'GET /api/v1/collections': { collections: [] } });
    renderAt('inputs', '/p/inputs', <InputsPage/>);
    await screen.findByRole('gridcell', { name: 'IMG_0001.raw' });
    expect(screen.getByRole('button', { name: 'Select all 60,000 matching' })).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(screen.getByRole('button', { name: /^Select the \d+ shown$/ }));
    expect(await screen.findByText(/more than a collection holds \(50,000\): narrow them/)).toBeInTheDocument();
    expect(calls.some(c => c.url.includes('fields=id'))).toBe(false);
  });

  test('the server may say there are too many after all', async () => {
    stubApi({ 'GET /api/v1/inputs?': matching_api(450, { too_many: true }), 'GET /api/v1/collections': { collections: [] } });
    renderAt('inputs', '/p/inputs', <InputsPage/>);
    await screen.findByRole('gridcell', { name: 'IMG_0001.raw' });
    fireEvent.click(screen.getAllByRole('button', { name: 'Select all 450 matching' })[0]);
    await waitFor(() => expect(toaster.show).toHaveBeenCalledWith(expect.objectContaining({ intent: 'warning' })));
    expect(screen.queryByRole('region', { name: 'Selection' })).not.toBeInTheDocument();
  });

  test('selecting everything when all are loaded says so in the notes', async () => {
    const calls = stubApi({
      'GET /api/v1/inputs?': inputs_answer(),
      'GET /api/v1/collections': { collections: [] },
      'POST /api/v1/collections': () => [201, collection({ id: 9, name: 'all', latest_version: 1 })],
    });
    renderAt('inputs', '/p/inputs?live=0', <InputsPage/>);
    await screen.findByRole('gridcell', { name: 'IMG_0001.raw' });
    // nothing more to load: no "matching" button
    expect(screen.queryByRole('button', { name: /matching/ })).not.toBeInTheDocument();
    fireEvent.keyDown(screen.getByRole('grid'), { key: 'a', ctrlKey: true });
    fireEvent.click(within(screen.getByRole('region', { name: 'Selection' })).getByRole('button', { name: 'Save as collection' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByLabelText(/Notes for version 1/)).toHaveValue('From Inputs: all inputs — 6 inputs');
    expect(calls.some(c => c.url.includes('fields=id'))).toBe(false);
  });

  test('lists the inputs, filters by folder, metadata and search in the URL', async () => {
    const calls = stubApi({ 'GET /api/v1/inputs?': inputs_answer(), 'GET /api/v1/collections': { collections: [] } });
    renderAt('inputs', '/p/inputs?folder=%2Fdata%2Fcaptures%2Fnight', <InputsPage/>);
    expect(await screen.findByRole('gridcell', { name: 'IMG_0001.raw' })).toBeInTheDocument();
    expect(calls.find(c => c.url.startsWith('/api/v1/inputs?')).url).toContain('folder=%2Fdata%2Fcaptures%2Fnight');

    // from the folder every input is in, by its full path
    const folders = screen.getByRole('navigation', { name: 'Folders' });
    expect(within(folders).getByText('night')).toHaveAttribute('aria-current', 'location');
    fireEvent.click(within(folders).getByRole('button', { name: /street/ }));
    await waitFor(() => expect(query_of().folder).toBe('/data/captures/night/street'));
    fireEvent.click(await within(screen.getByRole('navigation', { name: 'Folders' })).findByRole('button', { name: 'captures' }));
    await waitFor(() => expect(query_of().folder).toBe('/data/captures'));
    fireEvent.click(await within(screen.getByRole('navigation', { name: 'Folders' })).findByRole('button', { name: '/data' }));
    await waitFor(() => expect(query_of().folder).toBeUndefined());
    // where each input is, from the folder shown
    expect(await screen.findByRole('gridcell', { name: 'IMG_0001.raw' })).toHaveTextContent('street');

    fireEvent.click(within(screen.getByRole('region', { name: 'Metadata' })).getByRole('checkbox', { name: /rain/ }));
    await waitFor(() => expect(JSON.parse(query_of().meta)).toEqual({ weather: ['rain'] }));
    fireEvent.click(await within(await screen.findByRole('region', { name: 'Metadata' })).findByRole('checkbox', { name: /snow/ }));
    await waitFor(() => expect(JSON.parse(query_of().meta)).toEqual({ weather: ['rain', 'snow'] }));

    fireEvent.click(screen.getByRole('switch', { name: 'Hide inputs whose runs were deleted' }));
    await waitFor(() => expect(query_of().live).toBe('0'));

    fireEvent.change(screen.getByRole('searchbox', { name: 'Search inputs' }), { target: { value: 'IMG_0001' } });
    await waitFor(() => expect(query_of().q).toBe('IMG_0001'));
  });

  test('metadata: numbers as a range over their histogram, true/false, a search in many values', async () => {
    const histogram = [{ start: 100, end: 255, count: 3 }, { start: 255, end: 410, count: 0 }, { start: 410, end: 565, count: 2 }];
    const metadata = [
      { key: 'iso', count: 5, distinct: 6, type: 'number', min: 100, max: 565, integers: true, histogram, values: [{ value: '100', count: 3 }] },
      { key: 'hdr', count: 6, distinct: 2, type: 'boolean', values: [{ value: 'false', count: 4 }, { value: 'true', count: 2 }] },
      { key: 'scene', count: 6, distinct: 240, type: 'string', values: Array.from({ length: 20 }, (_, i) => ({ value: `street-${i}`, count: 1 })) },
    ];
    const calls = stubApi({
      'GET /api/v1/inputs/metadata-values': { key: 'scene', count: 1, distinct: 1, type: 'string', values: [{ value: 'tunnel-015', count: 16 }] },
      'GET /api/v1/inputs?': inputs_answer(inputs, { metadata }),
      'GET /api/v1/collections': { collections: [] },
    });
    renderAt('inputs', '/p/inputs', <InputsPage/>);
    const region = await screen.findByRole('region', { name: 'Metadata' });
    // a bin of the histogram: its range
    fireEvent.click(await within(region).findByRole('button', { name: '100 to 255: 3 inputs' }));
    await waitFor(() => expect(JSON.parse(query_of().meta)).toEqual({ iso: { min: 100, max: 255 } }));
    expect(await screen.findByText('iso 100 to 255')).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Clear the range of iso' }));
    await waitFor(() => expect(query_of().meta).toBeUndefined());
    // typed bounds, the other left open
    const at_least = await within(screen.getByRole('region', { name: 'Metadata' })).findByRole('textbox', { name: 'iso at least' });
    fireEvent.change(at_least, { target: { value: '200' } });
    fireEvent.blur(at_least);
    await waitFor(() => expect(JSON.parse(query_of().meta)).toEqual({ iso: { min: 200, max: null } }));
    expect(calls.at(-1).url).toContain(`meta=${encodeURIComponent('{"iso":{"min":200,"max":null}}')}`);

    // true/false
    expect(await within(await screen.findByRole('region', { name: 'Metadata' })).findByRole('checkbox', { name: /True/ })).toBeInTheDocument();

    // more values than listed: a search on the server, with the page's filters
    fireEvent.click(within(await screen.findByRole('region', { name: 'Metadata' })).getByRole('button', { name: /^scene/ }));
    fireEvent.change(await screen.findByRole('searchbox', { name: 'Search the values of scene' }), { target: { value: 'tunnel' } });
    fireEvent.click(await screen.findByRole('checkbox', { name: /tunnel-015/ }));
    const search = calls.find(c => c.url.startsWith('/api/v1/inputs/metadata-values'));
    expect(search.url).toContain('key=scene');
    expect(search.url).toContain('search=tunnel');
    expect(search.url).toContain(`meta=${encodeURIComponent('{"iso":{"min":200,"max":null}}')}`);
    await waitFor(() => expect(JSON.parse(query_of().meta)).toEqual({ iso: { min: 200, max: null }, scene: ['tunnel-015'] }));
  });

  test('many folders: a filter, the metadata still in view', async () => {
    const folders = Array.from({ length: 40 }, (_, i) => ({ folder: `/data/captures/night/drive_${String(i).padStart(3, '0')}`, name: `drive_${String(i).padStart(3, '0')}`, count: 3 }));
    stubApi({ 'GET /api/v1/inputs?': inputs_answer(inputs, { folders }), 'GET /api/v1/collections': { collections: [] } });
    renderAt('inputs', '/p/inputs', <InputsPage/>);
    const nav = await screen.findByRole('navigation', { name: 'Folders' });
    await within(nav).findByRole('button', { name: /drive_039/ });
    fireEvent.change(within(nav).getByRole('searchbox', { name: 'Filter the folders' }), { target: { value: '_01' } });
    expect(within(nav).getAllByRole('button', { name: /drive_/ })).toHaveLength(10);
    expect(screen.getByRole('region', { name: 'Metadata' })).toBeInTheDocument();
  });

  test('select inputs, then save them as a collection', async () => {
    const calls = stubApi({
      'GET /api/v1/inputs?': inputs_answer(),
      'GET /api/v1/collections': { collections: [] },
      'POST /api/v1/collections': () => [201, collection({ id: 9, name: 'night/hard', latest_version: 1 })],
    });
    renderAt('inputs', '/p/inputs', <InputsPage/>);
    fireEvent.click(await screen.findByRole('gridcell', { name: 'IMG_0001.raw' }));
    fireEvent.click(screen.getByRole('gridcell', { name: 'IMG_0003.raw' }), { shiftKey: true });
    const bar = screen.getByRole('region', { name: 'Selection' });
    expect(within(bar).getByText('3 inputs selected')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('gridcell', { name: 'IMG_0002.raw' }), { ctrlKey: true });
    expect(within(bar).getByText('2 inputs selected')).toBeInTheDocument();

    fireEvent.click(within(bar).getByRole('button', { name: 'Save as collection' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('p:')).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('Collection name'), { target: { value: ' night / hard ' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save collection' }));
    await waitFor(() => expect(calls.some(c => c.method === 'POST')).toBe(true));
    // personal by default, like milestones
    expect(calls.find(c => c.method === 'POST').body).toEqual({ project: 'p', name: 'night/hard', inputs: [1, 3], notes: 'From Inputs, picked by hand: hiding inputs whose runs were deleted — 2 inputs', shared: false });
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Selection' })).not.toBeInTheDocument());
  });

  test('developers share a collection with the project when they save it, others make personal ones', async () => {
    const calls = stubApi({
      'GET /api/v1/inputs?': inputs_answer(),
      'GET /api/v1/collections': { collections: [], can_create: true, can_share: true },
      'POST /api/v1/collections': () => [201, collection({ id: 9, name: 'night/hard', latest_version: 1, shared: true })],
    });
    renderAt('inputs', '/p/inputs', <InputsPage/>);
    fireEvent.click(await screen.findByRole('gridcell', { name: 'IMG_0001.raw' }));
    fireEvent.click(within(screen.getByRole('region', { name: 'Selection' })).getByRole('button', { name: 'Save as collection' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(within(dialog).getByLabelText('Collection name'), { target: { value: 'night/hard' } });
    fireEvent.click(within(dialog).getByRole('radio', { name: 'Everyone on the project' }));
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save collection' }));
    await waitFor(() => expect(calls.find(c => c.method === 'POST')?.body?.shared).toBe(true));
  });

  test('users who can\'t create collections (signed out) see why', async () => {
    stubApi({ 'GET /api/v1/inputs?': inputs_answer(), 'GET /api/v1/collections': { collections: [], can_create: false } });
    renderAt('inputs', '/p/inputs', <InputsPage/>);
    fireEvent.click(await screen.findByRole('gridcell', { name: 'IMG_0001.raw' }));
    const bar = screen.getByRole('region', { name: 'Selection' });
    await waitFor(() => expect(within(bar).getByRole('button', { name: 'Save as collection' })).toHaveAttribute('aria-disabled', 'true'));
    expect(within(bar).getByRole('button', { name: 'Add to collection…' })).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(within(bar).getByRole('button', { name: 'Save as collection' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    fireEvent.mouseEnter(within(bar).getByRole('button', { name: 'Save as collection' }));
    expect(await screen.findByText(/Sign in to save collections/)).toBeInTheDocument();
    // copying paths needs nothing: their full path
    fireEvent.click(within(bar).getByRole('button', { name: 'Copy path' }));
    expect(copyWithToast).toHaveBeenCalledWith('/data/captures/night/street/IMG_0001.raw', { what: 'the path' });
  });

  test('the keyboard: arrows, shift, space, Enter opens the viewer, Escape closes it', async () => {
    stubApi({ 'GET /api/v1/inputs?': inputs_answer(), 'GET /api/v1/inputs/2': { ...input(2), runs: [] }, 'GET /api/v1/collections': { collections: [] } });
    renderAt('inputs', '/p/inputs', <InputsPage/>);
    const first = await screen.findByRole('gridcell', { name: 'IMG_0001.raw' });
    const grid = screen.getByRole('grid');
    fireEvent.click(first);
    fireEvent.keyDown(grid, { key: 'ArrowRight', shiftKey: true });
    expect(screen.getByText('2 inputs selected')).toBeInTheDocument();
    fireEvent.keyDown(grid, { key: ' ' });
    expect(screen.getByText('1 input selected')).toBeInTheDocument();
    fireEvent.keyDown(grid, { key: 'Enter' });
    await waitFor(() => expect(query_of().input).toBe('2'));
    const viewer = await screen.findByRole('dialog', { name: 'IMG_0002.raw, 2 of 6' });
    expect(viewer).toBeInTheDocument();
    fireEvent.keyDown(window, { key: 'ArrowRight' });
    await waitFor(() => expect(query_of().input).toBe('3'));
    fireEvent.click(screen.getByRole('button', { name: 'Close the viewer' }));
    await waitFor(() => expect(query_of().input).toBeUndefined());
  });

  test('says when nothing matches, and how to see more', async () => {
    stubApi({ 'GET /api/v1/inputs?': inputs_answer([]), 'GET /api/v1/collections': { collections: [] } });
    renderAt('inputs', '/p/inputs?q=nothing', <InputsPage/>);
    expect(await screen.findByText('No inputs match')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show inputs whose runs were deleted' }));
    await waitFor(() => expect(query_of().live).toBe('0'));
    fireEvent.click(await screen.findByRole('button', { name: 'Clear the filters' }));
    await waitFor(() => expect(query_of().q).toBeUndefined());
  });

  test('errors say what happened', async () => {
    stubApi({ 'GET /api/v1/inputs?': () => [500, { error: 'The database is down' }], 'GET /api/v1/collections': { collections: [] } });
    renderAt('inputs', '/p/inputs', <InputsPage/>);
    expect(await screen.findByText('The database is down')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });
});


describe('the save dialog', () => {
  test('a name that exists: open it, or add the inputs to it', async () => {
    const existing = collection({ id: 4, name: 'night/hard', latest_version: 2 });
    const calls = stubApi({
      'POST /api/v1/collections/4/versions': () => [201, { ...existing, latest_version: 3 }],
      'POST /api/v1/collections': () => [409, { error: 'name_taken', id: 4 }],
      'GET /api/v1/collections/4/inputs': { inputs: [input(1)], total: 1 },
      'GET /api/v1/collections': { collections: [existing] },
    });
    const onClose = vi.fn();
    renderAt('inputs', '/p/inputs', <SaveCollectionDialog project="p" inputs={[input(1), input(2)]} isOpen onClose={onClose}/>);
    expect([...document.querySelectorAll('.qa-strip-thumb img')].map(img => img.getAttribute('src'))).toEqual(['/api/v1/inputs/1/thumbnail?project=p', '/api/v1/inputs/2/thumbnail?project=p']);
    fireEvent.change(screen.getByLabelText('Collection name'), { target: { value: 'night/hard' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save collection' }));
    expect(await screen.findByText('night / hard already exists')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open it' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add the 2 inputs to it' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(calls.find(c => c.url === '/api/v1/collections/4/versions').body).toEqual({ inputs: [1, 2], base_version: 2, notes: 'Added 1 input' });
  });

  test('adding says how many are already in the collection', async () => {
    const target = collection({ id: 4, name: 'night/hard', latest_version: 2, size: 2 });
    const calls = stubApi({
      'POST /api/v1/collections/4/versions': () => [201, { ...target, latest_version: 3 }],
      'GET /api/v1/collections/4/inputs': { inputs: [input(1), input(2)], total: 2 },
      'GET /api/v1/collections/4': target,
      'GET /api/v1/collections': { collections: [target] },
    });
    const onClose = vi.fn();
    // ids without every Input loaded: after "Select all matching"
    renderAt('inputs', '/p/inputs', <AddToCollectionDialog project="p" ids={[1, 2, 3, 4]} inputs={[input(1)]} notes='From Inputs: folder night — 4 inputs' isOpen onClose={onClose} initial={4}/>);
    expect(await screen.findByText(/2 already in it, 2 will be added/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save version 3' }));
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    // the notes say how many were added, then where they came from
    expect(calls.find(c => c.url === '/api/v1/collections/4/versions').body).toEqual({ inputs: [1, 2, 3, 4], base_version: 2, notes: 'Added 2 inputs. From Inputs: folder night — 4 inputs' });
    expect(vi.mocked(toaster.show).mock.calls.at(-1)[0].action.text).toBe('Open collection');
  });

  test('adding inputs that are all in it already: nothing to save', async () => {
    const target = collection({ id: 4, name: 'night/hard', latest_version: 2, size: 2 });
    stubApi({ 'GET /api/v1/collections/4/inputs': { inputs: [input(1), input(2)], total: 2 }, 'GET /api/v1/collections': { collections: [target] } });
    renderAt('inputs', '/p/inputs', <AddToCollectionDialog project="p" ids={[2, 1]} isOpen onClose={() => {}} initial={4}/>);
    expect(await screen.findByText(/All 2 are already in it/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save version 3' })).toBeDisabled();
  });

  test("names the server wouldn't take are explained before saving", async () => {
    const calls = stubApi({ 'GET /api/v1/collections': { collections: [] } });
    renderAt('inputs', '/p/inputs', <SaveCollectionDialog project="p" inputs={[input(1)]} isOpen onClose={() => {}}/>);
    fireEvent.change(screen.getByLabelText('Collection name'), { target: { value: 'what?' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save collection' }));
    expect(await screen.findByText(/not “\?”/)).toBeInTheDocument();
    expect(calls.some(c => c.method === 'POST')).toBe(false);
  });
});


const versions = [
  { version: 2, created_by: { user_name: 'bob', full_name: 'Bob B' }, created_at: '2026-11-02T10:00:00Z', notes: 'Removed blurry ones', size: 3 },
  { version: 1, created_by: { user_name: 'alice', full_name: 'Alice A' }, created_at: '2026-11-01T10:00:00Z', notes: '', size: 4 },
];
const collection_answer = (fields = {}) => ({ ...collection(), version: versions[0], versions, ...fields });

describe('a collection', () => {
  test('its header, versions, inputs, and how to use it', async () => {
    stubApi({
      'GET /api/v1/collections/7/inputs': { inputs: inputs.slice(0, 3), total: 3 },
      'GET /api/v1/collections/7': collection_answer(),
      'GET /api/v1/collections': { collections: [collection()] },
    });
    renderAt('collection', '/p/collections/7', <CollectionPage/>);
    expect(await screen.findByRole('heading', { name: /^night ?\/ ?hard-cases$/ })).toBeInTheDocument();
    // back to the Collections, not the Inputs: they're two pages
    const breadcrumb = screen.getByRole('navigation', { name: 'Breadcrumb' });
    expect(within(breadcrumb).getByRole('link', { name: /Collections/ })).toHaveAttribute('href', '/p/collections');
    expect(within(breadcrumb).queryByRole('link', { name: /Inputs/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Version 2, the latest: pick another' })).toBeInTheDocument();
    expect(screen.getByText('Hard night scenes')).toBeInTheDocument();
    const tile = await screen.findByRole('gridcell', { name: 'IMG_0003.raw' });
    expect(tile.querySelector('img')).toHaveAttribute('src', '/api/v1/inputs/3/thumbnail?project=p');
    expect(screen.getByText('Removed blurry ones')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: /Python/ }));
    await waitFor(() => expect(query_of().tab).toBe('python'));
    expect(screen.getByLabelText('Python')).toHaveTextContent('collections.get("night/hard-cases@2")');
    expect(screen.getByLabelText('Python')).toHaveTextContent('for item in collection:');
    expect(screen.getByLabelText('Python')).toHaveTextContent('item.absolute_path');
    fireEvent.click(screen.getByRole('radio', { name: /The latest/ }));
    expect(screen.getByLabelText('Python')).toHaveTextContent('collections.get("night/hard-cases")');

    fireEvent.click(screen.getByRole('tab', { name: /Batch file/ }));
    expect(screen.getByLabelText('qa/batches.yaml')).toHaveTextContent('collections: - night/hard-cases@2');
    fireEvent.click(screen.getByRole('button', { name: 'Copy the YAML' }));
    expect(copyWithToast).toHaveBeenCalledWith(expect.stringContaining('  collections:\n    - night/hard-cases@2'), { what: 'the YAML' });
  });

  test('favorite', async () => {
    const calls = stubApi({
      'GET /api/v1/collections/7/inputs': { inputs: [], total: 0 },
      'GET /api/v1/collections/7': collection_answer(),
      'GET /api/v1/collections': { collections: [collection()] },
      'PUT /api/v1/collections/7/favorite': { id: 7, favorite: true },
    });
    renderAt('collection', '/p/collections/7', <CollectionPage/>);
    fireEvent.click(await screen.findByRole('button', { name: 'Add to favorites' }));
    expect(await screen.findByRole('button', { name: 'Favorite' })).toHaveAttribute('aria-pressed', 'true');
    expect(calls.find(c => c.method === 'PUT').url).toBe('/api/v1/collections/7/favorite?project=p');
    expect(screen.getByText('This version has no inputs')).toBeInTheDocument();
  });

  test('a personal collection: no pins, its creator shares it', async () => {
    let shared = false;
    const calls = stubApi({
      'GET /api/v1/collections/7/inputs': { inputs: [], total: 0 },
      'GET /api/v1/collections/7': () => [200, collection_answer({ shared, mine: true })],
      'GET /api/v1/collections': () => [200, { collections: [collection({ shared, mine: true })] }],
      'PATCH /api/v1/collections/7': () => { shared = true; return [200, collection_answer({ shared, mine: true })]; },
    });
    renderAt('collection', '/p/collections/7', <CollectionPage/>);
    expect(await screen.findByText('personal')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pin' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Share with the project' }));
    await waitFor(() => expect(calls.find(c => c.method === 'PATCH')?.body).toEqual({ shared: true }));
    await waitFor(() => expect(screen.queryByText('personal')).not.toBeInTheDocument());
  });

  test("pinning for everyone follows the collection's project, not the viewed one", async () => {
    // an ancestor's collection seen from p, whose owners can pin for everyone in p but not in the ancestor
    stubApi({
      'GET /api/v1/collections/7/inputs': { inputs: [], total: 0 },
      'GET /api/v1/collections/7': collection_answer({ project: 'group', inherited: true, can_pin_everyone: false }),
      'GET /api/v1/collections': { collections: [collection()], can_pin_everyone: true, my_groups: [] },
    });
    renderAt('collection', '/p/collections/7', <CollectionPage/>);
    fireEvent.click(await screen.findByRole('button', { name: 'Pin' }));
    const everyone_item = await screen.findByRole('menuitem', { name: /Everyone on the project/ });
    expect(everyone_item).toHaveAttribute('aria-disabled', 'true');
  });

  test('edit: remove inputs, save the next version; someone saved meanwhile: save anyway', async () => {
    let attempts = 0;
    const calls = stubApi({
      'GET /api/v1/collections/7/inputs': { inputs: inputs.slice(0, 3), total: 3 },
      'POST /api/v1/collections/7/versions': () => ++attempts === 1
        ? [409, { error: 'stale_version', base_version: 2, latest_version: 3 }]
        : [201, collection_answer({ latest_version: 4 })],
      'GET /api/v1/collections/7': collection_answer(),
      'GET /api/v1/collections': { collections: [collection()] },
    });
    renderAt('collection', '/p/collections/7', <CollectionPage/>);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }));
    fireEvent.click(await screen.findByRole('gridcell', { name: 'IMG_0002.raw' }));
    const bar = screen.getByRole('region', { name: 'Editing' });
    fireEvent.click(within(bar).getByRole('button', { name: 'Remove 1' }));
    expect(screen.getByRole('gridcell', { name: 'IMG_0002.raw, removed' })).toBeInTheDocument();
    fireEvent.change(within(bar).getByLabelText('Notes for the new version'), { target: { value: 'Too dark' } });
    fireEvent.click(within(bar).getByRole('button', { name: 'Save version 3' }));

    expect(await screen.findByText(/Someone saved @3/)).toBeInTheDocument();
    expect(calls.find(c => c.method === 'POST').body).toEqual({ inputs: [1, 3], base_version: 2, notes: 'Too dark' });
    fireEvent.click(screen.getByRole('button', { name: 'Save anyway, as @4' }));
    await waitFor(() => expect(attempts).toBe(2));
    expect(calls.filter(c => c.method === 'POST')[1].body).toEqual({ inputs: [1, 3], base_version: 3, notes: 'Too dark' });
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Editing' })).not.toBeInTheDocument());
  });

  test("an older version, and collections that don't exist", async () => {
    stubApi({
      'GET /api/v1/collections/7/inputs': { inputs: inputs.slice(0, 4), total: 4 },
      'GET /api/v1/collections/7': collection_answer({ version: versions[1] }),
      'GET /api/v1/collections/8': () => [404, { error: 'not found' }],
      'GET /api/v1/collections': { collections: [] },
    });
    const { unmount } = renderAt('collection', '/p/collections/7?version=1', <CollectionPage/>);
    expect(await screen.findByText(/You're looking at/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Version 1: pick another' })).toBeInTheDocument();
    unmount();
    renderAt('collection', '/p/collections/8', <CollectionPage/>);
    expect(await screen.findByText("This collection doesn't exist")).toBeInTheDocument();
  });
});


describe('the Collections page', () => {
  const list = [
    collection({ id: 1, name: 'night/b', description: 'Blurry nights', size: 1, updated_by: { id: 2, user_name: 'bob', full_name: 'Bob B' } }),
    collection({ id: 2, name: 'night/a', favorite: true }),
    collection({ id: 3, name: 'ci/regression', pinned_for: [{ id: 5, name: 'af-team' }], pinned: true }),
    collection({ id: 4, name: 'calib', project: 'parent', inherited: true, ref: 'parent:calib' }),
  ];

  test('pinned and favorites first, then by group like milestones, and the parent projects\' marked', async () => {
    const calls = stubApi({ 'GET /api/v1/collections': { collections: list }, 'PUT /api/v1/collections/1/favorite': { id: 1, favorite: true } });
    renderAt('collections', '/p/collections', <CollectionsPage/>);
    // the loading skeleton has the same heading: wait for the list
    const pinned = await screen.findByRole('region', { name: 'Pinned' });
    expect(screen.getByRole('heading', { name: 'Collections' })).toBeInTheDocument();
    expect(within(pinned).getByRole('link', { name: 'ci / regression' })).toHaveAttribute('href', '/p/collections/3');
    expect(within(pinned).getByText(/pinned for af-team/)).toBeInTheDocument();
    expect(within(screen.getByRole('region', { name: 'Favorites' })).getByRole('link', { name: 'night / a' })).toBeInTheDocument();
    // grouped by name prefix: "night" holds a and b
    const all = screen.getByRole('region', { name: 'All of p' });
    const night = within(all).getByRole('button', { name: /^night/ });
    expect(night).toHaveAttribute('aria-expanded', 'true');
    const b = within(all).getByRole('link', { name: 'b' });
    expect(b).toHaveAttribute('href', '/p/collections/1');
    // name, description, size, latest version, updated by and when
    const row = b.closest('li');
    expect(row).toHaveTextContent('Blurry nights');
    expect(row).toHaveTextContent('@2 · 1 input');
    expect(row).toHaveTextContent('updated by Bob B');
    // folding a group
    fireEvent.click(night);
    expect(within(all).queryByRole('link', { name: 'b' })).toBeNull();
    fireEvent.click(night);
    // the parent's: listed apart, and marked
    const parent = screen.getByRole('region', { name: 'From parent' });
    expect(within(parent).getByRole('link', { name: 'calib' })).toBeInTheDocument();
    expect(within(parent).getByText('from parent')).toBeInTheDocument();
    // favorites
    fireEvent.click(within(all).getByRole('button', { name: 'Add night / b to favorites' }));
    await waitFor(() => expect(calls.some(c => c.method === 'PUT' && c.url.includes('/collections/1/favorite'))).toBe(true));
  });

  test('search, archived, and how to make a new one', async () => {
    const calls = stubApi({
      'GET /api/v1/collections': url => [200, { collections: url.includes('archived=1') ? [...list, collection({ id: 9, name: 'old', archived: true })] : list }],
    });
    renderAt('collections', '/p/collections', <CollectionsPage/>);
    const search = await screen.findByRole('searchbox', { name: 'Search collections' });
    fireEvent.change(search, { target: { value: 'blurry' } });
    // searching opens the groups
    expect(screen.getByRole('link', { name: 'b' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'calib' })).toBeNull();
    fireEvent.change(search, { target: { value: 'nothing like it' } });
    expect(screen.getByText('No collection matches')).toBeInTheDocument();
    fireEvent.change(search, { target: { value: '' } });

    expect(screen.queryByRole('link', { name: 'old' })).toBeNull();
    fireEvent.click(screen.getByRole('switch', { name: 'Show archived' }));
    expect(await screen.findByRole('link', { name: 'old' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'old' }).closest('li')).toHaveTextContent('archived');
    expect(calls.some(c => c.url.includes('archived=1'))).toBe(true);

    fireEvent.click(screen.getByRole('button', { name: 'New collection' }));
    const help = screen.getByRole('region', { name: 'New collection' });
    expect(help).toHaveTextContent('select inputs, then Save as collection');
    expect(within(help).getByRole('link', { name: /Select inputs/ })).toHaveAttribute('href', '/p/inputs');
  });

  test('none yet: what they are for, and the parent projects\' they can use', async () => {
    stubApi({ 'GET /api/v1/collections': { collections: [list[3]] } });
    renderAt('collections', '/p/collections', <CollectionsPage/>);
    expect(await screen.findByRole('heading', { name: 'No collections in p yet' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Browse inputs/ })).toHaveAttribute('href', '/p/inputs');
    expect(screen.getByRole('link', { name: 'parent:calib' })).toHaveAttribute('href', '/p/collections/4');
    // the batch file's syntax
    expect(screen.getByText(code(/collections:\s+- night\/hard-cases@1/))).toBeInTheDocument();
  });
});


describe('the collections panel', () => {
  test('pinned, favorites, then by group; favorites toggle', async () => {
    const list = [
      collection({ id: 1, name: 'night/b' }),
      collection({ id: 2, name: 'night/a', favorite: true }),
      collection({ id: 3, name: 'ci/regression', pinned_for: [{ id: 5, name: 'af-team' }], pinned: true }),
      collection({ id: 4, name: 'calib', project: 'parent', inherited: true, ref: 'parent:calib' }),
    ];
    const calls = stubApi({ 'GET /api/v1/collections': { collections: list }, 'DELETE /api/v1/collections/2/favorite': { id: 2, favorite: false } });
    renderAt('inputs', '/p/inputs', <CollectionsPanel project="p"/>);
    const panel = await screen.findByRole('menu', { name: 'Collections' });
    expect(await within(panel).findByText('Pinned')).toBeInTheDocument();
    expect(within(panel).getByText('ci / regression')).toBeInTheDocument();
    expect(within(panel).getByText('Favorites')).toBeInTheDocument();
    expect(within(panel).getByText('From parent')).toBeInTheDocument();
    expect(within(panel).getByText('night')).toBeInTheDocument();
    fireEvent.click(within(panel).getAllByRole('button', { name: 'Remove night / a from favorites' })[0]);
    await waitFor(() => expect(calls.some(c => c.method === 'DELETE')).toBe(true));
  });

  test('none yet: what they are, nothing about archived ones or other pages', async () => {
    stubApi({ 'GET /api/v1/collections': { collections: [], archived_count: 0 } });
    renderAt('inputs', '/p/inputs', <CollectionsPanel project="p" on_inputs_page/>);
    expect(await screen.findByText(/No collections yet/)).toBeInTheDocument();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    expect(screen.queryByText(/archived/)).not.toBeInTheDocument();
    expect(screen.queryByText('Browse the inputs')).not.toBeInTheDocument();
    expect(screen.queryByText('All the collections')).not.toBeInTheDocument();
  });

  test('only archived ones: where they are', async () => {
    stubApi({ 'GET /api/v1/collections': { collections: [], archived_count: 2 } });
    renderAt('inputs', '/p/inputs', <CollectionsPanel project="p"/>);
    expect(await screen.findByText(/2 archived, on the Collections page/)).toBeInTheDocument();
    expect(screen.getByText('All the collections')).toBeInTheDocument();
    expect(screen.getByText('Browse the inputs')).toBeInTheDocument();
  });
});

describe('thumbnails', () => {
  const answer = (status, body) => vi.fn(async () => ({ ok: status < 300, status, json: async () => body }));
  test('try again when the server is busy or it worked, else say why', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    fetch.mockImplementation(answer(503, {}));
    expect(await thumbnail_retry('/t', 0)).toEqual({ retry: true });
    fetch.mockImplementation(answer(200, {}));
    expect(await thumbnail_retry('/t', 0)).toEqual({ retry: true });
    fetch.mockImplementation(answer(403, { reason: 'not-listable' }));
    expect(await thumbnail_retry('/t', 0)).toEqual({ retry: false, reason: 'not-listable' });
    fetch.mockImplementation(answer(404, { reason: 'no_thumbnail' }));
    expect(await thumbnail_retry('/t', 0)).toEqual({ retry: false, reason: 'no_thumbnail' });
    expect(await thumbnail_retry('/t', 4)).toEqual({ retry: false, reason: 'busy' });
    fetch.mockRestore();
  });

  test('the placeholder says why there is no preview', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(answer(403, { reason: 'not-listable' }));
    const { container } = renderWithProviders(<Thumbnail project="p/sub" input={input(1)}/>);
    expect(container.querySelector('img')).toHaveAttribute('src', '/api/v1/inputs/1/thumbnail?project=p%2Fsub');
    fireEvent.error(container.querySelector('img'));
    expect(await screen.findByText('Folder not readable')).toHaveAttribute('title', expect.stringContaining('Data folders'));
    expect(fetch).toHaveBeenCalledWith('/api/v1/inputs/1/thumbnail?project=p%2Fsub', expect.anything());
    fetch.mockRestore();
  });
});


describe('the viewer', () => {
  test('previous and next, and the runs that used the input', async () => {
    stubApi({ 'GET /api/v1/inputs/1': { ...input(1), runs: [{ id: 11, project: 'p/sub', batch: 'nightly', commit: 'abcdef123456', branch: 'main', user: 'bob', origin: 'ci', created_date: '2026-11-01T10:00:00Z', deleted: false, is_failed: true }] } });
    const onIndexChange = vi.fn();
    const onClose = vi.fn();
    renderAt('inputs', '/p/inputs', <InputViewer project="p" count={3} item_at={i => inputs[i]} index={0} onIndexChange={onIndexChange} onClose={onClose}/>);
    expect(screen.getByRole('button', { name: 'Previous input' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Next input' }));
    expect(onIndexChange).toHaveBeenCalledWith(1);
    act(() => { fireEvent.keyDown(document.body, { key: 'ArrowRight' }); });
    expect(onIndexChange).toHaveBeenCalledTimes(2);
    const run = await screen.findByRole('link', { name: /abcdef12/ });
    expect(run).toHaveAttribute('href', '/p/sub/commit/abcdef123456?batch=nightly&filter=night%2Fstreet%2FIMG_0001.raw');
    expect(within(run).getByText('failed')).toBeInTheDocument();
    // the input's file opens in a new tab: a link (AnchorButton), not a <button> with an href
    const file = screen.getByRole('button', { name: 'File' });
    expect(file.tagName).toBe('A');
    expect(file).toHaveAttribute('href', '/api/v1/inputs/1/file?project=p');
    expect(file).toHaveAttribute('target', '_blank');
  });

  test('the files that come with the input', async () => {
    stubApi({ 'GET /api/v1/inputs/1': { ...input(1), runs: [], sidecars: [{ name: 'IMG_0001.imgprops', size: 2048, url: '/s/data/night/street/IMG_0001.imgprops' }] } });
    renderAt('inputs', '/p/inputs', <InputViewer project="p" count={3} item_at={i => inputs[i]} index={0} onIndexChange={vi.fn()} onClose={vi.fn()}/>);
    const sidecar = await screen.findByRole('link', { name: /IMG_0001\.imgprops/ });
    expect(sidecar).toHaveAttribute('href', '/s/data/night/street/IMG_0001.imgprops');
    expect(within(sidecar).getByText('2.0 KB')).toBeInTheDocument();
  });
});
