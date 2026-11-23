// The code changes local runs recorded: what wasn't committed, or not pushed, when they ran (`qa run` and
// `qaboard.start_run()` send them as `output.data.local_changes`, CI runs don't). Design: docs/rfcs/local-changes.md.
// Everything here is untrusted text from whoever ran the code: shown as text, never as HTML.
import { createContext } from "react";
import { queryOptions } from "@tanstack/react-query";

import { fileUrl } from "../../viewers/videos/utils";

// The state all the runs shown share (state_key), when they share one: the batch's callout says it once, and the runs'
// tags don't repeat it. null elsewhere (e.g. History): each run shows its tag.
export const LocalChangesSharedContext = createContext(null);

// The commit page's view that lists the batch's distinct states (the sidebar's "Local changes")
export const local_changes_view = 'local-changes';

export const local_changes_of = output => {
  const changes = output?.data?.local_changes;
  return changes && typeof changes === 'object' ? changes : null;
};

// Whether a run ran code its commit doesn't have: redone from QA-Board, it runs the commit as it is
export const ran_local_changes = output => {
  const changes = local_changes_of(output);
  return !!changes && (changes.dirty === true || changes.pushed === false);
};

// What to tell people before they redo runs that ran local changes, null when none did. The server says it too.
export const redo_local_note = outputs => {
  const n = outputs.filter(ran_local_changes).length;
  if (n === 0) return null;
  const who = n < outputs.length ? `${n} of these ${outputs.length} runs` : outputs.length === 1 ? 'This run' : 'These runs';
  return `${who} ran local changes (uncommitted, or not pushed). Redone from QA-Board, they run their commit as it is, without those changes: their results can change.`;
};

// Commits are only shown, and put in commands people copy, when they are shas: anything else could be a shell command
export const is_sha = sha => typeof sha === 'string' && /^[0-9a-f]{7,64}$/.test(sha);
export const short_sha = sha => is_sha(sha) ? sha.slice(0, 8) : '';

// true / false, or null when unknown (git was too slow, or failed)
export const is_dirty = changes => changes?.dirty === true ? true : changes?.dirty === false ? false : null;

const number = value => typeof value === 'number' && Number.isFinite(value) ? value : 0;

const files_count = changes => number(changes?.files_total) || (Array.isArray(changes?.files) ? changes.files.length : 0);

// "+40 −12"
export const changes_lines = changes => `+${number(changes?.added)} −${number(changes?.deleted)}`;

// "3 files, +40 −12", for sentences
export const changes_sentence = changes => {
  const files = files_count(changes);
  return `${files} file${files === 1 ? '' : 's'}, +${number(changes?.added)} −${number(changes?.deleted)}`;
};

const unpushed_count = changes => number(changes?.unpushed_commits);

// "· 2 unpushed commits" is said only when we know the commit isn't on the remote
export const unpushed_text = changes => {
  if (changes?.pushed !== false) return '';
  const n = unpushed_count(changes);
  return n > 0 ? `${n} unpushed commit${n === 1 ? '' : 's'}` : 'not pushed';
};

// What identifies a set of changes: the commit, and the patch's content address. Runs with the same key ran the same
// code. Without a content address (summary only, unknown, a commit that isn't a sha) we can't tell: each run has its own
// key (`id`), and is never "shared". { key, exact }
export const state_key = (changes, id) => {
  if (!changes) return null;
  const dirty = is_dirty(changes);
  const head = is_sha(changes.head) ? changes.head : null;
  const unpushed = changes.pushed === false ? `+${changes.unpushed?.sha256 ?? unpushed_count(changes)}` : '';
  if (dirty === false && head) return { key: `${head}:clean${unpushed}`, exact: true };
  if (dirty === true && head && typeof changes.sha256 === 'string' && changes.sha256)
    return { key: `${head}:${changes.sha256}${unpushed}`, exact: true };
  // runs whose changes are unknown are listed together, but aren't known to be the same
  if (dirty === null) return { key: `${head ?? '?'}:unknown`, exact: false };
  return { key: `run:${id}`, exact: false };
};

const kind_of = changes => {
  const dirty = is_dirty(changes);
  return dirty === null ? 'unknown' : dirty ? 'changes' : 'clean';
};

