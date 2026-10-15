/**
 * Tests for the tuning form.
 * Run with: cd webapp && npm test -- tuning
 */
import { screen, fireEvent, waitFor, act } from '@testing-library/react';

import { TuningForm, combinations_info, eval_combinations } from '../forms';
import { renderWithProviders } from '../../../test-utils';
import { usePrefsStore } from '../../../stores/prefs';
import { userQuery } from '../../../api/queries';

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

    fireEvent.click(screen.getByText('Send'));
    await waitFor(() => expect(fetch.mock.calls.some(([url]) => url === '/api/v1/commit/abcdef12/batch?project=proj')).toBe(true));
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
    expect(screen.getByText(/Please give a name to the tuning experiment/)).toBeInTheDocument();
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
});
