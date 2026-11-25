/**
 * The new Run Tests / Tuning form and the previous one: switching both ways, feedback, the batches changed for one
 * run, and the values typed in the table sent as the server expects.
 * Run with: cd webapp && npm test -- FormVersion
 */
import { screen, fireEvent, waitFor, within } from '@testing-library/react';

import { TuningForm } from '../forms';
import { renderWithProviders } from '../../../test-utils';
import { usePrefsStore } from '../../../stores/prefs';
import { toaster } from '../../../toaster';
import * as analytics from '../../../analytics';
import { changed_batches, batches_text_error, expand_selection, snapshot_for_this_run, FOR_THIS_RUN_FILE } from '../BatchesForThisRun';

vi.mock('../../MonacoEditor', () => ({
  default: ({ value, onChange, name }) => <textarea data-testid={name} value={value} onChange={e => onChange(e.target.value)}/>,
}));

const json = (data, status = 200) => Promise.resolve(new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }));
const config = { runners: { lsf: { user: 'runner' } }, inputs: {} };
const metrics = { default_metric: 'loss', main_metrics: ['loss'], available_metrics: { loss: { target: 1 } } };
const commit = { id: 'abcdef12', branch: 'master' };
const render = () => renderWithProviders(
  <TuningForm project="proj" config={config} metrics={metrics} commit={commit} available_tests_files={{ gr: 'extra-batches', usr: 'alice' }}/>,
  { user: { is_logged: true, user_name: 'alice' }, siteConfig: {} },
);

describe('the previous form', () => {
  beforeEach(() => usePrefsStore.setState({ tuning: {}, tuningForm: 'new' }));
  afterEach(() => vi.restoreAllMocks());

  it('goes back to the previous form, says why, and comes back', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => json({ tests: [] }));
    const track = vi.spyOn(analytics, 'track');
    render();
    expect(screen.getByTestId('batch-picker')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('tuning-form-previous'));
    fireEvent.click(await screen.findByText('Something I need is missing'));
    fireEvent.change(screen.getByLabelText(/What should we change/), { target: { value: 'x'.repeat(450) } });
    fireEvent.click(screen.getByTestId('tuning-form-go-back'));
    expect(usePrefsStore.getState().tuningForm).toBe('previous');
    // usage events keep strings of 200 characters: the comment goes in pieces
    expect(track).toHaveBeenCalledWith('tuning_form_feedback', { reasons: ['missing'], comment: ['x'.repeat(200), 'x'.repeat(200), 'x'.repeat(50)], switched_to: 'previous' }, { project_id: 'proj' });
    // the previous form, with the way back
    expect(await screen.findByTestId('tuning-form-banner')).toBeInTheDocument();
    expect(screen.queryByTestId('batch-picker')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Batch of inputs+configurations', { exact: false })).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('tuning-form-new'));
    expect(usePrefsStore.getState().tuningForm).toBe('new');
    expect(await screen.findByTestId('batch-picker')).toBeInTheDocument();
    expect(track).toHaveBeenLastCalledWith('tuning_form_feedback', { switched_to: 'new' }, { project_id: 'proj' });
  });

  it('takes feedback without leaving the new form', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => json({ tests: [] }));
    const track = vi.spyOn(analytics, 'track');
    render();
    fireEvent.click(screen.getByTestId('tuning-form-feedback'));
    const send = await screen.findByTestId('tuning-form-send-feedback');
    expect(send).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/What should we change/), { target: { value: 'Love the table' } });
    fireEvent.click(send);
    expect(track).toHaveBeenCalledWith('tuning_form_feedback', { reasons: undefined, comment: ['Love the table'], switched_to: undefined }, { project_id: 'proj' });
    expect(usePrefsStore.getState().tuningForm).toBe('new');
    expect(toaster.show).toHaveBeenCalledWith(expect.objectContaining({ message: 'Thanks for your feedback.' }), 'tuning-form-feedback');
  });
});

describe('the values typed in the table', () => {
  beforeEach(() => usePrefsStore.setState({ tuning: {}, tuningForm: 'new' }));
  afterEach(() => vi.restoreAllMocks());

  it('are sent as the server expects', async () => {
    usePrefsStore.getState().updateTuning('proj', { experiment_name: 'sweep', selected_group: 'smoke' });
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(url => url.startsWith('/api/v1/tests/group?')
      ? json({ tests: [{ input_path: 'a.jpg', configurations: [] }, { input_path: 'b.jpg', configurations: [] }] })
      : json({}));
    render();
    fireEvent.click(screen.getByTestId('parameters-add-0'));
    const row = screen.getByTestId('parameters-row-0-0');
    fireEvent.change(within(row).getByLabelText('Parameter name'), { target: { value: 'ccm' } });
    const values = within(row).getByLabelText('Values to try for ccm');
    // pasted: a matrix with a row per line
    fireEvent.paste(values, { clipboardData: { getData: () => '[[1, 0], [0, 1]], [1.2 0\n0 1], [1, 2' } });
    // what looks wrong is kept as text, and said
    expect(within(row).getByTestId('parameters-value-error')).toHaveTextContent('[1, 2: Not a valid list');
    fireEvent.click(screen.getByTestId('parameters-add-0'));
    const second = screen.getByTestId('parameters-row-0-1');
    fireEvent.change(within(second).getByLabelText('Parameter name'), { target: { value: 'mode' } });
    fireEvent.change(within(second).getByLabelText('Values to try for mode'), { target: { value: 'fast' } });
    fireEvent.keyDown(within(second).getByLabelText('Values to try for mode'), { key: 'Enter' });
    fireEvent.click(await screen.findByText('Start 6 runs'));
    await waitFor(() => expect(fetch.mock.calls.some(([url]) => url === '/api/v1/commit/abcdef12/batch?project=proj')).toBe(true));
    const [, init] = fetch.mock.calls.find(([url]) => url === '/api/v1/commit/abcdef12/batch?project=proj');
    expect(JSON.parse(init.body)).toMatchObject({
      batch_label: 'sweep',
      selected_group: 'smoke',
      tuning_search: { search_type: 'grid', search_options: {}, parameter_search: { ccm: [[[1, 0], [0, 1]], [[1.2, 0], [0, 1]], '[1, 2'], mode: ['fast'] } },
    });
    expect(JSON.parse(init.body).parameter_search_text).toBeUndefined();
  });
});

