// What code a local run used: its uncommitted changes (and unpushed commits), the patch, and how to get the code back.
// Loaded lazily (LocalChangesTag.jsx): it shows the patch in Monaco.
import { useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AnchorButton, Button, Callout, Classes, Dialog, DialogBody, DialogFooter, Intent, SegmentedControl, Spinner, Tag,
} from "@blueprintjs/core";

import MonacoEditor, { MonacoDiffEditor } from "../MonacoEditor";
import { useComparison, useLabels, useSiteConfig } from "../../hooks";
import { commit_url } from "../../git";
import { copyWithToast } from "../../utils/clipboard";
import {
  changes_sentence, download_name, git_commands, index_patch, is_dirty, is_sha, local_changes_of, max_compared, max_shown,
  omitted_message, patchQuery, patch_url, restore_command, short_sha, status_label, status_names, unpushed_log_of,
} from "./localChanges";
import "./LocalChanges.css";


const editor_options = {
  readOnly: true,
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  renderWhitespace: 'none',
  // the patch's own line numbers mean nothing to readers
  lineNumbers: 'off',
  folding: true,
};
const diff_options = { ...editor_options, renderSideBySide: true, useInlineViewWhenSpaceIsLimited: true };

// The patch takes the dialog's height, short patches only what they need. A CSS length: outside of the component, the
// React Compiler fails on Math.min there
const editor_height = lines => `min(${18 * Math.max(lines, 3) + 10}px, max(240px, calc(90vh - 380px)))`;

const status_intent = { A: Intent.SUCCESS, New: Intent.SUCCESS, D: Intent.DANGER };

const count = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

