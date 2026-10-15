/**
 * Tests for the tuning form.
 * Run with: cd webapp && npm test -- tuning
 */
import { screen, fireEvent, waitFor, act, within } from '@testing-library/react';

import { TuningForm, combinations_info, eval_combinations, branch_matches } from '../forms';
import { renderWithProviders } from '../../../test-utils';
import { usePrefsStore } from '../../../stores/prefs';
import { userQuery } from '../../../api/queries';
import { toaster } from '../../../toaster';

vi.mock('../../MonacoEditor', () => ({
  default: ({ value, onChange, name }) => <textarea data-testid={name} value={value} onChange={e => onChange(e.target.value)}/>,
}));

const json = (data, status = 200) => Promise.resolve(new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }));

describe('tuning combinations', () => {
  it('counts the combinations of JSON tuning sets', () => {
    expect(combinations_info('{"a": [1, 2], "b": [1, 2, 3]}', { n_iter: 50 }, 'grid')).toEqual({ combinations: 6, language: 'yaml' });
    expect(combinations_info('[{"a": 1}, {"a": [1, 2]}]', { n_iter: 50 }, 'grid')).toEqual({ combinations: 3, language: 'yaml' });
    expect(combinations_info('{"a": [1, 2, 3]}', { n_iter: 2 }, 'sampler').combinations).toBe(2);
  });

  it('matches branches with globs and the subproject', () => {
    expect(branch_matches('develop', ['develop', '*/*{subproject.name}*'], 'isp/denoise')).toBe(true);
    expect(branch_matches('alice/denoise-v2', ['develop', '*/*{subproject.name}*'], 'isp/denoise')).toBe(true);
    expect(branch_matches('alice/demosaic', ['develop', '*/*{subproject.name}*'], 'isp/denoise')).toBe(false);
    expect(branch_matches('denoise', ['*/*{subproject.name}*'], 'isp/denoise')).toBe(false);
    expect(branch_matches('release/isp/denoise', ['release/{subproject}'], 'isp/denoise')).toBe(true);
    // regex characters are literals
    expect(branch_matches('v1x2', ['v1.2'])).toBe(false);
    expect(branch_matches('v1.2', ['v?.?'])).toBe(true);
  });

  it('runs functions', () => {
    expect(eval_combinations('return {a: [1, 2]}')).toEqual({ combinations: { a: [1, 2] }, language: 'javascript' });
    expect(combinations_info('not valid', { n_iter: 50 }, 'grid').combinations).toBe('invalid');
  });
});


const config = { runners: { lsf: { user: 'runner' } }, inputs: {} };
const metrics = { default_metric: 'loss', main_metrics: ['loss'], available_metrics: { loss: { target: 1 } } };
const commit = { id: 'abcdef12', branch: 'master' };

