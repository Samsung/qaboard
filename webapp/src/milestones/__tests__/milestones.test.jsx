/**
 * Tests for milestones: picking them (MilestonesPanel), saving them (MilestoneDialog, the commit bars' star),
 * their links, and moving the ones older versions saved in browsers to the user's account.
 * Run with: cd webapp && npm test -- milestones
 */
import { screen, fireEvent, waitFor, within, renderHook, act } from '@testing-library/react';
import { QueryClientProvider } from '@tanstack/react-query';

import {
  index_milestones, milestones_of, milestone_name, milestone_path, milestone_id_from_path, milestone_location,
} from '../api';
import { MilestonesPanel } from '../MilestonesPanel';
import { ManageMilestones } from '../ManageMilestones';
import MilestonePage from '../MilestonePage';
import { unstable_HistoryRouter as HistoryRouter } from 'react-router';
import { RouteMatch, history } from '../../router';
import { comparison_path, milestone_search_text, runs_matches, summarize_loaded_runs, dataset_label } from '../api';
import { MilestoneDialogHost, openMilestoneDialog } from '../MilestoneDialog';
import { CommitMilestoneButton } from '../CommitMilestone';
import { useImportLegacyMilestones } from '../hooks';
import { usePrefsStore } from '../../stores/prefs';
import { renderWithProviders, makeQueryClient } from '../../test-utils';
import { userQuery } from '../../api/queries';
import { toaster } from '../../toaster';


const SHA = 'abcdef1234567890abcdef1234567890abcdef12';
const alice = { is_logged: true, user_id: 1, user_name: 'alice', full_name: 'Alice A' };

const make = (fields = {}) => ({
  id: 1, project: 'p', label: 'v1.0', group: '', notes: '', shared: false, commit: SHA, commit_project: null,
  batch: 'default', filter: '', branch: 'main', committer_name: 'carol', message: 'Faster',
  owner: { user_name: 'alice', full_name: 'Alice A' }, is_mine: true, can_edit: true, is_favorite: false, slug: 'v1-0',
  created_at: '2026-10-01T10:00:00Z', updated_at: '2026-10-01T10:00:00Z',
  ...fields,
});

const milestones = [
  make({ id: 1, label: 'Release 1.0', shared: true, group: 'releases', updated_at: '2026-09-01T10:00:00Z', is_mine: false, can_edit: false, owner: { user_name: 'bob', full_name: 'Bob B' } }),
  make({
    id: 2, label: 'Best denoiser', group: 'tuning/denoiser', batch: 'sweep-3', filter: 'gain:4', is_favorite: true, notes: 'psnr +0.4',
    runs: { count: 12, failed: 1, inputs: 12, databases: [{ name: '/data/indoor/2024', runs: 8 }, { name: '/data/night', runs: 4 }], batches: [{ name: 'nightly-hdr', runs: 12 }], platforms: [{ name: 'linux', runs: 12 }] },
  }),
  make({ id: 3, label: 'Quick check', updated_at: '2026-10-02T10:00:00Z' }),
  make({ id: 4, label: 'Bob baseline', shared: true, is_mine: false, can_edit: false, owner: { user_name: 'dan', full_name: 'Dan D' }, commit: 'f'.repeat(40) }),
];

// Answers the API calls the components make, and records them
const stubApi = (answers = {}) => {
  const calls = [];
  vi.stubGlobal('fetch', vi.fn(async (url, init = {}) => {
    calls.push({ url, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : undefined });
    const key = Object.keys(answers).find(k => `${init.method ?? 'GET'} ${url}`.startsWith(k));
    const answer = key ? answers[key] : {};
    const [status, body] = typeof answer === 'function' ? answer(url, init) : [200, answer];
    return new Response(JSON.stringify(body), { status });
  }));
  return calls;
};

afterEach(() => {
  vi.unstubAllGlobals();
  usePrefsStore.setState({ milestones: {}, milestoneGroupsCollapsed: {} });
});


