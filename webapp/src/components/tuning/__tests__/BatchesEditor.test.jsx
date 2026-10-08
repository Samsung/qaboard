/**
 * Tests for the "Available Tests" view, that edits the files defining batches.
 * Run with: cd webapp && npm test -- BatchesEditor
 */
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { act } from 'react';
import axios from 'axios';

import { BatchesEditor } from '../BatchesEditor';
import { toaster } from '../../../toaster';

vi.mock('axios', () => ({ default: { get: vi.fn(), post: vi.fn() } }));

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
  git: { path_with_namespace: 'group/repo', web_url: 'https://git/group/repo' },
  available_tests_files: { gr: 'extra-batches', usr: 'alice' },
  docs_root: '/',
  dispatch: vi.fn(),
};

beforeEach(() => {
  localStorage.clear();
  server = {
    'extra-batches': 'shared-batch:\n  inputs: [a.jpg]\n',
    alice: 'my-batch:\n  inputs:\n  - a.jpg\n  - b.jpg\naliases:\n  all: [my-batch, shared-batch]\n',
  };
  axios.get.mockReset().mockImplementation((url, { params }) => Promise.resolve({ data: server[params.name] }));
  axios.post.mockReset().mockImplementation((url, data, { params }) => {
    server[params.name] = data.groups;
    return Promise.resolve({ data: 'OK' });
  });
  props.dispatch.mockReset();
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

  // the commit's files, with the subproject filled in
  expect(screen.getByRole('link', { name: 'sub/batches.yaml' })).toHaveAttribute('href', 'https://git/group/repo/tree/abc123/sub/batches.yaml');
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
  expect(axios.post).toHaveBeenCalledWith(
    '/api/v1/tests/groups',
    { project: props.project, groups: 'new-batch:\n  inputs: [c.jpg]\n' },
    { params: { project: props.project, name: 'alice' } },
  );
  expect(screen.queryByLabelText('unsaved changes')).not.toBeInTheDocument();
});

it('shows why saving failed', async () => {
  axios.post.mockImplementation(() => Promise.reject({ response: { status: 400, data: '"mapping values are not allowed here, line 3"' } }));
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
  expect(axios.post).not.toHaveBeenCalled();

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
  axios.post.mockImplementation(() => Promise.resolve({ data: { tests: [
    { input_path: 'a.jpg', configurations: ['base'] },
    { input_path: 'b.jpg', configurations: ['base', { threshold: 2 }] },
  ] } }));
  render(<BatchesEditor {...props} />);
  await editor();
  // the row's actions only show on hover or focus
  fireEvent.click(screen.getByLabelText('List the tests in my-batch'));

  expect(await screen.findByText('2 tests')).toBeInTheDocument();
  expect(screen.getByText('{"threshold":2}')).toBeInTheDocument();
  expect(axios.post).toHaveBeenCalledWith(
    '/api/v1/tests/group',
    { groups: ['extra-batches', 'alice'] }, // the private file overrides the shared one
    { params: { project: props.project, name: 'my-batch', commit: 'abc123' } },
  );

  fireEvent.click(screen.getByRole('button', { name: 'Run…' }));
  expect(props.dispatch).toHaveBeenCalledWith({ type: expect.any(String), project: props.project, tuning_form: { selected_group: 'my-batch' } });
});

it('edits the shared file in its own tab', async () => {
  render(<BatchesEditor {...props} />);
  await editor();
  fireEvent.click(screen.getByRole('tab', { name: /Shared/ }));
  expect(await screen.findByLabelText('editor extra-batches.yml')).toHaveValue(server['extra-batches']);
});
