import { useEffect, useId, useRef, useState } from "react";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import styled from "styled-components";

import {
  Classes,
  Intent,
  Tag,
  Callout,
  Checkbox,
  FormGroup,
  InputGroup,
  HTMLSelect,
  Button,
  Dialog,
  DialogBody,
  DialogFooter,
  SegmentedControl,
  Switch,
  Spinner,
  Tooltip,
} from "@blueprintjs/core";

import { http, errorMessage } from "../api/http";
import { linux_to_windows, are_on_same_filesystem, extract_drive_and_folder } from '../utils'
import { toaster } from "../toaster"
import { track } from "../analytics"
import { Link } from "../router"
import { copyWithToast } from "../utils/clipboard"
import { usePrefsStore } from "../stores/prefs";
import { useSiteConfig } from "../hooks";
import { parse_template, FIELDS } from "../export/names";
import {
  LAYOUTS, SEPARATORS, SETTINGS_FORMATS, SETTINGS_ASSIGN, SETTINGS_JOIN, CONFIGURATIONS, PLATFORM, ABSENT,
  default_naming, layout_of, export_runs, request_runs, example_name, saved_settings, presets_for,
} from "../export/plan";
import { runs_url, python_snippet } from "./ScriptPlugin";


// By default we export the files of the first visualization
const default_path = (config, path) => {
  const visualization_path = config?.outputs?.visualizations?.[0]?.path;
  // for projects using dynamic outputs
  if (visualization_path) return visualization_path.replace(/:[a-zA-Z0-9_]+/, '*');
  return path || '*.png';
};

export const export_help = "Gather the files matching a pattern from all the runs shown, new and reference, into a new folder";

const FIELD_HELP = {
  side: 'What the page calls the new and reference results',
  input: 'The input\'s path, without its extension',
  input_name: 'The input\'s name, without its folders',
  settings: 'The settings you pick below',
  file: 'The file\'s path in its run\'s folder',
  platform: 'The run\'s platform',
  commit: 'The commit, 8 characters',
  batch: 'The batch',
  run: 'The run\'s id',
};