describe('TuningForm', () => {
  beforeEach(() => usePrefsStore.setState({ tuning: {} }));
  afterEach(() => vi.restoreAllMocks());

  it('remembers the form, counts runs and starts experiments', async () => {
    usePrefsStore.getState().updateTuning('proj', { experiment_name: 'exp', selected_group: 'nightly', parameter_search: '{"a": [1, 2]}' });
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(url => url.startsWith('/api/v1/tests/group?')
      ? json({ tests: [{ input_path: 'a.jpg', configurations: ['base'] }, { input_path: 'b.jpg', configurations: ['base'] }] })
      : json({}));
    renderWithProviders(
      <TuningForm project="proj" config={config} metrics={metrics} commit={commit} available_tests_files={{ usr: 'usr.yaml' }}/>,
      { user: { is_logged: true, user_name: 'alice' }, siteConfig: {} },
    );
    expect(screen.getByDisplayValue('exp')).toBeInTheDocument();
    expect(await screen.findByText(/4 total runs/)).toBeInTheDocument();
    expect(fetch.mock.calls[0][0]).toBe('/api/v1/tests/group?project=proj&name=nightly&commit=abcdef12');

    fireEvent.change(screen.getByPlaceholderText('my-tuning-experiment'), { target: { value: 'my exp' } });
    expect(usePrefsStore.getState().tuning.proj.experiment_name).toBe('my-exp');
    fireEvent.change(screen.getByTestId('editor-tuning-set'), { target: { value: '{"a": [1, 2, 3]}' } });
    expect(await screen.findByText(/6 total runs/)).toBeInTheDocument();

    fireEvent.click(screen.getByText('Start 6 runs'));
    await waitFor(() => expect(fetch.mock.calls.some(([url]) => url === '/api/v1/commit/abcdef12/batch?project=proj')).toBe(true));
    // the toast says when the experiment started (the toaster is mocked in setupTests.js)
    await waitFor(() => expect(toaster.show).toHaveBeenCalledWith(expect.objectContaining({ message: 'Started my-exp' }), 'tuning-my-exp'));
    const [, init] = fetch.mock.calls.find(([url]) => url === '/api/v1/commit/abcdef12/batch?project=proj');
    expect(JSON.parse(init.body)).toMatchObject({
      batch_label: 'my-exp',
      selected_group: 'nightly',
      user: 'alice',
      overwrite: true,
      tuning_search: { search_type: 'grid', parameter_search: { a: [1, 2, 3] } },
    });
  });

  it('runs as the logged-in user, even when they are known after the form showed', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => json({ tests: [] }));
    const local_config = { project: { reference_branch: 'main' }, runners: { local: {} }, inputs: {} };
    const { queryClient } = renderWithProviders(
      <TuningForm project="proj" config={local_config} metrics={metrics} commit={commit} available_tests_files={{}}/>,
      { user: { is_logged: false, user_name: null }, siteConfig: {} },
    );
    expect(screen.getByText('Please provide a user in the input below')).toBeInTheDocument();
    act(() => queryClient.setQueryData(userQuery.queryKey, { is_logged: true, user_name: 'arjun' }));
    await waitFor(() => expect(screen.queryByText('Please provide a user in the input below')).not.toBeInTheDocument());
    expect(screen.getByText(/Please give the batch a label/)).toBeInTheDocument();
  });

  it('says why the batch has no tests, with the name sent encoded', async () => {
    usePrefsStore.getState().updateTuning('kitefin/detector', { selected_group: 'nightly+fs' });
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(() => json({
      tests: [],
      definitions: [],
      warnings: ['Not in this commit\'s artifacts (/mnt/a): qa/tests/x.yaml. Run `qa save-artifacts` on this commit.'],
    }));
    renderWithProviders(
      <TuningForm project="kitefin/detector" config={config} metrics={metrics} commit={{ id: 'abc123' }} available_tests_files={{ gr: 'extra-batches', usr: 'arjun' }}/>,
      { user: { is_logged: true, user_name: 'arjun' }, siteConfig: {} },
    );
    expect(await screen.findByText('Why the batch has no tests')).toBeInTheDocument();
    expect(screen.getByText('qa save-artifacts').tagName).toBe('CODE');
    const [url, init] = fetch.mock.calls.find(([url]) => url.startsWith('/api/v1/tests/group?'));
    expect(url).toBe('/api/v1/tests/group?project=kitefin%2Fdetector&name=nightly%2Bfs&commit=abc123');
    expect(JSON.parse(init.body)).toEqual({ groups: ['extra-batches', 'arjun'] });
  });

  it('links to the docs of the site', () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => json({ tests: [] }));
    renderWithProviders(<TuningForm project="proj" config={{ inputs: {} }} metrics={metrics} commit={commit} available_tests_files={{}}/>, { siteConfig: { docs_root: '/qa/' } });
    expect(screen.getByText(/get started with async runners/).closest('a')).toHaveAttribute('href', '/qa/docs/celery-integration');
  });

  it('opens the list of tests', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => json({ tests: [] }));
    window.history.pushState({}, '', '/proj/commit/abcdef12');
    renderWithProviders(<TuningForm project="proj" config={config} metrics={metrics} commit={commit} available_tests_files={{}}/>);
    await act(async () => fireEvent.click(screen.getByText('Available Tests')));
    expect(window.location.search).toBe('?selected_views=groups');
  });

  it("warns when the CI doesn't save artifacts for the commit's branch (qaboard.yaml's tuning.branches)", () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => json({ tests: [] }));
    const tuning_config = { ...config, tuning: { branches: ['develop', '*/*{subproject.name}*'] } };
    const git = { path_with_namespace: 'algo/monorepo' };
    const { rerender } = renderWithProviders(
      <TuningForm project="algo/monorepo/isp/denoise" git={git} config={tuning_config} metrics={metrics} commit={{ id: 'abcdef1234', branch: 'alice/fix-demosaic' }} available_tests_files={{}}/>,
      { siteConfig: {} },
    );
    expect(screen.getByText('Tuning may not work')).toBeInTheDocument();
    expect(screen.getByText('*/*denoise*')).toBeInTheDocument();
    expect(screen.getByText('cd isp/denoise')).toBeInTheDocument();
    expect(screen.getByText('git checkout abcdef12')).toBeInTheDocument();

    rerender(<TuningForm project="algo/monorepo/isp/denoise" git={git} config={tuning_config} metrics={metrics} commit={{ id: 'abcdef1234', branch: 'alice/denoise-v2' }} available_tests_files={{}}/>);
    expect(screen.queryByText('Tuning may not work')).not.toBeInTheDocument();
    // by default, any branch
    rerender(<TuningForm project="algo/monorepo/isp/denoise" git={git} config={config} metrics={metrics} commit={{ id: 'abcdef1234', branch: 'alice/fix-demosaic' }} available_tests_files={{}}/>);
    expect(screen.queryByText('Tuning may not work')).not.toBeInTheDocument();
  });

  it("offers the platforms of qaboard.yaml's inputs.platforms", async () => {
    usePrefsStore.getState().updateTuning('proj', { experiment_name: 'exp', selected_group: 'nightly' });
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(url => url.startsWith('/api/v1/tests/group?')
      ? json({ tests: [{ input_path: 'a.jpg', configurations: ['base'] }] })
      : json({}));
    const platforms_config = { ...config, inputs: { platforms: [{ name: 'linux', label: 'Linux' }, { name: 'android', label: 'Android' }] } };
    renderWithProviders(
      <TuningForm project="proj" config={platforms_config} metrics={metrics} commit={commit} available_tests_files={{}}/>,
      { user: { is_logged: true, user_name: 'alice' }, siteConfig: {} },
    );
    fireEvent.click(screen.getByLabelText('Android'));
    expect(usePrefsStore.getState().tuning.proj.platform).toBe('android');
    fireEvent.click(await screen.findByText('Start 1 run'));
    await waitFor(() => expect(fetch.mock.calls.some(([url]) => url === '/api/v1/commit/abcdef12/batch?project=proj')).toBe(true));
    const [, init] = fetch.mock.calls.find(([url]) => url === '/api/v1/commit/abcdef12/batch?project=proj');
    expect(JSON.parse(init.body)).toMatchObject({ platform: 'android' });
  });

  it("asks for feedback where the site's users report issues", () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => json({ tests: [] }));
    usePrefsStore.getState().updateTuning('proj', { search_type: 'optimize' });
    renderWithProviders(<TuningForm project="proj" config={config} metrics={metrics} commit={commit} available_tests_files={{}}/>, { siteConfig: { support_url: 'mailto:qa-support@example.com' } });
    expect(screen.getByText('feedback').closest('a')).toHaveAttribute('href', 'mailto:qa-support@example.com');
  });

  it('asks before resetting the auto-tuning configuration', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => json({ tests: [] }));
    usePrefsStore.getState().updateTuning('proj', { search_type: 'optimize', parameter_search_auto: 'my: edits' });
    renderWithProviders(<TuningForm project="proj" config={config} metrics={metrics} commit={commit} available_tests_files={{}}/>, { siteConfig: {} });
    fireEvent.click(screen.getByText('Reset to the default'));
    expect(screen.getByTestId('editor-tuning-auto')).toHaveValue('my: edits');
    await act(async () => fireEvent.click(within(screen.getByRole('alertdialog')).getByText('Reset')));
    expect(usePrefsStore.getState().tuning.proj.parameter_search_auto).not.toBe('my: edits');
  });
});
