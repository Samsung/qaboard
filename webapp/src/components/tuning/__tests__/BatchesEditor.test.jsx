/**
 * Tests for the "Available Tests" view, that edits the files defining batches.
 * Run with: cd webapp && npm test -- BatchesEditor
 */
import { screen, fireEvent, waitFor, within } from '@testing-library/react';
import { act } from 'react';

import { BatchesEditor } from '../BatchesEditor';
import { toaster } from '../../../toaster';
import { http } from '../../../api/http';
import { history } from '../../../router';
import { usePrefsStore } from '../../../stores/prefs';
import { renderWithProviders } from '../../../test-utils';

vi.mock('../../../api/http', async importOriginal => ({ ...await importOriginal(), http: { get: vi.fn(), post: vi.fn() } }));
const render = ui => renderWithProviders(ui);

// Monaco doesn't run in jsdom
const fakeEditor = {
  getModel: () => null,
  revealLineInCenter: vi.fn(),
  setPosition: vi.fn(),
  focus: vi.fn(),
};
vi.mock('../../MonacoEditor', () => ({
  default: ({ value, onChange, editorDidMount, path }) => {
    editorDidMount?.(fakeEditor, undefined);
    return <textarea aria-label={`editor ${path}`} value={value} onChange={e => onChange(e.target.value)} />;
  },
  MonacoDiffEditor: ({ original, value }) => <div data-testid="diff">{original} =&gt; {value}</div>,
}));


let server;
const props = {
  project: 'group/repo/sub',
  commit: { id: 'abc123' },
  config: { inputs: { batches: ['{subproject}/batches.yaml'], database: { linux: '/mnt/db' } } },
  git: { path_with_namespace: 'group/repo' },
  web_url: 'https://git/group/repo',
  available_tests_files: { gr: 'extra-batches', usr: 'alice' },
  docs_root: '/',
};

beforeEach(() => {
  localStorage.clear();
  server = {
    'extra-batches': 'shared-batch:\n  inputs: [a.jpg]\n',
    alice: 'my-batch:\n  inputs:\n  - a.jpg\n  - b.jpg\naliases:\n  all: [my-batch, shared-batch]\n',
  };
  http.get.mockReset().mockImplementation((url, { params }) => Promise.resolve({ data: server[params.name] }));
  http.post.mockReset().mockImplementation((url, data, { params }) => {
    server[params.name] = data.groups;
    return Promise.resolve({ data: 'OK' });
  });
});
afterEach(() => act(() => toaster.clear()));

const editor = () => screen.findByLabelText('editor alice.yml');
const type = async text => fireEvent.change(await editor(), { target: { value: text } });
const pressSave = () => fireEvent.keyDown(document, { key: 's', ctrlKey: true });


it('shows the private file, its batches and where batches come from', async () => {
  render(<BatchesEditor {...props} />);
  expect(await editor()).toHaveValue(server.alice);
  expect(screen.getByText('No changes')).toBeInTheDocument();

  const outline = screen.getByRole('list', { name: 'Batches' });
  expect(within(outline).getByText('my-batch')).toBeInTheDocument();
  expect(within(outline).getByText('2 inputs')).toBeInTheDocument();
  expect(within(outline).getByText('alias → my-batch, shared-batch')).toBeInTheDocument();

  // the commit's files, with the subproject filled in, linked like the git host does (GitLab unless we know better)
  expect(screen.getByRole('link', { name: 'sub/batches.yaml' })).toHaveAttribute('href', 'https://git/group/repo/-/blob/abc123/sub/batches.yaml');
  expect(screen.getByText('/mnt/db')).toBeInTheDocument();

  // jump to a batch
  fireEvent.click(within(outline).getByText('my-batch'));
  expect(fakeEditor.revealLineInCenter).toHaveBeenCalledWith(1);
});

it('keeps the file as text, even when it looks like JSON', async () => {
  server.alice = '[1, 2]';
  render(<BatchesEditor {...props} />);
  expect(await editor()).toHaveValue('[1, 2]');
  expect(screen.getByText(/must be a mapping/)).toBeInTheDocument();
});