// **/**.png => Invalid pattern: '**' can only be an entire path component
const invalid_globstar = /(?:^|\/)(\*\*(?!\/?$|\/))/;
const pattern_problem = path => {
  if (!path) return 'Which files? e.g. *.png';
  if (path.startsWith('/')) return 'File patterns are relative to the runs\' folders.';
  if (path.split('/').includes('..')) return 'File patterns can\'t go out of the runs\' folders.';
  if (invalid_globstar.test(path)) return <><code>**</code> must be a whole folder: <code>**/*.jpg</code>.</>;
  return null;
};

const new_folder_id = () => {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
};

// A short signature of the request, for the preview's query key
const signature = text => {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${text.length}-${(h >>> 0).toString(16)}`;
};

const useDebounced = (value, delay) => {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timeout = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(timeout);
  }, [value, delay]);
  return debounced;
};

// the form, and what it does: side by side on wide screens
const Columns = styled.div`
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 24px;
  .export-preview {
    position: sticky;
    top: 0;
    align-self: start;
  }
  @media (max-width: 900px) {
    grid-template-columns: minmax(0, 1fr);
    .export-preview { position: static; }
  }
`;
const Row = styled.div`
  display: flex;
  flex-wrap: wrap;
  gap: 4px 16px;
  align-items: flex-start;
`;

const plural = (n, word, words) => `${n} ${n === 1 ? word : (words ?? `${word}s`)}`;

const Paths = ({ folder }) => {
  const windows = linux_to_windows(folder);
  return <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr auto', gap: '4px 8px', alignItems: 'center' }}>
    <Tag minimal>Windows</Tag><code style={{ wordBreak: 'break-all' }}>{windows}</code>
    <Button size="small" variant="minimal" icon="duplicate" aria-label="Copy the Windows path" onClick={() => copyWithToast(windows, { what: 'the Windows path' })}/>
    <Tag minimal>Linux</Tag><code style={{ wordBreak: 'break-all' }}>{folder}</code>
    <Button size="small" variant="minimal" icon="duplicate" aria-label="Copy the Linux path" onClick={() => copyWithToast(folder, { what: 'the Linux path' })}/>
  </div>;
};

const template_fields = template => {
  try { return parse_template(template).filter(p => p.kind === 'field').map(p => p.text); } catch { return []; }
};

// How to make names unique: [{text, fix}], `fix` changes the settings
const collision_fixes = (naming, candidates, picked) => {
  const out = [];
  const fields = template_fields(naming.template);
  const add = field => ({ template: `${naming.template}__{${field}}` });
  if (!fields.includes('file')) out.push({ text: <>Add <code>{'{file}'}</code>: runs have several files matching the pattern</>, fix: add('file') });
  if (!fields.includes('input') && !fields.includes('input_name')) out.push({ text: <>Add <code>{'{input}'}</code></>, fix: add('input') });
  if (fields.includes('input_name') && !fields.includes('input'))
    out.push({ text: <>Use <code>{'{input}'}</code>, not <code>{'{input_name}'}</code>: inputs in different folders have the same name</>, fix: { template: naming.template.replaceAll('{input_name}', '{input}') } });
  const unpicked = candidates.filter(c => !picked.includes(c.key));
  if (!fields.includes('settings') && candidates.length > 0) out.push({ text: <>Add <code>{'{settings}'}</code>, to tell runs on the same input apart</>, fix: add('settings') });
  else if (unpicked.length > 0) out.push({ text: <>Say all the settings that differ: {unpicked.map(c => c.key).join(', ')}</>, fix: { settings_keys: candidates.map(c => c.key) } });
  if (!fields.includes('side')) out.push({ text: <>Add <code>{'{side}'}</code>: new and reference files have the same names</>, fix: add('side') });
  if (!fields.includes('run')) out.push({ text: <>Add <code>{'{run}'}</code>, the run's id: always unique</>, fix: add('run') });
  return out;
};

// How to make paths short enough for Windows
const length_fixes = (naming, picked) => {
  const out = [];
  const fields = template_fields(naming.template);
  if (fields.includes('settings') && picked.length > 0 && naming.settings_format === 'values')
    out.push({ text: <>Say the settings with a short id</>, fix: { settings_format: 'id' } });
  if (fields.includes('input')) out.push({ text: <>Use the inputs' names, <code>{'{input_name}'}</code>, not their paths</>, fix: { template: naming.template.replaceAll('{input}', '{input_name}') } });
  if (naming.separator === '__') out.push({ text: <>Join folders with <code>_</code></>, fix: { separator: '_' } });
  out.push({ text: <>Turn off Windows-compatible names, if nobody opens them on Windows</>, fix: { windows: false } });
  return out;
};

const Fixes = ({ fixes, onFix }) => <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 4, marginTop: 4 }}>
  {fixes.map((f, index) => <Button key={index} size="small" variant="outlined" icon="wrench" onClick={() => onFix(f.fix)}>{f.text}</Button>)}
</div>;

const ProblemList = ({ items, more }) => <ul style={{ margin: '4px 0', paddingLeft: 18 }}>
  {items.map((item, index) => <li key={index}>{item}</li>)}
  {more > 0 && <li className={Classes.TEXT_MUTED}>and {more} more</li>}
</ul>;

// Saved export settings: pick one, save the form as one, delete one
const Presets = ({ project, settings, onLoad }) => {
  const presets = usePrefsStore(state => state.exportPresets);
  const save = usePrefsStore(state => state.saveExportPreset);
  const remove = usePrefsStore(state => state.deleteExportPreset);
  const [selected, setSelected] = useState('');
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('');
  const [this_project, setThisProject] = useState(false);
  const available = presets_for(presets, project);
  const current = available.find(p => p.id === selected);
  return <FormGroup label="Saved settings" helperText={saving ? null : 'Your last export\'s settings come back by themselves. Save presets for what your scripts expect.'}>
    <Row style={{ alignItems: 'center' }}>
      <HTMLSelect aria-label="Saved settings" value={selected} onChange={e => {
        setSelected(e.target.value);
        const preset = available.find(p => p.id === e.target.value);
        if (preset) onLoad(preset.settings);
      }} options={[{ value: '', label: available.length ? 'Load a preset…' : 'No presets yet' }, ...available.map(p => ({ value: p.id, label: p.project ? `${p.name} (this project)` : p.name }))]}/>
      {!saving && <Button size="small" variant="outlined" icon="floppy-disk" text="Save as preset…" onClick={() => { setSaving(true); setName(current?.name ?? ''); }}/>}
      {current && !saving && <Button size="small" variant="minimal" icon="trash" aria-label={`Delete the preset ${current.name}`} onClick={() => { remove(current.id); setSelected(''); }}/>}
    </Row>
    {saving && <Row style={{ alignItems: 'center', marginTop: 6 }}>
      <InputGroup small autoFocus aria-label="Preset name" placeholder="e.g. For the IQ report script" value={name} onChange={e => setName(e.target.value)}
        onKeyDown={e => { if (e.key === 'Escape') setSaving(false); }}/>
      <Checkbox style={{ margin: 0 }} checked={this_project} label="Only for this project" onChange={e => setThisProject(e.target.checked)}/>
      <Button size="small" intent="primary" text={available.some(p => p.name === name.trim() && (p.project ?? null) === (this_project ? project : null)) ? 'Replace' : 'Save'}
        disabled={!name.trim()} onClick={() => {
          save({ name: name.trim(), project: this_project ? project : null, settings: saved_settings(settings) });
          toaster.show({ message: `Saved the preset "${name.trim()}"`, intent: Intent.SUCCESS, icon: 'floppy-disk' });
          setSaving(false);
        }}/>
      <Button size="small" variant="minimal" text="Cancel" onClick={() => setSaving(false)}/>
    </Row>}
  </FormGroup>;
};


// The export's form, its live preview from the server (what the export would do), and the result.
// It stays mounted while the dialog is closed: the form and the last export stay.
const ExportDialog = ({
  isOpen, onClose, project, ref_project, config, new_batch, ref_batch, labels, batch_dir_url,
  new_commit_id, ref_commit_id, selected_batch_new, selected_batch_ref, filter_batch_new, filter_batch_ref, path: config_path,
}) => {
  const { docs_root, cli_requirements } = useSiteConfig();
  // the last export's settings in this project
  const last = usePrefsStore(state => state.exportLast?.[project]);
  const setLast = usePrefsStore(state => state.setExportLast);
  const [settings, setSettings] = useState(() => ({ ...default_naming, ...last }));
  const update = changes => setSettings(s => ({ ...s, ...changes }));
  const naming = { ...default_naming, ...settings };
  const [label_overrides, setLabelOverrides] = useState({ new: '', reference: '' });
  const [folder_name, setFolderName] = useState('');
  const [folder_id, setFolderId] = useState(new_folder_id);
  const [is_exporting, setExporting] = useState(false);
  const [result, setResult] = useState(null);
  const path_id = useId();
  const template_id = useId();
  const path_input = useRef(null);
  const template_input = useRef(null);

  const path = settings.files ?? default_path(config, config_path);
  const problem = pattern_problem(path);
  const folder_mode = settings.folder_mode ?? 'new';
  const folder_path = settings.folder_path ?? '';

  const label_new = label_overrides.new.trim() || labels?.new || 'new';
  const label_ref = label_overrides.reference.trim() || labels?.reference || 'reference';
  const plan = export_runs({ new_batch, ref_batch, labels: { new: label_new, reference: label_ref }, naming });
  const has_reference = plan.counts.reference > 0;
  const fields = template_fields(naming.template);

  let template_error = null;
  try { parse_template(naming.template); } catch (e) { template_error = e.message; }
  // e.g. the names of a new run's file and its reference's. Until the server lists the files, with the pattern as file
  let examples = [];
  try {
    if (!template_error) examples = [
      example_name(plan.items[0], naming, path, new_commit_id, selected_batch_new),
      has_reference && example_name(plan.items.find(i => i.side === 'reference'), naming, path, ref_commit_id, selected_batch_ref),
    ].filter(Boolean);
  } catch (e) { template_error = e.message; }

  // links only work on the same filesystem
  const batch_dir = (batch_dir_url ?? '').slice(2);
  const batch_output_fs = extract_drive_and_folder(linux_to_windows(batch_dir));
  const path_is_same_fs = !!folder_path && are_on_same_filesystem(linux_to_windows(folder_path), batch_output_fs);
  const type = folder_mode === 'path' && !path_is_same_fs ? 'copy' : (settings.type ?? 'link');

  const body = {
    project,
    runs: request_runs(plan.items),
    files: path,
    template: naming.template,
    separator: naming.separator,
    windows: naming.windows,
    type,
    folder: folder_mode === 'path' ? { path: folder_path.trim(), id: folder_id } : { name: folder_name.trim(), id: folder_id },
    sides: {
      new: { project, commit: new_commit_id, batch: selected_batch_new, filter: filter_batch_new ?? '', label: plan.labels.new },
      ...(has_reference ? { reference: { project: ref_project ?? project, commit: ref_commit_id, batch: selected_batch_ref, filter: filter_batch_ref ?? '', label: plan.labels.reference } } : {}),
    },
  };
  const key = signature(JSON.stringify(body));
  const debounced_key = useDebounced(key, 400);
  const can_preview = isOpen && !problem && !template_error && plan.items.length > 0 && (folder_mode === 'new' || !!folder_path.trim());
  const preview = useQuery({
    queryKey: ['export-preview', project, debounced_key],
    queryFn: async ({ signal }) => (await http.post('/api/v1/exports/preview', body, { params: { project }, signal, background: true })).data,
    enabled: can_preview && debounced_key === key,
    placeholderData: keepPreviousData,
    gcTime: 60 * 1000,
    retry: false,
  });
  const is_current = preview.data && !preview.isPlaceholderData && debounced_key === key;
  const p = can_preview ? preview.data : null;
  const checking = can_preview && (!is_current || preview.isFetching);

  const setLayout = key => {
    const layout = LAYOUTS.find(l => l.key === key);
    if (layout) update({ layout: key, template: layout.template, separator: layout.separator });
  };
  const insertField = name => {
    const input = template_input.current;
    const text = naming.template;
    const at = input?.selectionStart ?? text.length;
    const before = text.slice(0, at), after = text.slice(at);
    const glue = before && !/[_\-./]$/.test(before) ? '__' : '';
    update({ template: `${before}${glue}{${name}}${after}` });
  };
  const toggleSetting = key => {
    const picked = new Set(plan.picked);
    if (picked.has(key)) picked.delete(key); else picked.add(key);
    // in the order they're listed
    update({ settings_keys: plan.candidates.map(c => c.key).filter(k => picked.has(k)) });
  };

  const can_export = can_preview && is_current && !preview.isFetching && !preview.error && p && p.nb_files > 0 && p.nb_collisions === 0 && !(p.nb_too_long > 0);
  const doExport = () => {
    setExporting(true);
    http.post('/api/v1/exports', body, { params: { project } })
      .then(({ data }) => {
        track('export_start', { export_type: type, n_runs: data.nb_runs, n_files: data.nb_files_exported, layout: layout_of(naming.template, naming.separator), windows: naming.windows }, { project_id: project });
        copyWithToast(linux_to_windows(data.folder), { what: 'the export folder' });
        setResult({ ...data, at: new Date() });
        // the next export starts with these settings, and goes to a new folder. Which settings names say depends on
        // the runs: the next export picks what it needs (presets keep them, for scripts that expect them)
        setLast(project, saved_settings({ ...settings, settings_keys: null, files: path, type }));
        setFolderId(new_folder_id());
      })
      .catch(error => {
        const message = errorMessage(error);
        setResult({ error: message, at: new Date() });
        toaster.show({ message, intent: Intent.DANGER });
      })
      .finally(() => setExporting(false));
  };

  const layout = layout_of(naming.template, naming.separator);
  if (p && is_current && p.files.length > 0)
    examples = [p.files.find(f => f.side === 'new'), p.files.find(f => f.side === 'reference')].filter(Boolean).map(f => f.to);
  // a new file's name, and its reference's when they're short enough to read both
  const example = examples.join(', ').length > 140 ? examples[0] : examples.join(', ');
  const same_name = name => naming.windows ? name.toLowerCase() : name;
  const collided = new Set((p?.collisions ?? []).map(c => same_name(c.to)));
  const too_long = new Set((p?.too_long ?? []).map(t => t.to));
  const requirements = cli_requirements?.length ? cli_requirements : ['qaboard'];
  const snippet = python_snippet(runs_url({ project, commit_id: new_commit_id, batch: selected_batch_new, filter: filter_batch_new, ref_project, ref_commit_id, batch_ref: selected_batch_ref, filter_ref: filter_batch_ref }), requirements);

  const preview_block = !can_preview ? null : <section aria-label="Preview" style={{ marginTop: 4 }}>
    <h4 className={Classes.HEADING} style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '0 0 6px' }}>
      Preview {checking && <Spinner size={14} aria-label="Checking"/>}
    </h4>
    {preview.error && !preview.isFetching && <Callout intent="danger" icon="error">{errorMessage(preview.error)}</Callout>}
    {p && <div style={{ opacity: is_current ? 1 : 0.6 }}>
      <p style={{ marginBottom: 6 }}>
        <strong>{plural(p.nb_files, 'file')}</strong> from {plural(p.nb_runs, 'run')} into{' '}
        {p.folder_exists ? 'the folder' : 'a new folder'} <code style={{ wordBreak: 'break-all' }}>{p.folder}</code>
        {type === 'link' ? ', as links to the runs\' files.' : ', as copies.'}
      </p>
      {p.runs_without_files > 0 && <p className={Classes.TEXT_MUTED} style={{ marginBottom: 6 }}>
        {plural(p.runs_without_files, 'run has', 'runs have')} no file matching <code>{path}</code>.
      </p>}
      {p.nb_files === 0 && <Callout intent="warning" icon="search">No file matches <code>{path}</code> in these runs: check the pattern, e.g. <code>**/*.png</code> looks in subfolders too.</Callout>}
      {p.nb_collisions > 0 && <Callout intent="danger" icon="duplicate" title={`${plural(p.nb_collisions, 'name is', 'names are')} used by several files`} style={{ marginBottom: 8 }}>
        <ProblemList more={p.nb_collisions - p.collisions.length} items={p.collisions.slice(0, 5).map(c => <span key={c.to}>
          <code>{c.to}</code>: {c.sources.map(s => `run ${s.run} (${s.side}) ${s.file}`).join(', ')}{c.count > c.sources.length ? '…' : ''}
        </span>)}/>
        {naming.windows && <p className={Classes.TEXT_MUTED} style={{ margin: '4px 0' }}>Names that differ only by case are the same name on Windows.</p>}
        <p style={{ margin: '6px 0 0' }}>To make names unique:</p>
        <Fixes fixes={collision_fixes(naming, plan.candidates, plan.picked)} onFix={update}/>
      </Callout>}
      {p.nb_too_long > 0 && <Callout intent="danger" icon="widget-button" style={{ marginBottom: 8 }}
        title={`${plural(p.nb_too_long, 'path is', 'paths are')} too long for Windows`}>
        Windows Explorer and many apps can't open paths over {p.max_path + 1} characters. The longest, with the folder, has {p.too_long[0].length}:
        <ProblemList more={p.nb_too_long - Math.min(3, p.too_long.length)} items={p.too_long.slice(0, 3).map(t => <span key={t.to}><code style={{ wordBreak: 'break-all' }}>{t.to}</code> ({t.length})</span>)}/>
        <Fixes fixes={length_fixes(naming, plan.picked)} onFix={update}/>
      </Callout>}
      {p.nb_existing > 0 && <Callout intent={p.existing_policy === 'replace' ? 'warning' : 'primary'} icon="warning-sign" style={{ marginBottom: 8 }}
        title={p.existing_policy === 'replace' ? `${plural(p.nb_existing, 'file')} will be replaced` : `${plural(p.nb_existing, 'file exists', 'files exist')} already: kept`}>
        {p.existing_policy === 'replace'
          ? 'They come from an earlier export into this folder.'
          : 'QA-Board doesn\'t replace files in folders it didn\'t create: these files won\'t be exported.'}
        <ProblemList more={p.nb_existing - p.existing.length} items={p.existing.slice(0, 5).map(name => <code key={name}>{name}</code>)}/>
      </Callout>}
      {p.errors.length > 0 && <Callout intent="danger" icon="issue" title="Errors" style={{ marginBottom: 8 }}>
        <ProblemList items={p.errors.map(e => <code key={e}>{e}</code>)}/>
      </Callout>}
      {p.folders_skipped > 0 && <p className={Classes.TEXT_MUTED}>{plural(p.folders_skipped, 'folder matches', 'folders match')} the pattern: QA-Board exports files, e.g. <code>folder/**/*</code>.</p>}
      {p.files.length > 0 && <div role="list" aria-label="Exported files" style={{ maxHeight: 'min(440px, 45vh)', overflow: 'auto', border: '1px solid var(--qa-border)', borderRadius: 3, padding: '4px 8px', fontFamily: 'var(--bp-typography-family-mono, monospace)', fontSize: 12 }}>
        {p.files.map((f, index) => <div role="listitem" key={index} style={{ display: 'flex', gap: 8, alignItems: 'baseline', padding: '1px 0' }} title={`run ${f.run}, ${f.file}`}>
          <span style={{ flex: 1, minWidth: 0, wordBreak: 'break-all' }}>{f.to}</span>
          {collided.has(same_name(f.to)) && <Tag minimal intent="danger">same name</Tag>}
          {too_long.has(f.to) && <Tag minimal intent="danger">too long</Tag>}
          {f.exists && <Tag minimal intent={p.existing_policy === 'replace' ? 'warning' : 'primary'}>{p.existing_policy === 'replace' ? 'replaced' : 'kept'}</Tag>}
          <span className={Classes.TEXT_MUTED} style={{ whiteSpace: 'nowrap' }}>{f.side === 'reference' ? 'ref' : 'new'}</span>
        </div>)}
        {p.nb_files > p.files.length && <div className={Classes.TEXT_MUTED}>and {p.nb_files - p.files.length} more</div>}
      </div>}
    </div>}
  </section>;

  const result_block = result && <section aria-label="Last export" style={{ marginBottom: 12 }}>
    {result.error
      ? <Callout intent="danger" icon="error" title="The export failed">{result.error}</Callout>
      : <Callout intent={result.errors?.length || result.nb_skipped ? 'warning' : 'success'} icon="tick" title={`${plural(result.nb_files_exported, 'file')} exported from ${plural(result.nb_runs, 'run')}`}>
          <Paths folder={result.folder}/>
          {result.mapping && <p style={{ margin: '6px 0 0' }}><code>{result.mapping}</code> in the folder lists each file and where it comes from: its run, input and settings (with the runs' configurations in <code>{result.mapping.replace(/\.csv$/, '.json')}</code>).</p>}
          {result.type === 'link' && <p style={{ margin: '4px 0 0' }} className={Classes.TEXT_MUTED}>The files are links to the runs' files, not copies: don't edit them.</p>}
          {result.export_id && <p style={{ margin: '4px 0 0' }} className={Classes.TEXT_MUTED}>Find your exports, their size, and delete them in <Link to="/storage/exports">Storage usage → Exports</Link>.</p>}
          {result.nb_skipped > 0 && <ProblemList more={result.nb_skipped - result.skipped.length} items={result.skipped.map(s => <code key={s}>{s}</code>)}/>}
          {result.errors?.length > 0 && <ProblemList items={result.errors.map(e => <code key={e}>{e}</code>)}/>}
        </Callout>}
  </section>;

  const settings_section = <FormGroup label="Settings in names" labelInfo={<code>{'{settings}'}</code>} helperText={plan.candidates.length === 0
    ? 'All the runs shown have the same settings: names don\'t need them.'
    : <>What differs between the runs shown. Checked by default: what differs between runs on the same input, or their files would get the same names. A run that doesn't set a parameter says <code>{ABSENT}</code>.{!fields.includes('settings') && <> Add <code>{'{settings}'}</code> to the template to use them.</>}</>}>
    {plan.candidates.length > 0 && <>
      <div role="group" aria-label="Settings in names" style={{ display: 'flex', flexWrap: 'wrap', gap: '0 16px' }}>
        {plan.candidates.map(c => <Checkbox key={c.key} inline style={{ margin: '2px 0' }} checked={plan.picked.includes(c.key)} onChange={() => toggleSetting(c.key)}
          labelElement={<Tooltip content={`${plural(c.values, 'value')}${c.needed ? ', differs between runs on the same input' : ''}`} placement="top" hoverOpenDelay={300}>
            <span>{c.key === CONFIGURATIONS ? 'configurations' : c.key === PLATFORM ? 'platform' : <code>{c.key}</code>}{c.needed && <span className={Classes.TEXT_MUTED}> (differs on an input)</span>}</span>
          </Tooltip>}/>)}
      </div>
      {plan.picked.length > 0 && <Row style={{ marginTop: 6 }}>
        <HTMLSelect aria-label="How settings show" value={naming.settings_format} onChange={e => update({ settings_format: e.target.value })}
          options={SETTINGS_FORMATS.map(s => ({ value: s.value, label: s.label }))}/>
        {naming.settings_format === 'values' && <>
          <HTMLSelect aria-label="Parameters and their values" value={naming.settings_assign} onChange={e => update({ settings_assign: e.target.value })}
            options={SETTINGS_ASSIGN.map(s => ({ value: s.value, label: s.label }))}/>
          <HTMLSelect aria-label="Between settings" value={naming.settings_join} onChange={e => update({ settings_join: e.target.value })}
            options={SETTINGS_JOIN.map(s => ({ value: s.value, label: `Joined: ${s.label}` }))}/>
        </>}
      </Row>}
      {plan.picked.length > 0 && <p className={Classes.TEXT_MUTED} style={{ margin: '4px 0 0', fontSize: 12 }}>
        {SETTINGS_FORMATS.find(s => s.value === naming.settings_format)?.description} e.g. <code>{plan.items.find(i => i.fields.settings)?.fields.settings}</code>
      </p>}
    </>}
  </FormGroup>;

  return <Dialog isOpen={isOpen} onClose={onClose} title="Export files" icon="export" style={{ width: 'min(1180px, calc(100vw - 32px))' }}
    onOpened={() => path_input.current?.focus()}>
    <DialogBody>
      <Callout icon="code" style={{ marginBottom: 12 }}>
        Running your own code on these files? You may not need an export: <strong>Script</strong>, next to Export, gives you
        these runs in Python, with their folders, files and metrics.{' '}
        <Button size="small" variant="minimal" icon="duplicate" text="Copy the Python snippet" onClick={() => copyWithToast(snippet, { what: 'the snippet' })}/>
        <a href={`${docs_root}docs/user-guide/sharing#runs-in-scripts`} target="_blank" rel="noopener noreferrer">How</a>
      </Callout>
      <Columns>
        <div>
          <Presets project={project} settings={{ ...settings, files: path }} onLoad={preset => setSettings({ ...default_naming, ...preset })}/>
          <FormGroup label="Files" labelFor={path_id} labelInfo="(pattern)" helperText={problem
            ? <span style={{ color: 'var(--bp-intent-warning-text, #935610)' }}>{problem}</span>
            : <>In each run's folder, e.g. <code>*.png</code>, <code>**/*.jpg</code> (<code>**/</code> matches any folders). {plural(plan.counts.new, 'run')}{has_reference && <> and {plural(plan.counts.reference, 'reference run')}</>}{plan.counts.without_reference > 0 && has_reference && <>, {plan.counts.without_reference} without a reference</>}.</>}>
            <InputGroup id={path_id} inputRef={path_input} value={path} placeholder="*.png" intent={problem ? 'warning' : undefined}
              onChange={e => update({ files: e.target.value })}
              onKeyDown={e => { if (e.key === 'Enter' && can_export && !is_exporting) doExport(); }}/>
          </FormGroup>

          <FormGroup label="Names" helperText={LAYOUTS.find(l => l.key === layout)?.description ?? 'Your own template.'}>
            <SegmentedControl aria-label="Layout" small options={[...LAYOUTS.map(l => ({ label: l.label, value: l.key })), { label: 'Custom', value: 'custom', disabled: layout !== 'custom' }]}
              value={layout} onValueChange={setLayout}/>
          </FormGroup>
          <FormGroup label="Template" labelFor={template_id} helperText={template_error
            ? <span style={{ color: 'var(--bp-intent-danger-text, #c23030)' }}>{template_error}</span>
            : <>{example && <>e.g. <code style={{ wordBreak: 'break-all' }}>{example}</code>. </>}The extension is added. Add a field:{' '}
              {FIELDS.map(f => <Tooltip key={f} content={FIELD_HELP[f]} placement="bottom" hoverOpenDelay={300}>
                <Button size="small" variant="minimal" style={{ fontFamily: 'monospace', padding: '0 4px' }} onClick={() => insertField(f)}>{`{${f}}`}</Button>
              </Tooltip>)}</>}>
            <InputGroup id={template_id} inputRef={template_input} value={naming.template} intent={template_error ? 'danger' : undefined}
              style={{ fontFamily: 'monospace' }} onChange={e => update({ template: e.target.value })}/>
          </FormGroup>
          {settings_section}
          <Row>
            <FormGroup label="Folders in paths" labelFor={`${template_id}-separator`}>
              <HTMLSelect id={`${template_id}-separator`} value={naming.separator} onChange={e => update({ separator: e.target.value })}
                options={SEPARATORS.map(s => ({ value: s.value, label: s.label }))}/>
            </FormGroup>
            <FormGroup label="Windows" helperText={naming.windows
              ? 'No \\ / : * ? " < > |, paths under 260 characters, names that differ only by case are the same.'
              : 'Names only for Linux: paths can be long, and use any character but /.'}>
              <Switch checked={naming.windows} label="Windows-compatible names" style={{ marginBottom: 0 }} onChange={e => update({ windows: e.target.checked })}/>
            </FormGroup>
          </Row>
          {has_reference && <Row>
            <FormGroup label={<>New results are called <code>{'{side}'}</code> =</>} labelFor={`${template_id}-new`}>
              <InputGroup id={`${template_id}-new`} small value={label_overrides.new} placeholder={labels?.new || 'new'} onChange={e => setLabelOverrides(l => ({ ...l, new: e.target.value }))}/>
            </FormGroup>
            <FormGroup label="the reference" labelFor={`${template_id}-ref`}>
              <InputGroup id={`${template_id}-ref`} small value={label_overrides.reference} placeholder={labels?.reference || 'reference'} onChange={e => setLabelOverrides(l => ({ ...l, reference: e.target.value }))}/>
            </FormGroup>
            <Switch checked={naming.pair_references} onChange={e => update({ pair_references: e.target.checked })}
              labelElement={<Tooltip content="A reference run compared to several new runs is exported once per new run, with its input and settings: files pair up." placement="top">
                <span>Name reference files like the new runs they're compared to</span>
              </Tooltip>}/>
          </Row>}

          <FormGroup label="Where">
            <SegmentedControl aria-label="Where" small value={folder_mode} onValueChange={mode => update({ folder_mode: mode })}
              options={[{ label: 'A new folder', value: 'new' }, { label: 'A folder I choose', value: 'path' }]}/>
          </FormGroup>
          {folder_mode === 'new'
            ? <FormGroup label="Name of the export" labelInfo="(optional)" labelFor={`${template_id}-name`} helperText="In the folder's name, after the date: find it later in Storage usage → Exports.">
                <InputGroup id={`${template_id}-name`} value={folder_name} placeholder="e.g. night-scenes-for-review" onChange={e => setFolderName(e.target.value)}/>
              </FormGroup>
            : <FormGroup label="Folder" labelFor={`${template_id}-folder`} helperText="On the shared storage. QA-Board adds files there, it doesn't replace what's there.">
                <InputGroup id={`${template_id}-folder`} value={folder_path} placeholder="/linux or \\windows path on the shared storage" onChange={e => update({ folder_path: e.target.value })}/>
              </FormGroup>}
          <FormGroup label="As" helperText={type === 'link'
            ? 'Hard links: nothing is copied, the exported files are the runs\' files.'
            : folder_mode === 'path' && !path_is_same_fs && folder_path ? `Copies: links only work on the same filesystem (${batch_output_fs}).` : 'Copies: they take space of their own.'}>
            <SegmentedControl aria-label="As" small value={type} onValueChange={value => update({ type: value })}
              options={[{ label: 'Links', value: 'link', disabled: folder_mode === 'path' && !path_is_same_fs }, { label: 'Copies', value: 'copy' }]}/>
          </FormGroup>
        </div>
        <div className="export-preview">
          {result_block}
          {plan.items.length === 0 && <Callout icon="filter" intent="warning">No runs to export: change the filter.</Callout>}
          {preview_block}
        </div>
      </Columns>
    </DialogBody>
    <DialogFooter actions={<>
      <Button text="Close" onClick={onClose}/>
      <Button intent="primary" icon="export" loading={is_exporting} disabled={!can_export}
        text={p && is_current ? `Export ${plural(p.nb_files, 'file')}` : 'Export'} onClick={doExport}/>
    </>}>
      <a className={Classes.TEXT_SMALL} target="_blank" rel="noopener noreferrer" href={`${docs_root}docs/user-guide/sharing#exporting-files`}>How names work</a>
    </DialogFooter>
  </Dialog>;
};


// Exports the runs' files to a shared folder. A button opens the dialog.
const ExportPlugin = props => {
  const [open, setOpen] = useState(false);
  return <>
    {/* the focus comes back to the button when the dialog closes: that shouldn't open the tooltip */}
    <Tooltip content={export_help} placement="top" openOnTargetFocus={false}>
      <Button variant="outlined" icon="export" text="Export" aria-label="Export files" onClick={() => setOpen(true)}/>
    </Tooltip>
    <ExportDialog isOpen={open} onClose={() => setOpen(false)} {...props}/>
  </>;
};


export { ExportPlugin };