describe('the batches changed for this run', () => {
  beforeEach(() => usePrefsStore.setState({ tuning: {}, tuningForm: 'new' }));
  afterEach(() => vi.restoreAllMocks());

  it('reads what the sent files change', () => {
    expect(changed_batches([{ content: 'database: {linux: /x}\nnight: {inputs: [a]}\n.tpl: {}\naliases: {all: [night]}\n' }, { content: 'not: [valid' }])).toEqual(['night', 'all']);
    expect(changed_batches(null)).toEqual([]);
    expect(batches_text_error('night: {inputs: [a]}')).toBe(null);
    expect(batches_text_error('- a\n- b')).toMatch(/batch names/);
    expect(batches_text_error('night: [a')).toBeTruthy();
    const listed = [
      { name: 'night-1', kind: 'batch' }, { name: 'night-2', kind: 'batch' }, { name: 'day', kind: 'batch' },
      { name: 'all', kind: 'alias', batches: ['day', 'night-1'] },
    ];
    expect(expand_selection(['all', 'night-*', 'typed'], listed)).toEqual(['day', 'night-1', 'night-2', 'typed']);
    expect(snapshot_for_this_run(null, 'x: {}', ['x'])).toEqual({ for_this_run: true, files: [{ path: FOR_THIS_RUN_FILE, content: 'x: {}' }], names: ['x'] });
    // "Run again" keeps where they come from, and its other files (the alias of several batches)
    const again = { from: 'night', files: [{ path: 'batches.night.yaml', content: 'a: {}' }, { path: 'run-again.yaml', content: 'aliases: {}' }], names: ['a'] };
    expect(snapshot_for_this_run(again, 'a: {inputs: [b]}', ['a']).files).toEqual([{ path: 'batches.night.yaml', content: 'a: {inputs: [b]}' }, again.files[1]]);
  });

  it('edits the definitions of the chosen batches, sends them, and drops them', async () => {
    usePrefsStore.getState().updateTuning('proj', { experiment_name: 'sweep', selected_group: 'smoke' });
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(url => {
      if (url.startsWith('/api/v1/tests/batches?') && url.includes('definition=smoke')) return json({ definition: { inputs: ['a.jpg', 'b.jpg'], configs: ['base'] } });
      if (url.startsWith('/api/v1/tests/batches?')) return json({ batches: [{ name: 'smoke', kind: 'batch', files: ['qa/batches.yaml'], sources: ['commit'], inputs: 2 }] });
      if (url.startsWith('/api/v1/tests/group?')) return json({ tests: [{ input_path: 'a.jpg', configurations: ['base'] }] });
      return json({});
    });
    render();
    await screen.findByTestId('batch-smoke');
    fireEvent.click(screen.getByTestId('batch-change-for-this-run'));
    const editor = await screen.findByTestId('editor-batches-for-this-run');
    expect(editor.value).toContain('smoke:\n  inputs:\n    - a.jpg\n    - b.jpg\n  configs:\n    - base\n');
    expect(editor.value).toContain('# Changed for this run only');
    fireEvent.change(editor, { target: { value: 'smoke: [oops' } });
    fireEvent.click(screen.getByTestId('batches-for-this-run-apply'));
    expect(screen.getByTestId('batches-for-this-run-error')).toBeInTheDocument();
    fireEvent.change(editor, { target: { value: 'smoke:\n  inputs: [a.jpg]\n' } });
    fireEvent.click(screen.getByTestId('batches-for-this-run-apply'));
    const files = [{ path: FOR_THIS_RUN_FILE, content: 'smoke:\n  inputs: [a.jpg]\n' }];
    expect(usePrefsStore.getState().tuning.proj.batches_snapshot).toEqual({ for_this_run: true, files, names: ['smoke'] });
    expect(await screen.findByTestId('batches-for-this-run')).toHaveTextContent('smoke runs with the definitions you changed');
    expect(within(screen.getByTestId('batch-smoke')).getByText('for this run')).toBeInTheDocument();
    // the tests are listed with them, and they are sent when starting
    await waitFor(() => expect(fetch.mock.calls.some(([url, init]) => url.startsWith('/api/v1/tests/group?') && JSON.parse(init.body).batches_files?.[0]?.path === FOR_THIS_RUN_FILE)).toBe(true));
    fireEvent.click(await screen.findByText('Start 1 run'));
    await waitFor(() => expect(fetch.mock.calls.some(([url]) => url === '/api/v1/commit/abcdef12/batch?project=proj')).toBe(true));
    const [, init] = fetch.mock.calls.find(([url]) => url === '/api/v1/commit/abcdef12/batch?project=proj');
    expect(JSON.parse(init.body).batches_files).toEqual(files);
    fireEvent.click(screen.getByText('Discard the changes'));
    expect(usePrefsStore.getState().tuning.proj.batches_snapshot).toBeNull();
    expect(screen.queryByTestId('batches-for-this-run')).not.toBeInTheDocument();
  });
});