it('saves with Ctrl+S, and says so next to the editor', async () => {
  render(<BatchesEditor {...props} />);
  await type('new-batch:\n  inputs: [c.jpg]\n');
  expect(screen.getByText('Unsaved changes')).toBeInTheDocument();
  expect(screen.getByRole('tab', { name: /Private/ })).toContainElement(screen.getByLabelText('unsaved changes'));

  pressSave();
  expect(await screen.findByText('Saved just now')).toBeInTheDocument();
  expect(http.post).toHaveBeenCalledWith(
    '/api/v1/tests/groups',
    { project: props.project, groups: 'new-batch:\n  inputs: [c.jpg]\n' },
    { params: { project: props.project, name: 'alice' } },
  );
  expect(screen.queryByLabelText('unsaved changes')).not.toBeInTheDocument();
});

it('shows why saving failed', async () => {
  http.post.mockImplementation(() => Promise.reject({ response: { status: 400, data: '"mapping values are not allowed here, line 3"' } }));
  render(<BatchesEditor {...props} />);
  await type('a: b: c\n');
  // the problem is also shown before saving
  expect(screen.getByRole('button', { name: /1 error/ })).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  expect(await screen.findByText('mapping values are not allowed here, line 3')).toBeInTheDocument();
  expect(screen.getByText('Not saved')).toBeInTheDocument();
});

it("doesn't overwrite changes saved by someone else", async () => {
  render(<BatchesEditor {...props} />);
  await type('mine: {}\n');
  server.alice = 'theirs: {}\n';
  pressSave();

  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).getByTestId('diff')).toHaveTextContent('theirs: {} => mine: {}');
  expect(http.post).not.toHaveBeenCalled();

  fireEvent.click(within(dialog).getByRole('button', { name: 'Overwrite with mine' }));
  await waitFor(() => expect(server.alice).toBe('mine: {}\n'));
  expect(await screen.findByText('Saved just now')).toBeInTheDocument();
});