// The distinct states of these runs, in one pass: { groups: [{ key, exact, kind, changes, output, outputs, count }],
// missing, shared } — groups with the most runs first, `missing` the runs that didn't record their changes (CI, older
// runs), `shared` the key when all the runs are known to have run the same code.
export const group_local_changes = outputs => {
  const by_key = new Map();
  let missing = 0;
  for (const output of outputs) {
    if (!output) continue;
    const changes = local_changes_of(output);
    if (!changes) {
      missing += 1;
      continue;
    }
    const { key, exact } = state_key(changes, output.id);
    const group = by_key.get(key);
    if (group) {
      group.outputs.push(output);
      group.count += 1;
    } else {
      by_key.set(key, { key, exact, kind: kind_of(changes), changes, output, outputs: [output], count: 1 });
    }
  }
  const groups = [...by_key.values()].sort((a, b) => b.count - a.count);
  // one state for all the runs: the batch's callout says it
  const single = groups.length === 1 && missing === 0;
  const shared = single && groups[0].exact ? groups[0].key : null;
  return { groups, missing, single, shared, has_data: groups.length > 0 };
};

// Whether any run says its commit isn't pushed: { sha } of the first, or null. Stops at the first.
export const unpushed_commit = outputs => {
  for (const output of outputs) {
    const changes = local_changes_of(output);
    if (changes?.pushed === false) return { sha: is_sha(changes.head) ? changes.head : null, base: is_sha(changes.base) ? changes.base : null };
  }
  return null;
};

export const has_local_changes_data = outputs => {
  for (const output of outputs)
    if (local_changes_of(output)) return true;
  return false;
};


// A file the run saved, as a URL next to its other files. The path comes from the run: only a relative path inside
// its folder, nothing that would point elsewhere.
const safe_relative_path = path => {
  if (typeof path !== 'string' || !path || path.length > 500) return null;
  if (path.startsWith('/') || path.includes('\\') || /^[a-z][a-z0-9+.-]*:/i.test(path)) return null;
  if (path.split('/').some(part => part === '..' || part === '')) return null;
  return path;
};

// which: 'patch' (uncommitted changes) or 'unpushed' (unpushed commits)
export const saved_file = (changes, which = 'patch') => {
  const file = changes?.[which];
  if (!file || typeof file !== 'object') return null;
  return safe_relative_path(file.path);
};

export const patch_url = (output, changes, which = 'patch') => {
  const path = saved_file(changes, which);
  return path && output?.output_dir_url ? fileUrl(output, path) : null;
};

// Patches are shown up to this size (Monaco), compared up to max_compared per side; larger ones are only downloaded.
// What the run says of their size isn't trusted: we count what we read.
export const max_shown = 5 * 1024 * 1024;
export const max_compared = 2 * 1024 * 1024;

// The patch's text, { text }, or { too_large, bytes } past `limit` bytes, without reading more than that
export const fetch_capped_text = async (url, limit, signal) => {
  const response = await fetch(url, { signal, credentials: 'same-origin' });
  if (!response.ok) throw Object.assign(new Error(`${response.status} ${response.statusText}`), { status: response.status });
  const length = Number(response.headers.get('content-length'));
  if (Number.isFinite(length) && length > limit) {
    response.body?.cancel?.().catch(() => {});
    return { too_large: true, bytes: length };
  }
  const reader = response.body?.getReader?.();
  if (!reader) {
    const text = await response.text();
    return text.length > limit ? { too_large: true, bytes: text.length } : { text };
  }
  const decoder = new TextDecoder();
  let received = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > limit) {
      reader.cancel().catch(() => {});
      return { too_large: true, bytes: received };
    }
    text += decoder.decode(value, { stream: true });
  }
  return { text: text + decoder.decode() };
};

export const patchQuery = (url, limit = max_shown) => queryOptions({
  queryKey: ['file', url, 'text', 'capped', limit],
  queryFn: ({ signal }) => fetch_capped_text(url, limit, signal),
  enabled: !!url,
  staleTime: Infinity,
});

const kb = bytes => Math.max(1, Math.round(number(bytes) / 1024));

// Why a patch isn't saved, in words (the CLI says the same, qaboard/local_changes.py describe()). null when it is, or
// there was nothing to save.
export const omitted_message = (file, { what = 'patch' } = {}) => {
  const reason = file?.omitted;
  if (!reason) return null;
  if (reason === 'too_large')
    return file.bytes
      ? `The ${what} is ${kb(file.bytes)} KB: too large to save (outputs.local_changes.max_patch_kb).`
      : `The ${what} was too large to save (outputs.local_changes.max_patch_kb).`;
  if (reason === 'level') return "This server keeps only a summary of the code changes.";
  if (reason === 'no_answer') return `The server didn't answer when the run started: the ${what} wasn't saved.`;
  if (reason === 'timeout') return `git took too long to compute the ${what} (outputs.local_changes.timeout, qa doctor).`;
  if (reason === 'unreadable') return `The ${what} the batch saved couldn't be read on the machine that ran this run.`;
  if (reason === 'error') return `The ${what} couldn't be saved.`;
  return `The ${what} wasn't saved (${String(reason).slice(0, 40)}).`;
};

