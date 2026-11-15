/**
 * Tests for the tuning form.
 * Run with: cd webapp && npm test -- tuning
 */
import { screen, fireEvent, waitFor, act, within } from '@testing-library/react';

import { TuningForm, combinations_info, eval_combinations, branch_matches, suggest_label, unused_label } from '../forms';
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
    usePrefsStore.getState().updateTuning('proj', { experiment_name: 'exp', selected_group: 'nightly', parameter_search: '{"a": [1, 2]}', values_mode: 'text' });
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(url => url.startsWith('/api/v1/tests/group?')
      ? json({ tests: [{ input_path: 'a.jpg', configurations: ['base'] }, { input_path: 'b.jpg', configurations: ['base'] }] })
      : json({}));
    renderWithProviders(
      <TuningForm project="proj" config={config} metrics={metrics} commit={commit} available_tests_files={{ usr: 'usr.yaml' }}/>,
      { user: { is_logged: true, user_name: 'alice' }, siteConfig: {} },
    );
    expect(screen.getByDisplayValue('exp')).toBeInTheDocument();
    expect(await screen.findByText(/4 total runs/)).toBeInTheDocument();
    expect(fetch.mock.calls.map(([url]) => url)).toContain('/api/v1/tests/group?project=proj&name=nightly&commit=abcdef12');

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

  it('asks for an email when the batch ends, if the server can send them', async () => {
    usePrefsStore.getState().updateTuning('proj', { experiment_name: 'exp', selected_group: 'nightly' });
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(url => url.startsWith('/api/v1/tests/group?')
      ? json({ tests: [{ input_path: 'a.jpg', configurations: ['base'] }] })
      : url.startsWith('/api/v1/commit/abcdef12/batch?') ? json({ notification: { channel: 'email', recipient: 'alice@example.com' } }) : json({}));
    const { unmount } = renderWithProviders(
      <TuningForm project="proj" config={config} metrics={metrics} commit={commit} available_tests_files={{}}/>,
      { user: { is_logged: true, user_name: 'alice' }, siteConfig: {} },
    );
    // emails are not configured
    expect(screen.queryByTestId('tuning-email-note')).not.toBeInTheDocument();
    unmount();

    renderWithProviders(
      <TuningForm project="proj" config={config} metrics={metrics} commit={commit} available_tests_files={{}}/>,
      { user: { is_logged: true, user_name: 'alice' }, siteConfig: { email_notifications: true } },
    );
    expect(screen.getByTestId('tuning-email-note')).toHaveTextContent('QA-Board will email you when the last run ends.');
    fireEvent.click(await screen.findByText('Start 1 run'));
    await waitFor(() => expect(toaster.show).toHaveBeenCalledWith(expect.objectContaining({ message: 'Started exp. QA-Board will email alice@example.com when it ends.' }), 'tuning-exp'));
    const [, init] = fetch.mock.calls.find(([url]) => url === '/api/v1/commit/abcdef12/batch?project=proj');
    expect(JSON.parse(init.body).notify).toBe('email');
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
    expect(screen.getByText(/Choose the tests to run/)).toBeInTheDocument();
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
    expect(screen.getByText('Choose where runs execute').closest('a')).toHaveAttribute('href', '/qa/docs/runners');
  });

  it('lists the batches to choose from, and runs several together', async () => {
    usePrefsStore.getState().updateTuning('proj', { experiment_name: 'exp' });
    const batches = [
      { name: 'smoke', kind: 'batch', files: ['qa/batches.yaml'], sources: ['commit'], inputs: 2 },
      { name: 'mine', kind: 'batch', files: ['alice.yml'], sources: ['qaboard'], inputs: 1 },
      { name: 'nightly', kind: 'alias', batches: ['night-1', 'night-2'] },
    ];
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(url => {
      if (url.startsWith('/api/v1/tests/batches?')) return json({ batches, files: [], warnings: [] });
      if (url.startsWith('/api/v1/tests/group?')) {
        const names = new URL(url, 'http://qa').searchParams;
        const n = [...names.getAll('name'), ...names.getAll('name[]')].length;
        return json({ tests: Array.from({ length: n }, (_, i) => ({ input_path: `${i}.jpg`, configurations: ['base'] })) });
      }
      return json({});
    });
    renderWithProviders(
      <TuningForm project="proj" config={config} metrics={metrics} commit={commit} available_tests_files={{ gr: 'extra-batches', usr: 'alice' }}/>,
      { user: { is_logged: true, user_name: 'alice' }, siteConfig: {} },
    );
    // grouped by who can change them, with what they hold
    const smoke = await screen.findByTestId('batch-smoke');
    expect(smoke).toHaveTextContent('2 inputs');
    expect(screen.getByTestId('batch-nightly')).toHaveTextContent('2 batches');
    expect(screen.getByText('Yours')).toBeInTheDocument();
    expect(screen.getByText('From the code')).toBeInTheDocument();
    expect(screen.getByText('Choose what to run')).toBeInTheDocument();
    expect(fetch.mock.calls.find(([url]) => url.startsWith('/api/v1/tests/batches?'))[0]).toBe('/api/v1/tests/batches?project=proj&commit=abcdef12');

    fireEvent.click(within(smoke).getByRole('checkbox'));
    expect(usePrefsStore.getState().tuning.proj.selected_group).toBe('smoke');
    expect(await screen.findByText('1 test')).toBeInTheDocument();
    fireEvent.click(within(screen.getByTestId('batch-nightly')).getByRole('checkbox'));
    expect(usePrefsStore.getState().tuning.proj.selected_group).toBe('smoke, nightly');
    expect(await screen.findByText('2 tests')).toBeInTheDocument();
    expect(fetch.mock.calls.map(([url]) => url)).toContain('/api/v1/tests/group?project=proj&name%5B%5D=smoke&name%5B%5D=nightly&commit=abcdef12');

    // a pattern, or a name the list doesn't have
    const search = screen.getByLabelText('Find a batch, or type a name');
    fireEvent.change(search, { target: { value: 'night-*' } });
    expect(screen.getByTestId('batch-use-typed')).toHaveTextContent('every batch it matches');
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(usePrefsStore.getState().tuning.proj.selected_group).toBe('smoke, nightly, night-*');
    expect(screen.getByTestId('batch-night-*')).toHaveTextContent('pattern');

    fireEvent.click(await screen.findByText('Start 3 runs'));
    await waitFor(() => expect(fetch.mock.calls.some(([url]) => url === '/api/v1/commit/abcdef12/batch?project=proj')).toBe(true));
    const [, init] = fetch.mock.calls.find(([url]) => url === '/api/v1/commit/abcdef12/batch?project=proj');
    expect(JSON.parse(init.body)).toMatchObject({ selected_group: 'smoke, nightly, night-*', batches: ['smoke', 'nightly', 'night-*'] });
  });

  it('edits the values to try in a table, over the text', async () => {
    usePrefsStore.getState().updateTuning('proj', { experiment_name: 'exp', selected_group: 'nightly' });
    vi.spyOn(globalThis, 'fetch').mockImplementation(url => url.startsWith('/api/v1/tests/group?')
      ? json({ tests: [{ input_path: 'a.jpg', configurations: ['base'] }, { input_path: 'b.jpg', configurations: ['base'] }] })
      : json({}));
    const known = { ...commit, batches: { default: { outputs: { 1: { extra_parameters: { threshold: 1 } } } } } };
    renderWithProviders(
      <TuningForm project="proj" config={config} metrics={metrics} commit={known} available_tests_files={{}}/>,
      { user: { is_logged: true, user_name: 'alice' }, siteConfig: {} },
    );
    expect(await screen.findByText('2 total runs')).toBeInTheDocument();
    expect(screen.getByTestId('parameters-summary')).toHaveTextContent('No tuning');

    fireEvent.click(screen.getByTestId('parameters-add-0'));
    const row = screen.getByTestId('parameters-row-0-0');
    // a row being written is not counted
    expect(row).toHaveTextContent('Not counted until it has a name');
    expect(usePrefsStore.getState().tuning.proj.parameter_search ?? '').toBe('');
    // names the commit's runs were tuned with are suggested
    expect(document.querySelector('datalist option[value="threshold"]')).not.toBeNull();
    fireEvent.change(within(row).getByLabelText('Parameter name'), { target: { value: 'threshold' } });
    const values = within(row).getByLabelText('Values to try for threshold');
    fireEvent.change(values, { target: { value: '0.1, 0.2, [1, 2], on' } });
    fireEvent.keyDown(values, { key: 'Enter' });
    expect(usePrefsStore.getState().tuning.proj.parameter_search).toBe('{\n  "threshold": [0.1, 0.2, [1, 2], "on"]\n}');
    expect(row).toHaveTextContent('4 values');
    expect(await screen.findByText('8 total runs')).toBeInTheDocument();
    expect(screen.getByText('= 2 tests × 4 combinations')).toBeInTheDocument();
    expect(screen.getByText('Start 8 runs')).toBeInTheDocument();

    // evenly spaced values, between the lowest and highest it has
    fireEvent.click(within(row).getByLabelText('Evenly spaced values for threshold'));
    expect(await screen.findByTestId('parameters-range-preview')).toHaveTextContent('0.1, 0.125, 0.15, 0.175, 0.2');
    fireEvent.change(screen.getByLabelText('From'), { target: { value: '0' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '1' } });
    expect(screen.getByTestId('parameters-range-preview')).toHaveTextContent('0, 0.25, 0.5, 0.75, 1');
    fireEvent.click(screen.getByText('Replace its values'));
    expect(usePrefsStore.getState().tuning.proj.parameter_search).toBe('{\n  "threshold": [0, 0.25, 0.5, 0.75, 1]\n}');

    // the text is one click away, and what it says shows in the table
    fireEvent.click(screen.getByText('Text'));
    const editor = screen.getByTestId('editor-tuning-set');
    expect(editor).toHaveValue('{\n  "threshold": [0, 0.25, 0.5, 0.75, 1]\n}');
    fireEvent.change(editor, { target: { value: '[{"low": 1, "high": 2}, {"low": 3, "high": [4, 5]}]' } });
    fireEvent.click(screen.getByText('Table'));
    expect(screen.getByTestId('parameters-set-1')).toHaveTextContent('2 combinations');
    expect(screen.getByTestId('parameters-summary')).toHaveTextContent('2 parameters, 3 combinations in 2 sets');

    // functions stay text
    act(() => usePrefsStore.getState().updateTuning('proj', { parameter_search: 'return {a: [1, 2]}' }));
    expect(screen.getByTestId('tuning-text-only')).toHaveTextContent('This is a function');
    expect(screen.queryByTestId('parameters-table')).not.toBeInTheDocument();
    expect(await screen.findByText('4 total runs')).toBeInTheDocument();
    fireEvent.click(screen.getByText('start over with the table'));
    expect(screen.getByTestId('parameters-table')).toBeInTheDocument();
  });

  it('starts from a previous batch, and undoes it', async () => {
    usePrefsStore.getState().updateTuning('proj', { experiment_name: 'draft', selected_group: 'smoke' });
    const history = [
      {
        id: 's2', created_at: '2026-11-10T09:00:00Z', user: 'alice', status: 'done', batch_label: 'sharpen-sweep', commit_id: 'ffff0000', branch: 'feature/sharpen', message: 'Sharpen more',
        request: { batch_label: 'sharpen-sweep', selected_group: 'low-light, hdr', batches: ['low-light', 'hdr'], overwrite: false, tuning_search: { search_type: 'sampler', search_options: { n_iter: 4 }, parameter_search: { radius: [1, 2, 3], amount: [0.5, 1] } } },
      },
      {
        id: 's1', created_at: '2026-11-01T09:00:00Z', user: 'alice', status: 'failed', batch_label: 'big', commit_id: 'abcdef12', branch: 'master',
        request: { batch_label: 'big', selected_group: 'all', overwrite: true, truncated: true, tuning_search: { search_type: 'grid', search_options: {}, parameter_search: null } },
      },
    ];
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(url => url.startsWith('/api/v1/tuning/history?') ? json({ history }) : json({ tests: [] }));
    renderWithProviders(
      <TuningForm project="proj" config={config} metrics={metrics} commit={commit} available_tests_files={{}}/>,
      { user: { is_logged: true, user_name: 'alice' }, siteConfig: {} },
    );
    // asked when the list opens
    expect(fetch.mock.calls.some(([url]) => url.startsWith('/api/v1/tuning/history'))).toBe(false);
    fireEvent.click(screen.getByTestId('tuning-start-from'));
    const entry = await screen.findByTestId('history-s2');
    expect(fetch.mock.calls.map(([url]) => url)).toContain('/api/v1/tuning/history?project=proj&scope=mine');
    expect(entry).toHaveTextContent('low-light, hdr');
    expect(entry).toHaveTextContent('radius, amount: 4 combinations of 6');
    expect(entry).toHaveTextContent('feature/sharpen');
    expect(screen.getByTestId('history-s1')).toHaveTextContent('failed to start');
    expect(screen.getByTestId('history-s1')).toHaveTextContent('this commit');

    fireEvent.click(entry);
    expect(usePrefsStore.getState().tuning.proj).toMatchObject({
      experiment_name: 'sharpen-sweep',
      selected_group: 'low-light, hdr',
      overwrite: false,
      search_type: 'sampler',
      search_options: { n_iter: 4 },
      parameter_search: '{\n  "radius": [1, 2, 3],\n  "amount": [0.5, 1]\n}',
    });
    expect(screen.getByDisplayValue('sharpen-sweep')).toBeInTheDocument();
    const toast = toaster.show.mock.calls.find(([, key]) => key === 'tuning-start-from')[0];
    expect(toast.message).toBe('Filled like sharpen-sweep. Change what you want, then start.');
    act(() => toast.action.onClick());
    expect(usePrefsStore.getState().tuning.proj).toMatchObject({ experiment_name: 'draft', selected_group: 'smoke' });
    expect(usePrefsStore.getState().tuning.proj.parameter_search).toBeUndefined();

    // everyone's batches
    fireEvent.click(screen.getByTestId('tuning-start-from'));
    fireEvent.click(await screen.findByText('Everyone’s'));
    await waitFor(() => expect(fetch.mock.calls.map(([url]) => url)).toContain('/api/v1/tuning/history?project=proj&scope=all'));
  });

  it('says when the label is a batch of the commit, and what happens to its runs', async () => {
    usePrefsStore.getState().updateTuning('proj', { experiment_name: 'sweep', selected_group: 'smoke' });
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => json({ tests: [{ input_path: 'a.jpg', configurations: [] }] }));
    const with_batches = { ...commit, batches: { sweep: { label: 'sweep', valid_outputs: 10, failed_outputs: 2, outputs: {} }, 'sweep-2': { label: 'sweep-2', outputs: {} } } };
    renderWithProviders(
      <TuningForm project="proj" config={config} metrics={metrics} commit={with_batches} available_tests_files={{}}/>,
      { user: { is_logged: true, user_name: 'alice' }, siteConfig: {} },
    );
    const callout = screen.getByTestId('tuning-existing-batch');
    expect(callout).toHaveTextContent('sweep already exists on this commit, with 12 runs: the new runs are added to it. Runs it already has run again');
    fireEvent.click(within(callout).getByText("Keep its runs, only start what's missing"));
    expect(usePrefsStore.getState().tuning.proj.overwrite).toBe(false);
    expect(screen.getByTestId('tuning-existing-batch')).toHaveTextContent('Runs it already has are kept: only the missing ones start.');
    fireEvent.click(within(screen.getByTestId('tuning-existing-batch')).getByText(/instead/));
    expect(usePrefsStore.getState().tuning.proj.experiment_name).toBe('sweep-3');
    expect(screen.queryByTestId('tuning-existing-batch')).not.toBeInTheDocument();
  });

  it('suggests a label from what runs', async () => {
    usePrefsStore.getState().updateTuning('proj', { selected_group: 'low light, hdr', parameter_search: '{"denoise.strength": [1, 2]}' });
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => json({ tests: [] }));
    renderWithProviders(<TuningForm project="proj" config={config} metrics={metrics} commit={commit} available_tests_files={{}}/>, { user: { is_logged: true, user_name: 'alice' }, siteConfig: {} });
    fireEvent.click(screen.getByTestId('tuning-suggest-label'));
    expect(usePrefsStore.getState().tuning.proj.experiment_name).toBe('tune-strength');
    expect(suggest_label({ selection: ['night-*'], sets: [[]], search_type: 'grid' })).toBe('run-night');
    expect(suggest_label({ selection: ['hdr'], sets: [[]], search_type: 'optimize' })).toBe('auto-tuning-hdr');
    expect(suggest_label({ selection: [], sets: [[]], search_type: 'grid' })).toBe('');
    expect(unused_label('sweep-2', { 'sweep-2': {}, 'sweep-3': {} })).toBe('sweep-4');
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
    const { unmount } = renderWithProviders(<TuningForm project="proj" config={config} metrics={metrics} commit={commit} available_tests_files={{}}/>, { siteConfig: { support_url: 'mailto:qa-support@example.com' } });
    expect(screen.getByText('feedback').closest('a')).toHaveAttribute('href', 'mailto:qa-support@example.com');
    unmount();
    // sites without a support page (QABOARD_SUPPORT_URL=""): no feedback link
    renderWithProviders(<TuningForm project="proj" config={config} metrics={metrics} commit={commit} available_tests_files={{}}/>, { siteConfig: { support_url: '' } });
    expect(screen.getByTestId('optimize-summary')).toBeInTheDocument();
    expect(screen.queryByText('feedback')).not.toBeInTheDocument();
  });

  it('shows both ways to choose the values, and suggests searching a big grid automatically', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => json({ tests: [] }));
    usePrefsStore.getState().updateTuning('proj', { parameter_search: '{"threshold": [0.1, 0.2, 0.3, 0.4], "size": [3, 5, 7], "mode": ["a"]}' });
    renderWithProviders(<TuningForm project="proj" config={config} metrics={{ ...metrics, available_metrics: { loss: { smaller_is_better: true } } }} commit={commit} available_tests_files={{}}/>, { siteConfig: {} });
    expect(screen.getByRole('radio', { name: /Choose the values/ })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByRole('radio', { name: /Search automatically/ })).toHaveAttribute('aria-checked', 'false');
    // 12 combinations: a search would need about as many evaluations, with values in between... only suggested when fewer
    expect(screen.queryByTestId('tuning-suggest-auto')).toBeNull();
    await act(async () => usePrefsStore.getState().updateTuning('proj', { parameter_search: '{"threshold": [0.1, 0.2, 0.3, 0.4, 0.5], "size": [3, 5, 7, 9, 11], "mode": ["a"]}' }));
    expect(screen.getByTestId('tuning-suggest-auto')).toHaveTextContent('25 combinations');
    await act(async () => fireEvent.click(screen.getByRole('button', { name: 'Search these ranges automatically' })));
    const form = usePrefsStore.getState().tuning.proj;
    expect(form.search_type).toBe('optimize');
    expect(form.parameter_search_auto).toContain('name: threshold');
    expect(form.parameter_search_auto).toContain('loss: min');
    expect(form.parameter_search_auto).toContain('mode: a');
    expect(screen.getByRole('radio', { name: /Search automatically/ })).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByTestId('optimize-summary')).toBeInTheDocument();
    // back to the values they listed
    await act(async () => fireEvent.click(screen.getByTestId('tuning-mode-manual')));
    expect(usePrefsStore.getState().tuning.proj.search_type).toBe('grid');
  });

  it('says how to get metrics when the runs return none', () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => json({ tests: [] }));
    usePrefsStore.getState().updateTuning('proj', { search_type: 'optimize' });
    renderWithProviders(<TuningForm project="proj" config={config} metrics={{ available_metrics: {}, main_metrics: [] }} commit={commit} available_tests_files={{}}/>, { siteConfig: {} });
    expect(screen.getByTestId('optimize-no-metrics')).toHaveTextContent("This commit's runs return no metrics yet");
  });

  it('asks before starting the automated tuning over', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => json({ tests: [] }));
    usePrefsStore.getState().updateTuning('proj', { search_type: 'optimize', optimize_mode: 'yaml', parameter_search_auto: 'my: edits' });
    renderWithProviders(<TuningForm project="proj" config={config} metrics={metrics} commit={commit} available_tests_files={{}}/>, { siteConfig: {} });
    fireEvent.click(screen.getByText('Start over'));
    expect(screen.getByTestId('editor-tuning-auto')).toHaveValue('my: edits');
    await act(async () => fireEvent.click(within(screen.getByRole('alertdialog')).getByText('Start over')));
    expect(usePrefsStore.getState().tuning.proj.parameter_search_auto).not.toBe('my: edits');
  });

  it('builds the automated tuning step by step, and starts it once it is complete', async () => {
    usePrefsStore.getState().updateTuning('proj', { experiment_name: 'tune', selected_group: 'nightly', search_type: 'optimize' });
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(url => url.startsWith('/api/v1/tests/group?')
      ? json({ tests: [{ input_path: 'a.jpg', configurations: [] }, { input_path: 'b.jpg', configurations: [] }] })
      : json({ errors: [], warnings: [] }));
    renderWithProviders(
      <TuningForm project="proj" config={config} metrics={metrics} commit={commit} available_tests_files={{}}/>,
      { user: { is_logged: true, user_name: 'alice' }, siteConfig: {} },
    );
    // the template improves the default metric, and needs parameters
    expect(screen.getByText('Add the parameters to tune')).toBeInTheDocument();
    expect(screen.getByTestId('tuning-start')).toBeDisabled();
    fireEvent.click(screen.getByTestId('add-parameter'));
    fireEvent.change(screen.getByLabelText('Parameter name'), { target: { value: 'threshold' } });
    fireEvent.change(screen.getByLabelText('To'), { target: { value: '0.5' } });
    expect(await screen.findByText('Ready to start')).toBeInTheDocument();
    // two tests per evaluation
    expect(await screen.findByText(/up to 60 runs/)).toBeInTheDocument();
    const start = screen.getByTestId('tuning-start');
    expect(start).toHaveTextContent('Start automated tuning');
    expect(start).toBeEnabled();
    fireEvent.click(start);
    await waitFor(() => expect(fetch.mock.calls.some(([url]) => url === '/api/v1/commit/abcdef12/batch?project=proj')).toBe(true));
    const [, init] = fetch.mock.calls.find(([url]) => url === '/api/v1/commit/abcdef12/batch?project=proj');
    const body = JSON.parse(init.body);
    expect(body.tuning_search.search_type).toBe('optimize');
    expect(body.tuning_search.parameter_search).toContain('name: threshold');
    expect(body.tuning_search.parameter_search).toContain('high: 0.5');
  });

  it("asks which way is better for metrics nothing declared, and writes it in the YAML", () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => json({ tests: [] }));
    usePrefsStore.getState().updateTuning('proj', { search_type: 'optimize', parameter_search_auto: 'evaluations: 20\nobjective:\n  psnr: {}\nsearch_space:\n  - Real: {name: x, low: 0, high: 1}\n' });
    renderWithProviders(<TuningForm project="proj" config={config} metrics={metrics} commit={commit} available_tests_files={{}}/>, { siteConfig: {} });
    expect(screen.getByText(/Say whether higher or lower values of psnr are better/)).toBeInTheDocument();
    fireEvent.click(within(screen.getByTestId('objective-psnr')).getByText('Higher is better'));
    expect(usePrefsStore.getState().tuning.proj.parameter_search_auto).toContain('psnr: max');
    expect(screen.queryByText(/Say whether higher or lower values of psnr are better/)).not.toBeInTheDocument();
  });

  it('offers the metrics the runs returned, and any other', () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => json({ tests: [] }));
    const with_runs = { ...commit, batches: { ci: { label: 'ci', outputs: { 1: { metrics: { psnr: 31.2 } } } } } };
    usePrefsStore.getState().updateTuning('proj', { search_type: 'optimize', parameter_search_auto: 'evaluations: 20\nobjective:\n  loss: min\nsearch_space:\n  - Real: {name: x, low: 0, high: 1}\n' });
    renderWithProviders(<TuningForm project="proj" config={config} metrics={metrics} commit={with_runs} available_tests_files={{}}/>, { siteConfig: {} });
    fireEvent.change(screen.getByLabelText('Add a metric'), { target: { value: 'psnr' } });
    expect(usePrefsStore.getState().tuning.proj.parameter_search_auto).toContain('psnr: {}');
    fireEvent.change(screen.getByLabelText('Add a metric'), { target: { value: '\u0000other' } });
    fireEvent.change(screen.getByLabelText("The metric's key"), { target: { value: 'ssim' } });
    fireEvent.click(screen.getByText('Add'));
    expect(usePrefsStore.getState().tuning.proj.parameter_search_auto).toContain('ssim: {}');
  });

  it('continues an automated tuning that has the same label, only with a bigger budget', () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => json({ tests: [] }));
    const tuned = { ...commit, batches: { 'tune': { label: 'tune', data: { optimization: true, iteration: 20, evaluations_completed: 20, evaluations_failed: 0, optimization_config: { config: { evaluations: 20 } } } } } };
    usePrefsStore.getState().updateTuning('proj', { experiment_name: 'tune', selected_group: 'nightly', search_type: 'optimize', parameter_search_auto: 'evaluations: 20\nobjective:\n  loss: {}\nsearch_space:\n  - Real: {name: x, low: 0, high: 1}\n' });
    renderWithProviders(<TuningForm project="proj" config={config} metrics={metrics} commit={tuned} available_tests_files={{}}/>, { user: { is_logged: true, user_name: 'alice' }, siteConfig: {} });
    expect(screen.getByTestId('optimize-continuing')).toHaveTextContent('continues it');
    expect(screen.getByTestId('tuning-start')).toBeDisabled();
    fireEvent.click(screen.getByText('Use 30'));
    expect(usePrefsStore.getState().tuning.proj.parameter_search_auto).toContain('evaluations: 30');
    expect(screen.getByText('10 more evaluations')).toBeInTheDocument();
  });
});