describe('milestones', () => {
  test('links', () => {
    expect(milestone_path(make({ id: 12, project: 'group/p', slug: 'best-denoiser' }))).toBe('/group/p/milestone/12-best-denoiser');
    expect(milestone_path(make({ id: 12, slug: '' }))).toBe('/p/milestone/12');
    expect(milestone_id_from_path('12-best-denoiser')).toBe(12);
    expect(milestone_id_from_path('12')).toBe(12);
    expect(milestone_id_from_path('best')).toBe(null);
    expect(milestone_location(make({ project: 'p', commit_project: 'p/sub', batch: 'sweep', filter: 'a b' }))).toEqual({
      pathname: `/p/commit/${SHA}`, search: 'new_project=p%2Fsub&batch=sweep&filter=a%20b',
    });
  });

  test('older milestones may have no name', () => {
    expect(milestone_name(make({ label: '', batch: 'sweep' }))).toBe('main · sweep');
    expect(milestone_name(make({ label: '', branch: null }))).toBe('abcdef12');
  });

  test('the milestones of a commit, batch and filter', () => {
    const index = index_milestones([
      ...milestones,
      make({ id: 5, commit: SHA.slice(0, 8), is_mine: false }),
      make({ id: 6, commit_project: 'other' }),
    ]);
    // the user's own first
    expect(milestones_of(index, { project: 'p', commit: SHA }).map(m => m.id)).toEqual([2, 3, 1, 5]);
    expect(milestones_of(index, { project: 'p', commit: SHA, batch: 'sweep-3', filter: 'gain:4' }).map(m => m.id)).toEqual([2]);
    expect(milestones_of(index, { project: 'p', commit: SHA, batch: 'sweep-3', filter: '' })).toEqual([]);
    expect(milestones_of(index, { project: 'other', commit: SHA }).map(m => m.id)).toEqual([6]);
    expect(milestones_of(index, { project: 'p', commit: null })).toEqual([]);
  });
});


describe('MilestonesPanel', () => {
  const renderPanel = ({ list = milestones, user = alice, props = {} } = {}) => {
    const onSelect = vi.fn();
    const project_data = { data: { qatools_config: { project: { milestones: ['release/v0.9'] } } } };
    const utils = renderWithProviders(<MilestonesPanel project="p" project_data={project_data} onSelect={onSelect} {...props}/>, { user, milestones: { p: list } });
    return { ...utils, onSelect };
  };
  const headers = () => [...document.querySelectorAll('.bp6-menu-header')].map(h => h.textContent);

  test('favorites first, then mine by group, then the shared ones, then qaboard.yaml', () => {
    renderPanel();
    // no counts next to 1 or 2 items
    expect(headers()).toEqual(['Favorites', 'My milestones', 'Shared with the project', 'From qaboard.yaml']);
    const panel = within(screen.getByRole('menu', { name: 'Milestones' }));
    expect(panel.getAllByText('Best denoiser')).toHaveLength(2);
    // groups nest
    expect(panel.getByText('tuning')).toBeInTheDocument();
    expect(panel.getByText('denoiser')).toBeInTheDocument();
    // others' milestones say who saved them
    expect(panel.getByText('Dan D')).toBeInTheDocument();
  });

  test('counts show for long lists, and for collapsed groups', () => {
    const many = [1, 2, 3].map(id => make({ id, label: `sweep ${id}`, group: 'tuning' }));
    renderPanel({ list: many });
    expect(headers()[0]).toBe('My milestones3');
    const group = screen.getByText('tuning').closest('a');
    expect(group.textContent).toContain('3');
  });

  test('favorite groups list their milestones first, even future ones', async () => {
    const calls = stubApi({ 'POST /api/v1/milestones/groups/favorite': { section: 'mine', group: 'tuning', is_favorite: true } });
    renderPanel();
    fireEvent.click(screen.getByLabelText('Add the group tuning to favorites'));
    await waitFor(() => expect(screen.getAllByText('Best denoiser')).toHaveLength(3));
    expect(calls.find(c => c.url === '/api/v1/milestones/groups/favorite').body).toEqual({ project: 'p', section: 'mine', group: 'tuning', is_favorite: true });
    // the favorite group comes first, with its subgroups
    expect(document.querySelector('.qa-milestones-group').textContent).toContain('tuning');
  });

  test('groups collapse, and stay collapsed', () => {
    renderPanel();
    fireEvent.click(screen.getByText('releases'));
    expect(screen.queryByText('Release 1.0')).toBeNull();
    expect(usePrefsStore.getState().milestoneGroupsCollapsed).toEqual({ 'team/releases': true });
  });

  test('the search matches everything milestones say, and Enter picks the first', async () => {
    usePrefsStore.setState({ milestoneGroupsCollapsed: { 'mine/tuning': true } });
    const { onSelect } = renderPanel();
    const search = screen.getByLabelText('Search milestones');
    fireEvent.change(search, { target: { value: 'gain:4' } });
    // in collapsed groups too
    expect(screen.getAllByText('Best denoiser')).toHaveLength(2);
    expect(screen.queryByText('Quick check')).toBeNull();
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 2 }));
    fireEvent.change(search, { target: { value: 'dan' } });
    expect(screen.getByText('Bob baseline')).toBeInTheDocument();
    fireEvent.change(search, { target: { value: 'nothing like this' } });
    expect(screen.getByText(/No milestone matches/)).toBeInTheDocument();
  });

  test('picking a milestone or a reference from qaboard.yaml', () => {
    const { onSelect } = renderPanel();
    fireEvent.click(screen.getByText('Quick check'));
    expect(onSelect).toHaveBeenLastCalledWith(expect.objectContaining({ id: 3 }));
    fireEvent.click(screen.getByText('release/v0.9'));
    expect(onSelect).toHaveBeenLastCalledWith({ branch: 'release/v0.9' });
  });

  test('shows which milestone is selected', () => {
    renderPanel({ props: { selected: { project: 'p', commit: SHA, batch: 'default', filter: '' } } });
    expect(screen.getAllByText('selected')).toHaveLength(2);
  });

  test('favorites', async () => {
    const calls = stubApi({ 'PUT /api/v1/milestones/3/favorite': { id: 3, is_favorite: true } });
    renderPanel();
    fireEvent.click(within(screen.getByText('Quick check').closest('a')).getByLabelText('Add to favorites'));
    await waitFor(() => expect(screen.getAllByText('Quick check')).toHaveLength(2));
    expect(calls.some(c => c.method === 'PUT' && c.url === '/api/v1/milestones/3/favorite')).toBe(true);
  });

  test('logged out users are told to log in to keep the milestones of their browser', () => {
    usePrefsStore.setState({ milestones: { p: { k1: { commit: 'a' }, k2: { commit: 'b' } } } });
    renderPanel({ user: { is_logged: false }, list: [] });
    expect(screen.getByText(/2 milestones are saved only in this browser/)).toBeInTheDocument();
    expect(screen.getByText('Log in to save your own milestones.')).toBeInTheDocument();
  });

  test('explains milestones when there are none', () => {
    renderPanel({ list: [], props: { project_data: {} } });
    expect(screen.getByText(/None yet/)).toBeInTheDocument();
    expect(screen.getByText(/Milestones are results worth comparing with/)).toBeInTheDocument();
  });
});


