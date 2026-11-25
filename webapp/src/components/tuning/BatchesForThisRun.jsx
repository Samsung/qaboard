// "Change for this run": the chosen batches' definitions, edited for one run only. They are sent with the request
// (`batches_files`), read after the batch files: they replace the batches of the same name for this run, and the
// files stay as they are. "Run again" from a batch's logs sends its saved definitions the same way (logs/reproduce.js).
import { useState } from "react";
import { DateTime } from "luxon";
import { parseDocument, stringify, isMap } from "yaml";
import { Button, Callout, Classes, Dialog, DialogBody, DialogFooter, Intent, Spinner } from "@blueprintjs/core";

import { http, errorMessage } from "../../api/http";
import MonacoEditor from "../MonacoEditor";
import { fnmatchRegExp } from "../../viewers/bit_accuracy/checked";

export const FOR_THIS_RUN_FILE = 'changed-for-this-run.yaml';
// keys of a batch file that are not batches
const SETTINGS = new Set(['database', 'configs', 'configurations', 'platform', 'matrix', 'aliases', 'groups']);

/** The batches the sent files define: they replace the files' batches of the same name */
export const changed_batches = files => {
  const names = new Set();
  for (const file of files ?? []) {
    try {
      const doc = parseDocument(String(file.content ?? ''));
      if (doc.errors.length) continue;
      const value = doc.toJS();
      if (value && typeof value === 'object' && !Array.isArray(value))
        Object.keys(value).filter(key => !SETTINGS.has(key) && !key.startsWith('.')).forEach(key => names.add(key));
      const aliases = value?.aliases ?? value?.groups;
      if (aliases && typeof aliases === 'object') Object.keys(aliases).forEach(key => names.add(key));
    } catch {
      // the server says what's wrong with it
    }
  }
  return [...names];
};

/** What is wrong with the text of a batch file, or null: it must be YAML, with batch names and their definitions */
export const batches_text_error = text => {
  const doc = parseDocument(String(text ?? ''));
  if (doc.errors.length) return doc.errors[0].message.split('\n')[0];
  if (!isMap(doc.contents)) return 'It should list batch names and their definitions, like `my-batch: {inputs: [a.jpg]}`.';
  return null;
};