// What a status letter means, as shown: A, M, D, New
export const status_label = status => status === '?' ? 'New' : typeof status === 'string' && status ? status.slice(0, 1) : '·';
export const status_names = { M: 'modified', A: 'added', D: 'deleted', '?': 'new, untracked', R: 'renamed', C: 'copied', T: 'type changed', U: 'unmerged' };

// The unpushed commits, newest first: [{ sha, subject }], only those with a sha
export const unpushed_log_of = changes => (Array.isArray(changes?.unpushed_log) ? changes.unpushed_log : [])
  .filter(commit => is_sha(commit?.sha))
  .slice(0, 50)
  .map(commit => ({ sha: commit.sha, subject: typeof commit.subject === 'string' ? commit.subject.slice(0, 200) : '' }));

// How to get the run's code back. null when the run's id isn't a number
const run_id = output => {
  const id = output?.id;
  return (Number.isInteger(id) && id >= 0) || (typeof id === 'string' && /^\d+$/.test(id)) ? String(id) : null;
};
export const restore_command = output => {
  const id = run_id(output);
  return id ? `qa restore ${id}` : null;
};

// What downloads are called, like `qa restore --download`: run-12-local-changes.patch, run-12-unpushed.patch
export const download_name = (output, which = 'patch') => {
  const name = which === 'unpushed' ? 'unpushed.patch' : 'local-changes.patch';
  const id = run_id(output);
  return id ? `run-${id}-${name}` : name;
};

// The git commands that recreate the run's code from the patches it saved, [] when it saved none (or its commit isn't
// a sha). Only shas and fixed names: people paste them in a shell.
// output: the run, for the patches' names (download_name)
export const git_commands = (changes, output) => {
  const patch = !!saved_file(changes, 'patch');
  const unpushed = !!saved_file(changes, 'unpushed');
  const apply_patch = `git apply ${download_name(output, 'patch')}`;
  const commands = [];
  if (patch && is_sha(changes?.head))
    commands.push(`git checkout ${changes.head} && ${apply_patch}`);
  if (unpushed && is_sha(changes?.base))
    commands.push(`git checkout ${changes.base} && git apply ${download_name(output, 'unpushed')}${patch ? ` && ${apply_patch}` : ''}`);
  return commands;
};

// "diff --git a/src/a.py b/src/a.py": git writes the same path twice (renames are deletions and additions), so it is
// the second half, even when the path has spaces
const header_path = header => {
  const rest = header.slice('diff --git '.length).replace(/\r$/, '');
  const half = (rest.length - 1) / 2;
  if (Number.isInteger(half) && rest[half] === ' ') {
    const a = rest.slice(0, half);
    const b = rest.slice(half + 1);
    if (a.startsWith('a/') && b.startsWith('b/') && a.slice(2) === b.slice(2)) return b.slice(2);
  }
  const b = rest.lastIndexOf(' b/');
  return b === -1 ? null : rest.slice(b + 3);
};

// The lines of a patch, where each file starts ("diff --git a/x b/x"), and which lines its hunks add and remove, for the
// editor to tint them: { lines, files: Map(path => line number), headers, inserted, deleted } (line numbers, from 1).
// One pass, without splitting the text.
export const index_patch = text => {
  const files = new Map();
  const headers = [];
  const inserted = [];
  const deleted = [];
  if (typeof text !== 'string' || !text) return { lines: 1, files, headers, inserted, deleted };
  let line = 1;
  let start = 0;
  let in_hunk = false;
  while (start <= text.length) {
    const char = text[start];
    if (text.startsWith('diff --git ', start)) {
      in_hunk = false;
      headers.push(line);
      const end = text.indexOf('\n', start);
      const path = header_path(text.slice(start, end === -1 ? undefined : end));
      if (path !== null && !files.has(path)) files.set(path, line);
    } else if (char === '@' && text.startsWith('@@', start)) {
      in_hunk = true;
    } else if (in_hunk && char === '+') {
      inserted.push(line);
    } else if (in_hunk && char === '-') {
      deleted.push(line);
    } else if (in_hunk && char !== ' ' && char !== '\\' && char !== '\n' && char !== '\r') {
      // e.g. the next commit's message, in unpushed.patch
      in_hunk = false;
    }
    const next = text.indexOf('\n', start);
    if (next === -1) break;
    line += 1;
    start = next + 1;
  }
  return { lines: line, files, headers, inserted, deleted };
};