describe('TuningForm checks', () => {
  beforeEach(() => usePrefsStore.setState({ tuning: {} }));
  afterEach(() => vi.restoreAllMocks());

  it('asks logged-out users to log in, without requests that need a login', async () => {
    usePrefsStore.getState().updateTuning('proj', { experiment_name: 'exp', selected_group: 'nightly' });
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(() => json({}));
    renderWithProviders(
      <TuningForm project="proj" config={config} metrics={metrics} commit={commit} available_tests_files={{}}/>,
      { user: { is_logged: false }, siteConfig: {} },
    );
    expect(screen.getByTestId('tuning-login')).toBeInTheDocument();
    expect(screen.getByTestId('tuning-start')).toBeDisabled();
    await new Promise(resolve => setTimeout(resolve, 700));
    expect(fetch.mock.calls.filter(([url]) => url.includes('/tests/group') || url.includes('/batch/check'))).toEqual([]);
  });

  it('shows what the server says would fail, and blocks Send', async () => {
    usePrefsStore.getState().updateTuning('proj', { experiment_name: 'exp', selected_group: 'nightly', parameter_search: '{"a": [1, 2]}' });
    vi.spyOn(globalThis, 'fetch').mockImplementation(url => {
      if (url.startsWith('/api/v1/tests/group?')) return json({ tests: [{ input_path: 'a.jpg', configurations: [] }] });
      if (url.startsWith('/api/v1/commit/abcdef12/batch/check')) return json({ errors: ['Unknown batch: nightly.'], warnings: ['The artifacts are missing.'] });
      return json({});
    });
    renderWithProviders(
      <TuningForm project="proj" config={config} metrics={metrics} commit={commit} available_tests_files={{}}/>,
      { user: { is_logged: true, user_name: 'alice' }, siteConfig: {} },
    );
    expect(await screen.findByText('Unknown batch: nightly.', {}, { timeout: 2000 })).toBeInTheDocument();
    expect(screen.getByText('The artifacts are missing.')).toBeInTheDocument();
    expect(screen.getByTestId('tuning-start')).toBeDisabled();
  });
});