// The files, each scrolls the patch to its changes
const FileList = ({ files, total, onReveal, revealable }) => {
  if (files.length === 0) return null;
  return <div style={{ maxHeight: 180, overflow: 'auto', marginBottom: 10 }}>
    <ul className={Classes.LIST_UNSTYLED} aria-label="Changed files">
      {files.map(file => {
        const path = String(file.path ?? '');
        const label = status_label(file.status);
        const name = status_names[file.status] ?? 'changed';
        const added = count(file.added);
        const deleted = count(file.deleted);
        return <li key={path} style={{ display: 'flex', alignItems: 'center', gap: 6, minHeight: 22 }}>
          {file.status && <Tag minimal intent={status_intent[label]} title={name} style={{ fontFamily: 'monospace', minWidth: 38, justifyContent: 'center', textAlign: 'center' }}>
            <span aria-hidden="true">{label}</span><span className="local-changes-sr-only">{name}</span>
          </Tag>}
          {revealable(path)
            ? <Button size="small" variant="minimal" className={Classes.MONOSPACE_TEXT} style={{ minWidth: 0 }} ellipsizeText text={path} title={`Show the changes of ${path}`} onClick={() => onReveal(path)}/>
            : <span className={Classes.MONOSPACE_TEXT} style={{ fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', padding: '0 7px' }}>{path}</span>}
          <span style={{ marginLeft: 'auto', fontVariantNumeric: 'tabular-nums', fontSize: 12, whiteSpace: 'nowrap' }}>
            {file.binary
              ? <span className={Classes.TEXT_MUTED}>binary</span>
              : <>
                {!!added && <span style={{ color: 'var(--qa-text-success)' }} aria-label={`${plural(added, 'line')} added`}>+{added}</span>}{' '}
                {!!deleted && <span style={{ color: 'var(--qa-text-danger)' }} aria-label={`${plural(deleted, 'line')} removed`}>−{deleted}</span>}
              </>}
          </span>
        </li>;
      })}
    </ul>
    {total > files.length && <p className={Classes.TEXT_MUTED} style={{ margin: '4px 0 0' }}>Only the first {files.length} of the {total} files are listed.</p>}
  </div>;
};

// Why the patch isn't here: one callout, for the first cause
const Reason = ({ changes, which }) => {
  const file = changes[which];
  if (which === 'patch' && is_dirty(changes) === null) {
    const why = typeof changes.error === 'string' && changes.error ? `: ${changes.error.slice(0, 300)}` : changes.timed_out ? ': git took too long (outputs.local_changes.timeout, qa doctor)' : '';
    return <Callout compact intent={Intent.WARNING} icon="help" style={{ marginBottom: 10 }}>
      git couldn't tell whether this run had uncommitted changes{why}.
    </Callout>;
  }
  const omitted = omitted_message(file, { what: which === 'unpushed' ? 'patch of the unpushed commits' : 'patch' });
  if (!omitted) return null;
  const detail = file.omitted === 'error' && typeof file.error === 'string' ? ` ${file.error.slice(0, 300)}` : '';
  return <Callout compact intent={file.omitted === 'level' ? Intent.NONE : Intent.WARNING} icon="info-sign" style={{ marginBottom: 10 }}>
    {omitted}{detail}
  </Callout>;
};

// What the patch leaves out, under the files
const LeftOut = ({ changes }) => {
  const excluded = Array.isArray(changes.excluded) ? changes.excluded.map(String) : [];
  const too_large = Array.isArray(changes.untracked_too_large) ? changes.untracked_too_large.map(String) : [];
  const list = names => `${names.slice(0, 5).join(', ')}${names.length > 5 ? `, and ${names.length - 5} more` : ''}`;
  const notes = [];
  if (excluded.length > 0)
    notes.push(<li key="excluded">Not saved, they look like secrets or the project excludes them: {list(excluded)}</li>);
  if (changes.untracked_contents === 'too_many')
    notes.push(<li key="too-many">{plural(count(changes.untracked) ?? 0, 'new file')} listed without their contents: too many (add them to .gitignore, or to outputs.local_changes.exclude)</li>);
  if (too_large.length > 0)
    notes.push(<li key="too-large">New files too large to include: {list(too_large)}</li>);
  if (notes.length === 0) return null;
  return <ul className={Classes.TEXT_MUTED} style={{ margin: '0 0 10px', paddingLeft: 18, fontSize: 12 }}>{notes}</ul>;
};

const CopyButton = ({ text, what }) => <Button size="small" variant="minimal" icon="duplicate" aria-label={`Copy ${what}`} title={`Copy ${what}`} onClick={() => copyWithToast(text, { what })}/>;

// The next step: the command that gets this code, and the patches
const GetThisCode = ({ output, changes, saved }) => {
  const restore = restore_command(output);
  const commands = git_commands(changes, output);
  return <div style={{ marginBottom: 12 }}>
    <div className="local-changes-get">
      <strong>Get this code:</strong>
      {restore && <><code className={Classes.CODE}>{restore}</code><CopyButton text={restore} what="the command"/></>}
      {saved.map(({ which, url }) => <AnchorButton key={which} size="small" variant="minimal" icon="download" href={url} download={download_name(output, which)}
        text={which === 'unpushed' ? 'Download the unpushed commits' : 'Download the patch'} aria-label={`Download ${download_name(output, which)}`}/>)}
    </div>
    {commands.length > 0 && <details>
      <summary style={{ cursor: 'pointer' }}>With git</summary>
      <p className={Classes.TEXT_MUTED} style={{ margin: '6px 0' }}>In a clean checkout, after downloading the patch{saved.length > 1 ? 'es' : ''} there:</p>
      {commands.map(command => <div key={command} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <code className={Classes.CODE_BLOCK} style={{ flex: 1, margin: '2px 0', whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>{command}</code>
        <CopyButton text={command} what="the git commands"/>
      </div>)}
    </details>}
  </div>;
};

const files_of = patch => [...patch.files.keys()].map(path => ({ path }));

// Whole lines tinted: what the patch adds, removes, and where each file starts
const decorate = (editor, monaco, patch) => {
  if (!monaco?.Range || !editor?.createDecorationsCollection) return;
  const lines = (numbers, className) => numbers.map(line => ({ range: new monaco.Range(line, 1, line, 1), options: { isWholeLine: true, className } }));
  editor.createDecorationsCollection([
    ...lines(patch.inserted, 'qa-diff-inserted'),
    ...lines(patch.deleted, 'qa-diff-deleted'),
    ...lines(patch.headers, 'qa-diff-file'),
  ]);
};

const is_missing = error => error?.status === 404;

// The files, then the patch: clicking a file scrolls the patch to its changes
const PatchText = ({ url, files, total, after_files }) => {
  const editor = useRef(null);
  const query = useQuery(patchQuery(url, max_shown));
  const patch = index_patch(query.data?.text);
  const reveal = path => {
    const line = patch.files.get(path);
    if (!editor.current || !line) return;
    editor.current.revealLineNearTop(line);
    editor.current.setPosition({ lineNumber: line, column: 1 });
    editor.current.focus();
  };
  const revealable = path => patch.files.has(path);
  let text = null;
  if (query.isPending)
    text = <div style={{ height: 200, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Spinner size={20}/></div>;
  else if (is_missing(query.error))
    text = <Callout compact intent={Intent.WARNING} icon="error">The patch file is missing: the run's files may have been deleted.</Callout>;
  else if (query.isError)
    text = <Callout compact intent={Intent.WARNING} icon="error">Could not load the patch: {String(query.error?.message ?? query.error)}</Callout>;
  else if (query.data.too_large)
    text = <Callout compact icon="info-sign">
      The patch is over {(query.data.bytes / 1024 / 1024).toFixed(1)} MB: too large to show here.{' '}
      <AnchorButton size="small" variant="minimal" icon="download" text="Download" href={url} download/>
    </Callout>;
  else
    text = <MonacoEditor
      value={query.data.text}
      language="diff"
      height={editor_height(patch.lines)}
      options={editor_options}
      editorDidMount={(instance, monaco) => { editor.current = instance; decorate(instance, monaco, patch); }}
    />;
  return <>
    {/* the unpushed commits' files are those of their patch */}
    <FileList files={files.length > 0 ? files : files_of(patch)} total={total} onReveal={reveal} revealable={revealable}/>
    {after_files}
    {text}
  </>;
};

const ComparePatches = ({ url, url_ref, changes, ref_changes }) => {
  const labels = useLabels();
  const query = useQuery(patchQuery(url, max_compared));
  const query_ref = useQuery(patchQuery(url_ref, max_compared));
  const other_commit = is_sha(ref_changes?.head) && ref_changes.head !== changes.head;
  if (query.isPending || query_ref.isPending) return <Spinner size={20}/>;
  if (query.isError || query_ref.isError) return <Callout compact intent={Intent.WARNING} icon="error">Could not load the patches.</Callout>;
  if (query.data.too_large || query_ref.data.too_large)
    return <Callout compact icon="info-sign">The patches are too large to compare here: download them.</Callout>;
  return <>
    {other_commit && <Callout compact intent={Intent.WARNING} icon="warning-sign" style={{ marginBottom: 6 }}>
      The reference ran <code>{short_sha(ref_changes.head)}</code>: its patch starts from other code.
    </Callout>}
    <p className={Classes.TEXT_MUTED} style={{ margin: '0 0 6px' }}>
      Left: the changes of {labels?.reference ?? 'the reference'}. Right: those of {labels?.new ?? 'this run'}.
    </p>
    <MonacoDiffEditor original={query_ref.data.text} value={query.data.text} language="diff" height="55vh" options={diff_options}/>
  </>;
};

const UnpushedCommits = ({ changes }) => {
  const log = unpushed_log_of(changes);
  return <div style={{ marginBottom: 10 }}>
    {is_sha(changes.base) && <p style={{ margin: '0 0 6px' }}>
      Changes from <code>{short_sha(changes.base)}</code> (last pushed) to <code>{short_sha(changes.head) || '?'}</code>
    </p>}
    {log.length > 0 && <ul className={Classes.LIST_UNSTYLED} aria-label="Unpushed commits" style={{ maxHeight: 120, overflow: 'auto', fontSize: 12 }}>
      {log.map(commit => <li key={commit.sha}><code>{short_sha(commit.sha)}</code> {commit.subject}</li>)}
    </ul>}
  </div>;
};

const Facts = ({ changes, project_data }) => {
  const { docs_root } = useSiteConfig();
  const dirty = is_dirty(changes);
  const n = count(changes.unpushed_commits) ?? 0;
  const sha = short_sha(changes.head);
  // the git host only has pushed commits
  const href = sha && changes.pushed !== false && project_data ? commit_url(project_data, changes.head) : undefined;
  return <dl className="local-changes-facts">
    <div><dt>Commit</dt><dd>{href ? <a href={href} target="_blank" rel="noopener noreferrer"><code>{sha}</code></a> : <code>{sha || 'unknown'}</code>}</dd></div>
    {changes.branch && <div><dt>Branch</dt><dd><code>{String(changes.branch)}</code></dd></div>}
    {changes.pushed === false && <div><dt>Not pushed</dt><dd>{plural(n, 'commit')}</dd></div>}
    <div><dt>Uncommitted</dt><dd>{dirty === null ? 'unknown' : dirty ? changes_sentence(changes) : 'none'}</dd></div>
    {changes.scope === 'batch' && <div><dd className={Classes.TEXT_MUTED}>Recorded when the batch started</dd></div>}
    <div><dd><a href={`${docs_root}docs/local-changes`} target="_blank" rel="noopener noreferrer">Docs</a></dd></div>
  </dl>;
};

// Opens on the uncommitted changes, or on the unpushed commits when there are only those
const first_tab = changes => changes?.dirty === false && changes?.pushed === false && changes?.unpushed ? 'unpushed' : 'patch';

const LocalChangesDialog = ({ isOpen, onClose, output, output_ref }) => {
  const comparison = useComparison();
  const changes = local_changes_of(output);
  const [tab, setTab] = useState(first_tab(changes));
  const [comparing, setComparing] = useState(false);
  const url_patch = patch_url(output, changes, 'patch');
  const url_unpushed = patch_url(output, changes, 'unpushed');
  // the same requests as the patch's view: they say whether the files still exist
  const query_patch = useQuery(patchQuery(url_patch, max_shown));
  const query_unpushed = useQuery(patchQuery(url_unpushed, max_shown));
  if (!changes) return null;

  const dirty = is_dirty(changes);
  const has_uncommitted = dirty !== false;
  const has_unpushed = changes.pushed === false && !!changes.unpushed;
  const which = has_uncommitted && has_unpushed ? tab : has_unpushed ? 'unpushed' : 'patch';
  const url = which === 'unpushed' ? url_unpushed : url_patch;
  const ref_changes = local_changes_of(output_ref);
  const url_ref = patch_url(output_ref, ref_changes, 'patch');
  const can_compare = which === 'patch' && !!url && !!url_ref && !!changes.sha256 && changes.sha256 !== ref_changes?.sha256;
  const files = which === 'patch' && Array.isArray(changes.files) ? changes.files : [];
  const total = which === 'patch' ? (count(changes.files_total) ?? files.length) : 0;
  const saved = [
    url_unpushed && !is_missing(query_unpushed.error) && { which: 'unpushed', url: url_unpushed },
    url_patch && !is_missing(query_patch.error) && { which: 'patch', url: url_patch },
  ].filter(Boolean);
  const name = output?.test_input_path ? String(output.test_input_path) : null;
  const n_unpushed = count(changes.unpushed_commits);
  const left_out = which === 'patch' ? <LeftOut changes={changes}/> : null;

  return <Dialog
    isOpen={isOpen}
    onClose={onClose}
    title={name ? `Local changes of ${name}` : 'Local changes'}
    icon="git-new-branch"
    className="local-changes-dialog"
    style={{ width: 'min(1100px, 94vw)' }}
  >
    <DialogBody>
      <Facts changes={changes} project_data={comparison?.project_data}/>

      {saved.length > 0
        ? <GetThisCode output={output} changes={changes} saved={saved}/>
        : (dirty !== false || has_unpushed) && <Callout compact icon="info-sign" style={{ marginBottom: 10 }}>
          The exact code can't be restored: only the commit <code>{short_sha(changes.head) || '?'}</code> and the list of changed files are known.
        </Callout>}

      {(has_uncommitted && has_unpushed || can_compare) && <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center', marginBottom: 10 }}>
        {has_uncommitted && has_unpushed && <SegmentedControl
          size="small"
          aria-label="Which changes"
          value={which}
          onValueChange={value => { setTab(value); setComparing(false); }}
          options={[
            { value: 'patch', label: 'Uncommitted changes' },
            { value: 'unpushed', label: `Not pushed${n_unpushed ? ` (${plural(n_unpushed, 'commit')})` : ''}` },
          ]}
        />}
        {can_compare && <Button
          size="small"
          icon="comparison"
          active={comparing}
          text={comparing ? "Back to this run's changes" : "Compare with the reference's changes"}
          onClick={() => setComparing(!comparing)}
        />}
      </div>}

      <Reason changes={changes} which={which}/>
      {which === 'unpushed' && <UnpushedCommits changes={changes}/>}
      {comparing
        ? <ComparePatches url={url} url_ref={url_ref} changes={changes} ref_changes={ref_changes}/>
        : url
          ? <PatchText key={url} url={url} files={files} total={total} after_files={left_out}/>
          : <><FileList files={files} total={total} revealable={() => false}/>{left_out}</>}
    </DialogBody>
    <DialogFooter actions={<Button text="Close" onClick={onClose}/>}/>
  </Dialog>;
};

export default LocalChangesDialog;