describe('saving milestones', () => {
  const commit = { id: SHA, branch: 'feature/denoise', message: 'Faster denoising\n\nDetails', committer_name: 'carol', authored_datetime: '2026-10-01T10:00:00Z' };
  const renderButton = ({ list = [], user = alice, batch = { label: 'sweep-3' }, filter = 'gain:4' } = {}) => renderWithProviders(<>
    <CommitMilestoneButton project="p" project_shown="p" commit={commit} batch={batch} filter={filter} runs={12}/>
    <MilestoneDialogHost/>
  </>, { user, milestones: { p: list } });

  test('the star saves the results shown: commit, batch and filter', async () => {
    let saved = [];
    const calls = stubApi({
      'POST /api/v1/milestones': (url, init) => [201, saved[0] = make({ ...JSON.parse(init.body), id: 9, commit: SHA })],
      'GET /api/v1/milestones?': () => [200, { milestones: saved }],
    });
    renderButton();
    fireEvent.click(screen.getByLabelText('Save as a milestone'));
    const dialog = within(await screen.findByRole('dialog'));
    expect(dialog.getByText('sweep-3')).toBeInTheDocument();
    expect(dialog.getByText('gain:4')).toBeInTheDocument();
    expect(dialog.getByText(/12 runs/)).toBeInTheDocument();
    // a name is suggested
    const name = dialog.getByLabelText('Name');
    expect(name).toHaveValue('sweep-3 · gain:4');
    fireEvent.change(name, { target: { value: 'Best denoiser' } });
    fireEvent.change(dialog.getByLabelText(/Group/), { target: { value: 'tuning/denoiser' } });
    fireEvent.click(dialog.getByText('Everyone on the project'));
    fireEvent.click(dialog.getByText('Save milestone'));
    await waitFor(() => expect(calls.some(c => c.method === 'POST')).toBe(true));
    expect(calls.find(c => c.method === 'POST').body).toEqual({
      project: 'p', label: 'Best denoiser', group: 'tuning/denoiser', notes: '', shared: true,
      commit: SHA, batch: 'sweep-3', filter: 'gain:4', commit_project: null,
      branch: 'feature/denoise', committer_name: 'carol', message: 'Faster denoising',
    });
    await waitFor(() => expect(screen.getByLabelText('Milestone: Best denoiser')).toBeInTheDocument());
  });

  test('saving needs a login', async () => {
    renderButton({ user: { is_logged: false } });
    fireEvent.click(screen.getByLabelText('Save as a milestone'));
    expect(await screen.findByText('Log in to save milestones')).toBeInTheDocument();
  });

  test('a filled star with the name of the milestone, to edit it', async () => {
    const calls = stubApi({
      'POST /api/v1/milestones/2': (url, init) => [200, make({ ...milestones[1], ...JSON.parse(init.body) })],
      'GET /api/v1/milestones?': () => [200, { milestones }],
    });
    renderButton({ list: milestones });
    expect(screen.getByText('Best denoiser')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Milestone: Best denoiser'));
    const dialog = within(await screen.findByRole('dialog'));
    expect(dialog.getByText('Edit the milestone')).toBeInTheDocument();
    fireEvent.change(dialog.getByLabelText(/Notes/), { target: { value: 'psnr +0.5' } });
    fireEvent.click(dialog.getByText('Save'));
    await waitFor(() => expect(calls.find(c => c.method === 'POST')?.body).toEqual({ label: 'Best denoiser', group: 'tuning/denoiser', notes: 'psnr +0.5', shared: false }));
  });

  test("others' milestones are read-only, users can save their own", async () => {
    renderWithProviders(<MilestoneDialogHost/>, { user: alice, milestones: { p: milestones } });
    act(() => openMilestoneDialog({ project: 'p', milestone: milestones[3] }));
    const dialog = within(await screen.findByRole('dialog'));
    expect(dialog.getByText(/Only Dan D can edit it/)).toBeInTheDocument();
    expect(dialog.queryByLabelText('Name')).toBeNull();
    fireEvent.click(dialog.getByText('Save my own'));
    // a copy of a shared milestone is personal, with another name, until users decide otherwise
    expect(dialog.getByLabelText('Name')).toHaveValue('Bob baseline (mine)');
    expect(dialog.getByText(/Listed only for you/)).toBeInTheDocument();
    expect(dialog.getByText('Save milestone')).toBeInTheDocument();
  });

  test('deleting asks first', async () => {
    const calls = stubApi({ 'DELETE /api/v1/milestones/3': { status: 'OK' } });
    renderWithProviders(<MilestoneDialogHost/>, { user: alice, milestones: { p: milestones } });
    act(() => openMilestoneDialog({ project: 'p', milestone: milestones[2] }));
    fireEvent.click(await screen.findByText('Delete'));
    const alert = within(await screen.findByRole('alertdialog'));
    expect(calls).toHaveLength(0);
    fireEvent.click(alert.getByText('Delete'));
    await waitFor(() => expect(calls.some(c => c.method === 'DELETE' && c.url === '/api/v1/milestones/3')).toBe(true));
  });
});


describe('milestones saved in browsers by older versions', () => {
  const renderImport = user => {
    const queryClient = makeQueryClient();
    queryClient.setQueryData(userQuery.queryKey, user);
    return renderHook(() => useImportLegacyMilestones(), { wrapper: ({ children }) => <QueryClientProvider client={queryClient}>{children}</QueryClientProvider> });
  };

  test('move to the account of logged-in users', async () => {
    const legacy = { p: { 'p/abc/default': { commit: 'abc', label: 'old' } }, 'no-access': { k: { commit: 'x' } } };
    usePrefsStore.setState({ milestones: legacy });
    const calls = stubApi({ 'POST /api/v1/milestones/import': { imported: 1, done: ['p'], skipped: [] } });
    renderImport(alice);
    await waitFor(() => expect(usePrefsStore.getState().milestones).toEqual({ 'no-access': { k: { commit: 'x' } } }));
    expect(calls[0].body).toEqual({ milestones: legacy });
  });

  test("are sent once when the server can't take them", async () => {
    usePrefsStore.setState({ milestones: { secret: { k: { commit: 'abc' } } } });
    const calls = stubApi({ 'POST /api/v1/milestones/import': { imported: 0, done: [], skipped: [{ project: 'secret', reason: 'no access' }] } });
    renderImport(alice);
    await waitFor(() => expect(calls).toHaveLength(1));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(calls).toHaveLength(1);
    expect(usePrefsStore.getState().milestones).toEqual({ secret: { k: { commit: 'abc' } } });
  });

  test('stay in the browser until users log in', async () => {
    usePrefsStore.setState({ milestones: { p: { k: { commit: 'abc' } } } });
    const calls = stubApi();
    renderImport({ is_logged: false });
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(calls).toHaveLength(0);
    expect(usePrefsStore.getState().milestones).toEqual({ p: { k: { commit: 'abc' } } });
  });
});


describe('managing milestones', () => {
  const renderManage = (list = milestones) => history.replace('/p/commits') || renderWithProviders(
    <HistoryRouter history={history}><RouteMatch match={{ path: '/:project_id+/commits', params: { project_id: 'p' } }}>
      <ManageMilestones isOpen project="p" onClose={() => {}}/>
    </RouteMatch></HistoryRouter>,
    { user: alice, milestones: { p: list } },
  );
  const names = () => [...document.querySelectorAll('tbody .qa-name')].map(n => n.textContent);

  test('sorted by last update, or creation, or name', () => {
    renderManage();
    expect(names()[0]).toContain('Quick check');
    fireEvent.change(screen.getByLabelText('Sort by'), { target: { value: 'name' } });
    const labels = ['Best denoiser', 'Bob baseline', 'Quick check', 'Release 1.0'];
    expect(names().map(n => labels.find(label => n.includes(label)))).toEqual(labels);
  });

  test('moves several milestones to a group, only those of the user', async () => {
    const calls = stubApi({ 'POST /api/v1/milestones/': (url, init) => [200, make({ id: Number(url.split('/').pop()), ...JSON.parse(init.body) })] });
    renderManage();
    fireEvent.click(screen.getByLabelText('Select Quick check'));
    fireEvent.click(screen.getByLabelText('Select Bob baseline'));
    expect(screen.getByText(/1 not yours/)).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Move to the group'), { target: { value: ' checks / quick ' } });
    fireEvent.click(screen.getByText('Move'));
    await waitFor(() => expect(calls.filter(c => c.method === 'POST')).toHaveLength(1));
    expect(calls[0]).toMatchObject({ url: '/api/v1/milestones/3', body: { group: 'checks/quick' } });
  });

  test('compares two milestones', () => {
    renderManage();
    fireEvent.click(screen.getByLabelText('Select Quick check'));
    fireEvent.click(screen.getByLabelText('Select Release 1.0'));
    // the most recent is the new results
    fireEvent.click(screen.getByText(/^Compare/));
    expect(window.location.pathname + window.location.search).toBe(comparison_path(milestones[2], milestones[0]));
  });
});


describe('milestone links', () => {
  const renderPage = (name, vs) => {
    history.replace(`/p/milestone/${name}${vs ? `?vs=${vs}` : ''}`);
    return renderWithProviders(
      <HistoryRouter history={history}><RouteMatch match={{ path: '/:project_id+/milestone/:name+', params: { project_id: 'p', name } }}><MilestonePage/></RouteMatch></HistoryRouter>,
      { user: alice },
    );
  };

  test('compare two milestones', async () => {
    stubApi({ 'GET /api/v1/milestones/2': milestones[1], 'GET /api/v1/milestones/4': milestones[3] });
    renderPage('2-best-denoiser', '4-bob');
    await waitFor(() => expect(window.location.pathname).toBe(`/p/commit/${SHA}`));
    expect(window.location.search).toBe(`?batch=sweep-3&filter=gain%3A4&reference=${'f'.repeat(40)}`);
  });

  test('a deleted reference: the milestone opens, and we say so', async () => {
    stubApi({ 'GET /api/v1/milestones/2': milestones[1], 'GET /api/v1/milestones/9': () => [404, { error: 'deleted' }] });
    const toast = vi.spyOn(toaster, 'show');
    renderPage('2-best-denoiser', '9-old-release');
    await waitFor(() => expect(window.location.pathname).toBe(`/p/commit/${SHA}`));
    expect(window.location.search).not.toContain('reference');
    expect(toast).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringMatching(/The milestone “old release” \(#9\) doesn't exist anymore: the results are compared with the default reference/) }));
    toast.mockRestore();
  });

  test('a deleted milestone says what it was, and offers the other one', async () => {
    stubApi({ 'GET /api/v1/milestones/9': () => [404, { error: 'deleted' }], 'GET /api/v1/milestones/4': milestones[3] });
    renderPage('9-old-release', '4-bob');
    expect(await screen.findByText(/The milestone “old release” \(#9\) doesn't exist anymore/)).toBeInTheDocument();
    expect(await screen.findByText(/Open the other milestone/)).toBeInTheDocument();
  });

  test('not a milestone link', () => {
    renderPage('best');
    expect(screen.getByText("This link doesn't point to a milestone")).toBeInTheDocument();
  });
});


describe('datasets', () => {
  const best = milestones[1];

  test('the search matches what the runs used, and says so', () => {
    expect(dataset_label('/data/indoor/2024')).toBe('indoor/2024');
    expect(milestone_search_text(best)).toContain('dataset:/data/indoor/2024');
    expect(runs_matches(best, 'nightly')).toEqual([{ kind: 'qa batch', name: 'nightly-hdr' }]);
    expect(runs_matches(best, 'dataset:night').map(v => v.name)).toEqual(['/data/night']);
    // it matched by its own name: nothing to explain
    expect(runs_matches(best, 'denoiser')).toEqual([]);
  });

  test('in the milestones menu, with why it matched', () => {
    renderWithProviders(<MilestonesPanel project="p" onSelect={() => {}}/>, { user: alice, milestones: { p: milestones } });
    fireEvent.change(screen.getByLabelText('Search milestones'), { target: { value: 'dataset:indoor' } });
    expect(screen.getAllByText('Best denoiser')).toHaveLength(2);
    expect(screen.queryByText('Quick check')).toBeNull();
    expect(screen.getAllByText('dataset: indoor/2024')).toHaveLength(2);
  });

  test('the Manage dialog shows the notes and runs, and filters by dataset', () => {
    history.replace('/p/commits');
    renderWithProviders(<HistoryRouter history={history}><RouteMatch match={{ path: '/:project_id+/commits', params: { project_id: 'p' } }}>
      <ManageMilestones isOpen project="p" onClose={() => {}}/>
    </RouteMatch></HistoryRouter>, { user: alice, milestones: { p: milestones } });
    expect(screen.getByText('psnr +0.4')).toBeInTheDocument();
    expect(screen.getByText('12 runs, 1 failed')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Dataset'), { target: { value: 'qa-batch:nightly-hdr' } });
    expect(document.querySelectorAll('tbody tr')).toHaveLength(1);
    expect(screen.getByText('nightly-hdr')).toBeInTheDocument();
  });

  test('saving shows the datasets of the runs that match the filter', async () => {
    const outputs = {
      1: { test_input_database: '/data/indoor', data: { batch: 'nightly' }, platform: 'linux' },
      2: { test_input_database: '/data/night', data: { batch: 'nightly' }, platform: 'linux', is_failed: true },
      3: { output_type: 'optim_iteration' },
    };
    expect(summarize_loaded_runs(outputs, ['2'])).toEqual({ count: 1, failed: 1, databases: [{ name: '/data/night', runs: 1 }], batches: [{ name: 'nightly', runs: 1 }], platforms: [{ name: 'linux', runs: 1 }] });
    renderWithProviders(<>
      <CommitMilestoneButton project="p" commit={{ id: SHA, branch: 'main' }} batch={{ label: 'default', outputs, filtered: { outputs: ['1', '2'] } }} filter="indoor|night" runs={2}/>
      <MilestoneDialogHost/>
    </>, { user: alice, milestones: { p: [] } });
    fireEvent.click(screen.getByLabelText('Save as a milestone'));
    const dialog = within(await screen.findByRole('dialog'));
    expect(dialog.getByText('Datasets')).toBeInTheDocument();
    expect(dialog.getByText('data/night')).toBeInTheDocument();
    expect(dialog.getByText('qa batches')).toBeInTheDocument();
  });
});