/** The batches the chosen names stand for, from the list of batches (BatchPicker's): aliases and patterns expanded */
export const expand_selection = (selection, batches) => {
  const names = [];
  const add = name => { if (!names.includes(name)) names.push(name); };
  for (const name of selection) {
    const listed = batches.find(b => b.name === name);
    if (listed?.kind === 'alias') (listed.batches ?? []).forEach(add);
    else if (listed) add(name);
    else if (/[*?[]/.test(name)) batches.filter(b => b.kind === 'batch' && fnmatchRegExp(name).test(b.name)).forEach(b => add(b.name));
    else add(name);
  }
  return names;
};

// The definitions as the batch files have them, with their file's defaults (the server's batch_definition)
const definitions_text = async ({ project, commit_id, files, names }) => {
  const definitions = {};
  const missing = [];
  await Promise.all(names.slice(0, 50).map(async name => {
    const { data } = await http.post('/api/v1/tests/batches', { groups: files }, { params: { project, commit: commit_id, definition: name }, background: true });
    if (data?.definition) definitions[name] = data.definition;
    else missing.push(name);
  }));
  const ordered = Object.fromEntries(names.filter(name => definitions[name]).map(name => [name, definitions[name]]));
  const header = [
    '# Changed for this run only: these definitions replace the batches of the same name.',
    '# The batch files stay as they are. Remove inputs, change configurations, add a batch...',
    ...(missing.length ? [`# Not found in the batch files: ${missing.join(', ')}`] : []),
  ].join('\n');
  return `${header}\n${Object.keys(ordered).length ? stringify(ordered, { lineWidth: 0 }) : ''}`;
};

/**
 * The editor of the batches for this run. `snapshot`: what the form sends now ({files, ...}), to edit it again.
 * `onApply(content)` gets the new text.
 */
export const BatchesForThisRunDialog = ({ isOpen, onClose, onApply, project, commit_id, files, selection, batches, snapshot }) => {
  const [text, setText] = useState(null);
  const [error, setError] = useState(null);
  const [load_error, setLoadError] = useState(null);

  // read when it opens, not as the form changes
  const load = () => {
    setText(null);
    setError(null);
    setLoadError(null);
    const current = snapshot?.files?.[0]?.content;
    if (current) {
      setText(current);
      return;
    }
    definitions_text({ project, commit_id, files, names: expand_selection(selection, batches) })
      .then(setText)
      .catch(e => setLoadError(errorMessage(e)));
  };

  const apply = () => {
    const problem = batches_text_error(text);
    if (problem) { setError(problem); return; }
    onApply(text);
  };

  return <Dialog isOpen={isOpen} onOpening={load} onClose={onClose} title="Change the batches for this run" icon="annotation" style={{ width: 'min(900px, 94vw)' }}>
    <DialogBody>
      <p style={{ marginTop: 0 }}>
        Edit the inputs and configurations of <strong>{selection.join(', ')}</strong> for this run only. The batch files,
        and what others run, stay as they are. The batch you start keeps these definitions: <strong>Run again</strong> from its logs uses them.
      </p>
      {load_error && <Callout intent={Intent.DANGER} icon="error" style={{ marginBottom: 10 }}>Could not read the batches: {load_error}</Callout>}
      {text === null && !load_error
        ? <div style={{ height: 360, display: 'flex', alignItems: 'center', justifyContent: 'center' }}><Spinner size={20} aria-label="Reading the batches"/></div>
        : text !== null && <MonacoEditor
            height={360}
            language="yaml"
            value={text}
            name="editor-batches-for-this-run"
            options={{ minimap: { enabled: false }, tabSize: 2, insertSpaces: true, scrollBeyondLastLine: false }}
            onChange={value => { setText(value); setError(null); }}
          />}
      {error && <Callout intent={Intent.DANGER} icon="error" style={{ marginTop: 10 }} data-testid="batches-for-this-run-error">{error}</Callout>}
    </DialogBody>
    <DialogFooter actions={<>
      <Button text="Cancel" onClick={onClose}/>
      <Button intent={Intent.PRIMARY} text="Use for this run" disabled={text === null} onClick={apply} data-testid="batches-for-this-run-apply"/>
    </>}/>
  </Dialog>;
};

/**
 * Above the tests: says that the form sends other definitions than the batch files', and how to go back.
 * Two kinds: "Run again" from a batch's logs (`from`: the batch they ran in), and "Change for this run".
 */
export const BatchesForThisRunCallout = ({ snapshot, onEdit, onDrop }) => {
  const names = changed_batches(snapshot.files);
  if (snapshot.from) {
    const when = DateTime.fromISO(snapshot.created_at ?? '', { zone: 'utc' });
    return <Callout icon="history" intent={Intent.PRIMARY} style={{ marginBottom: 12 }} title={`The batches as they ran in ${snapshot.from}`} data-testid="batches-for-this-run">
      <p style={{ margin: '0 0 6px 0' }}>
        QA-Board sends the definitions it saved when <strong>{snapshot.from}</strong> started{when.isValid ? ` (${when.toRelative()})` : ''}:
        they replace the current ones of {snapshot.names?.length ? snapshot.names.join(', ') : 'those batches'} and of the aliases that reach them.
      </p>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        <Button size="small" icon="annotation" onClick={onEdit}>Change for this run</Button>
        <Button size="small" icon="cross" onClick={onDrop}>Use the batches as defined now</Button>
      </div>
    </Callout>;
  }
  return <Callout icon="annotation" intent={Intent.WARNING} style={{ marginBottom: 12 }} title="Batches changed for this run" data-testid="batches-for-this-run">
    <p style={{ margin: '0 0 6px 0' }}>
      {names.length ? <><strong>{names.join(', ')}</strong> run{names.length === 1 ? 's' : ''}</> : 'The batches run'} with the definitions you changed.
      The batch files stay as they are. <span className={Classes.TEXT_MUTED}>The changes stay in the form until you discard them.</span>
    </p>
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
      <Button size="small" icon="edit" onClick={onEdit}>Edit the changes</Button>
      <Button size="small" icon="cross" onClick={onDrop}>Discard the changes</Button>
    </div>
  </Callout>;
};

/** What the form sends after "Use for this run": the edited text first, then what it sent already (e.g. Run again's aliases) */
export const snapshot_for_this_run = (snapshot, content, selection) => {
  const others = (snapshot?.files ?? []).slice(1);
  return snapshot?.from
    ? { ...snapshot, files: [{ ...snapshot.files[0], content }, ...others], edited: true }
    : { for_this_run: true, files: [{ path: FOR_THIS_RUN_FILE, content }, ...others], names: selection };
};
