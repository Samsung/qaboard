/**
 * Run Tests / Tuning's list of batches: editing them from the form.
 * Run with: cd webapp && npm test -- BatchPicker
 */
import { screen, fireEvent, waitFor, within } from '@testing-library/react';

import { BatchPicker, parse_selection, format_selection } from '../BatchPicker';
import { renderWithProviders } from '../../../test-utils';
import { useAvailableTestsRequest } from '../availableTests';
import { toaster } from '../../../toaster';

let unsaved = false;
vi.mock('../BatchesEditor', () => ({
  BatchesEditor: ({ available_tests_files }) => <div data-testid="batches-editor">editing {available_tests_files.usr}</div>,
  hasUnsavedDraft: () => unsaved,
}));

const json = (data, status = 200) => Promise.resolve(new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json' } }));
const text = body => Promise.resolve(new Response(body, { status: 200, headers: { 'Content-Type': 'text/html' } }));

const batches = [
  { name: 'smoke', kind: 'batch', files: ['qa/batches.yaml'], sources: ['commit'], inputs: 2 },
  { name: 'mine', kind: 'batch', files: ['alice.yml'], sources: ['qaboard'], inputs: 1 },
  { name: 'team', kind: 'batch', files: ['extra-batches.yml'], sources: ['qaboard'], inputs: 4, configurations: 2 },
];
const no_tests = { group_info: { tests: [] }, loading: false, error: null };
const props = { project: 'proj', commit: { id: 'abcdef12' }, tests: no_tests, available_tests_files: { gr: 'extra-batches', usr: 'alice' }, is_logged: true };

describe('BatchPicker', () => {
  beforeEach(() => { unsaved = false; useAvailableTestsRequest.setState({ request: null }); });
  afterEach(() => vi.restoreAllMocks());

  it('remembers the batches as text', () => {
    expect(parse_selection(' ci,  night-* ,,')).toEqual(['ci', 'night-*']);
    expect(parse_selection(undefined)).toEqual([]);
    expect(format_selection(['ci', 'night-*'])).toBe('ci, night-*');
  });

  it('shows the tests of the chosen batches, and filters the batches', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => json({ batches }));
    const tests = { group_info: { tests: Array.from({ length: 12 }, (_, i) => ({ input_path: `img/${i}.jpg`, configurations: ['base', { iso: 800 }] })) }, loading: false, error: null };
    const onChange = vi.fn();
    renderWithProviders(<BatchPicker {...props} value="smoke" onChange={onChange} tests={tests}/>);
    expect(await screen.findByTestId('batch-team')).toHaveTextContent('4 inputs · 2 configs');
    const listed = screen.getByTestId('batch-tests');
    expect(listed).toHaveTextContent('12 tests');
    expect(listed).toHaveTextContent('img/11.jpg');
    expect(listed).toHaveTextContent('{"iso":800}');
    fireEvent.change(screen.getByLabelText('Filter the tests'), { target: { value: 'img/3' } });
    expect(listed).not.toHaveTextContent('img/11.jpg');
    expect(listed).toHaveTextContent('img/3.jpg');

    fireEvent.change(screen.getByLabelText('Find a batch, or type a name'), { target: { value: 'tea' } });
    expect(screen.queryByTestId('batch-mine')).not.toBeInTheDocument();
    // Enter picks the only match
    fireEvent.keyDown(screen.getByLabelText('Find a batch, or type a name'), { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('smoke, team');
    fireEvent.click(screen.getByText('Clear'));
    expect(onChange).toHaveBeenCalledWith('');
  });

  it('edits a batch of QA-Board in a panel, at the batch', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => json({ batches }));
    renderWithProviders(<BatchPicker {...props} value="" onChange={() => {}}/>);
    fireEvent.click(within(await screen.findByTestId('batch-mine')).getByLabelText('Edit mine'));
    expect(await screen.findByTestId('batches-editor')).toHaveTextContent('editing alice');
    expect(useAvailableTestsRequest.getState().request).toMatchObject({ file: 'alice', batch: 'mine' });
  });

  it("copies a batch of the code to the user's batches, to change it", async () => {
    const posted = [];
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation((url, init) => {
      if (url.startsWith('/api/v1/tests/batches?') && url.includes('definition=smoke'))
        return json({ batches: [...batches, { name: 'smoke-copy', kind: 'batch', files: ['alice.yml'], sources: ['qaboard'] }], definition: { inputs: ['a.jpg', 'b.jpg'], database: { linux: '/mnt/db' } } });
      if (url.startsWith('/api/v1/tests/batches?')) return json({ batches });
      if (url.startsWith('/api/v1/tests/groups?') && init?.method === 'POST') { posted.push(JSON.parse(init.body)); return json('OK'); }
      if (url.startsWith('/api/v1/tests/groups?')) return text('mine:\n  inputs: [x]\n');
      return json({});
    });
    const onChange = vi.fn();
    renderWithProviders(<BatchPicker {...props} value="smoke, team" onChange={onChange}/>);
    await screen.findByTestId('batch-mine');
    fireEvent.click(within(await screen.findByTestId('batch-smoke')).getByLabelText('Copy smoke to your batches'));
    await waitFor(() => expect(posted).toHaveLength(1));
    // a name that is free, after what the file had, with the file's defaults that applied to the batch
    expect(posted[0].groups).toBe('mine:\n  inputs: [x]\n\n# A copy of smoke\nsmoke-copy-2:\n  inputs:\n    - a.jpg\n    - b.jpg\n  database:\n    linux: /mnt/db\n');
    expect(fetch.mock.calls.find(([url, init]) => url.startsWith('/api/v1/tests/groups?') && init?.method === 'POST')[0]).toBe('/api/v1/tests/groups?project=proj&name=alice');
    // the copy replaces the batch in what runs, and opens in the editor
    await waitFor(() => expect(onChange).toHaveBeenCalledWith('smoke-copy-2, team'));
    expect(useAvailableTestsRequest.getState().request).toMatchObject({ file: 'alice', batch: 'smoke-copy-2' });
  });

  it("doesn't write over unsaved changes", async () => {
    unsaved = true;
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(() => json({ batches }));
    const onChange = vi.fn();
    renderWithProviders(<BatchPicker {...props} value="smoke" onChange={onChange}/>);
    // until the list is there, we don't say the chosen batch is unknown
    expect(screen.getByTestId('batch-smoke')).not.toHaveTextContent('not in the batch files');
    await screen.findByTestId('batch-mine');
    fireEvent.click(within(await screen.findByTestId('batch-smoke')).getByLabelText('Copy smoke to your batches'));
    await waitFor(() => expect(toaster.show).toHaveBeenCalledWith(expect.objectContaining({ message: 'Your batches have unsaved changes: save or discard them first.' })));
    expect(fetch.mock.calls.some(([url]) => url.startsWith('/api/v1/tests/groups'))).toBe(false);
    expect(onChange).not.toHaveBeenCalled();
    expect(await screen.findByTestId('batches-editor')).toBeInTheDocument();
  });

  it('says when nothing is defined, or when listing failed', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(() => json({}));
    const { unmount } = renderWithProviders(<BatchPicker {...props} value="" onChange={() => {}}/>);
    expect(await screen.findByText(/No batch is defined yet/)).toBeInTheDocument();
    unmount();
    renderWithProviders(<BatchPicker {...props} is_logged={false} value="" onChange={() => {}}/>);
    expect(screen.getByText('Sign in to list the batches.')).toBeInTheDocument();
  });
});