it('restores unsaved changes after switching views', async () => {
  const { unmount } = render(<BatchesEditor {...props} />);
  await type('draft: {}\n');
  await waitFor(() => expect(localStorage.getItem('qaboard:batches-draft:group/repo/sub/alice')).toContain('draft: {}'));
  unmount();

  render(<BatchesEditor {...props} />);
  expect(await editor()).toHaveValue('draft: {}\n');
  expect(screen.getByText(/Restored the changes you didn't save/)).toBeInTheDocument();

  // discarding can be undone, but is confirmed first
  fireEvent.click(screen.getAllByRole('button', { name: 'Discard' })[0]);
  fireEvent.click(await screen.findByRole('button', { name: 'Discard changes' }));
  expect(await editor()).toHaveValue(server.alice);
  await waitFor(() => expect(localStorage.getItem('qaboard:batches-draft:group/repo/sub/alice')).toBeNull());
});

it('lists the tests in a batch, and starts runs', async () => {
  http.post.mockImplementation(() => Promise.resolve({ data: { tests: [
    { input_path: 'a.jpg', configurations: ['base'] },
    { input_path: 'b.jpg', configurations: ['base', { threshold: 2 }] },
  ] } }));
  render(<BatchesEditor {...props} />);
  await editor();
  // the row's actions only show on hover or focus
  fireEvent.click(screen.getByLabelText('List the tests in my-batch'));

  expect(await screen.findByText('2 tests')).toBeInTheDocument();
  expect(screen.getByText('{"threshold":2}')).toBeInTheDocument();
  expect(http.post).toHaveBeenCalledWith(
    '/api/v1/tests/group',
    { groups: ['extra-batches', 'alice'] }, // the private file overrides the shared one
    { params: { project: props.project, name: 'my-batch', commit: 'abc123' } },
  );

  fireEvent.click(screen.getByRole('button', { name: 'Run…' }));
  expect(usePrefsStore.getState().tuning[props.project]).toMatchObject({ selected_group: 'my-batch' });
  expect(new URLSearchParams(history.location.search).get('selected_views')).toBe('tuning');
});

it('edits the shared file in its own tab', async () => {
  render(<BatchesEditor {...props} />);
  await editor();
  fireEvent.click(screen.getByRole('tab', { name: /Shared/ }));
  expect(await screen.findByLabelText('editor extra-batches.yml')).toHaveValue(server['extra-batches']);
});

it('opens the private file once we know who the user is', async () => {
  const { rerender } = render(<BatchesEditor {...props} available_tests_files={{ gr: 'extra-batches', usr: null }} />);
  expect(await screen.findByLabelText('editor extra-batches.yml')).toBeInTheDocument();
  rerender(<BatchesEditor {...props} />);
  expect(await editor()).toHaveValue(server.alice);
});

it('says why a batch has no tests, and which batch files the server read', async () => {
  http.post.mockImplementation(() => Promise.resolve({ data: {
    tests: [],
    definitions: [{ name: 'my-batch', file: 'sub/batches.yaml' }],
    warnings: ['Inputs not found by the QA-Board server: “a.jpg” under /mnt/db.'],
    files: [
      { source: 'commit', path: 'sub/batches.yaml', location: '/mnt/qaboard/group/repo/ab/cd/sub/batches.yaml', status: 'ok', batches: 3 },
      { source: 'commit', path: 'sub/nightly.yaml', location: '/mnt/qaboard/group/repo/ab/cd/sub/nightly.yaml', status: 'missing' },
      { source: 'qaboard', path: 'extra-batches.yml', location: '/shared/extra-batches.yml', status: 'empty' },
      { source: 'qaboard', path: 'alice.yml', location: '/shared/alice.yml', status: 'invalid', error: 'mapping values are not allowed here' },
    ],
  } }));
  render(<BatchesEditor {...props} />);
  await editor();
  fireEvent.click(screen.getByLabelText('List the tests in my-batch'));

  expect(await screen.findByText('Why there are no tests')).toBeInTheDocument();
  expect(screen.getByText('Inputs not found by the QA-Board server: “a.jpg” under /mnt/db.')).toBeInTheDocument();
  // not "No batch matches": the batch exists
  expect(screen.getByText(/The server found none of the inputs of/)).toBeInTheDocument();
  expect(screen.queryByText(/No batch matches/)).not.toBeInTheDocument();
  expect(screen.getByText((_, el) => el?.tagName === 'P' && el.textContent === 'my-batch is defined in sub/batches.yaml.')).toBeInTheDocument();

  const files = screen.getByRole('list', { name: 'Batch files' });
  expect(within(files).getByText('3 batches')).toBeInTheDocument();
  expect(within(files).getByText("not in the commit's artifacts")).toBeInTheDocument();
  expect(within(files).getByText('/mnt/qaboard/group/repo/ab/cd/sub/nightly.yaml')).toBeInTheDocument();
  expect(within(files).getByText('(Private)')).toBeInTheDocument();
  expect(within(files).getByText('mapping values are not allowed here')).toBeInTheDocument();
});

it("says when a batch isn't defined", async () => {
  http.post.mockImplementation(() => Promise.resolve({ data: {
    tests: [], definitions: [], files: [],
    warnings: ['“nightly” is not defined in the batch files QA-Board could read: sub/batches.yaml.'],
  } }));
  render(<BatchesEditor {...props} />);
  await editor();
  fireEvent.click(screen.getByRole('button', { name: 'Check any batch or pattern…' }));
  fireEvent.change(screen.getByLabelText('Batch to check'), { target: { value: 'nightly' } });
  fireEvent.click(screen.getByRole('button', { name: 'Check' }));
  expect(await screen.findByText(/No batch matches/)).toBeInTheDocument();
  expect(screen.getByText(/is not defined in the batch files QA-Board could read/)).toBeInTheDocument();
});
