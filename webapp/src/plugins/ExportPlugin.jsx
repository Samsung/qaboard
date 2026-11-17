import { useEffect, useId, useRef, useState } from "react";
import { useQuery, keepPreviousData } from "@tanstack/react-query";
import styled from "styled-components";

import {
  Classes,
  Intent,
  Tag,
  Callout,
  Checkbox,
  Collapse,
  FormGroup,
  InputGroup,
  HTMLSelect,
  Button,
  Dialog,
  DialogBody,
  DialogFooter,
  Menu,
  MenuDivider,
  MenuItem,
  PopoverNext,
  ProgressBar,
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
import { parse_template, file_name_parts, render_parts, FIELDS } from "../export/names";
import {
  LAYOUTS, SEPARATORS, SETTINGS_FORMATS, SETTINGS_ASSIGN, SETTINGS_JOIN, CONFIGURATIONS, PLATFORM, BATCH, DATABASE, ABSENT,
  default_naming, layout_of, export_runs, request_runs, item_fields, example_file, guess_file_in_names, crop_template,
  saved_settings, presets_for, preset_fit, may_be_images, SIDE_SEPARATORS, side_separator, with_side_separator,
} from "../export/plan";
import { reportUrl } from "../errors";
import { FieldDot, NameAnatomy, NameParts } from "../export/NameParts";
import { ExportProblems } from "../export/ExportProblems";
import { useCrops, useShownRegionSets, DEFAULT_MAX_FOUND, MAX_FOUND } from "../export/useCrops";
import { runs_url, python_snippet } from "./ScriptPlugin";


// By default we export the files of the first visualization
const default_path = (config, path) => {
  const visualization_path = config?.outputs?.visualizations?.[0]?.path;
  // for projects using dynamic outputs
  if (visualization_path) return visualization_path.replace(/:[a-zA-Z0-9_]+/g, '*');
  return path || '*.png';
};
// The visualizations' files, to pick them in one click: [{label, path}]
const visualization_files = config => {
  const seen = new Set();
  return (config?.outputs?.visualizations ?? [])
    .filter(v => v?.path && typeof v.path === 'string')
    .map(v => ({ label: v.name || v.path, path: v.path.replace(/:[a-zA-Z0-9_]+/g, '*') }))
    .filter(v => !seen.has(v.path) && seen.add(v.path))
    .slice(0, 8);
};

// "ISP stage (1 raw, 2 demosaic...)" => "ISP stage": the tags stay on a line or two, the full label shows on hover
const short_label = label => {
  const short = String(label).replace(/\s*\(.*$/, '');
  return short.length > 24 ? `${short.slice(0, 23)}…` : short || label;
};

export const export_help = "Gather the files matching a pattern from all the runs shown, new and reference, into a new folder";

const FIELD_HELP = {
  side: 'What the page calls the new and reference results',
  input: 'The input\'s path, without its extension',
  input_name: 'The input\'s name, without its folders',
  settings: 'What tells runs on the same input apart',
  file: 'The file\'s path in its run\'s folder',
  platform: 'The run\'s platform',
  commit: 'The commit, 8 characters',
  batch: 'The batch',
  run: 'The run\'s id',
  region: 'The region of interest, for crops',
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
// The steps of the form: what to export, how it's named, crops, where
const Step = styled.section`
  margin-bottom: 18px;
  > h4 { margin: 0 0 8px; display: flex; align-items: center; gap: 8px; }
`;
// What each part of the names says
const Parts = styled.div`
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 10px;
  .part { display: flex; gap: 8px; align-items: flex-start; }
  .part-body { flex: 1; min-width: 0; line-height: 20px; }
  .part-name { font-weight: 600; margin-right: 6px; }
  .part-values code { white-space: nowrap; }
  .part-action { margin-left: 4px; vertical-align: baseline; }
`;

const plural = (n, word, words) => `${n} ${n === 1 ? word : (words ?? `${word}s`)}`;
// a few values, and how many more
const Values = ({ values, max = 4, color }) => {
  const shown = values.slice(0, max);
  return <span className="part-values">
    {shown.map((v, index) => <span key={v}><code style={{ color, overflowWrap: 'anywhere' }}>{v}</code>{index < shown.length - 1 ? ', ' : ''}</span>)}
    {values.length > max && <span className={Classes.TEXT_MUTED}> and {values.length - max} more</span>}
  </span>;
};

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
const collision_fixes = (naming, candidates, picked, has_reference) => {
  const out = [];
  const fields = template_fields(naming.template);
  const add = field => ({ template: `${naming.template}__{${field}}` });
  if (!fields.includes('file')) out.push({ text: <>Add <code>{'{file}'}</code>: runs have several files matching the pattern</>, fix: add('file') });
  else if (naming.file_in_names !== true) out.push({ text: <>Always say the file</>, fix: { file_in_names: true } });
  if (!fields.includes('input') && !fields.includes('input_name')) out.push({ text: <>Add <code>{'{input}'}</code></>, fix: add('input') });
  if (fields.includes('input_name') && !fields.includes('input'))
    out.push({ text: <>Use <code>{'{input}'}</code>, not <code>{'{input_name}'}</code>: inputs in different folders have the same name</>, fix: { template: naming.template.replaceAll('{input_name}', '{input}') } });
  const unpicked = candidates.filter(c => !picked.includes(c.key));
  if (!fields.includes('settings') && candidates.length > 0) out.push({ text: <>Add <code>{'{settings}'}</code>, to tell runs on the same input apart</>, fix: add('settings') });
  else if (unpicked.length > 0) out.push({ text: <>Say all the settings that differ: {unpicked.map(c => c.key).join(', ')}</>, fix: { settings_keys: candidates.map(c => c.key) } });
  if (!fields.includes('side') && has_reference) out.push({ text: <>Add <code>{'{side}'}</code>: new and reference files have the same names</>, fix: add('side') });
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

// What the user's account can do, for copies: they're made as the user (backend/api/export_files.py, check_copies)
const CopyCheck = ({ check, folder, fixes, onFix }) => {
  const unreadable = check.unreadable ?? [];
  const sides = [...new Set(unreadable.map(u => u.side))];
  const all = unreadable.length > 0 && unreadable.length === check.nb_checked;
  const groups = check.groups_known === false && <p className={Classes.TEXT_MUTED} style={{ margin: '4px 0 0' }}>
    QA-Board only knows your account's primary group: copies of files you can read only through another group fail. Ask your QA-Board admins to give it your groups.
  </p>;
  return <>
    {check.folder_error && <Callout intent="danger" icon="lock" title="You can't write in this folder" style={{ marginBottom: 8 }}>
      Copies are made as you, and your account ({check.user}) can't write in <code style={{ wordBreak: 'break-all' }}>{folder}</code>.
      <Fixes fixes={fixes} onFix={onFix}/>
    </Callout>}
    {unreadable.length > 0 && <Callout intent={all ? 'danger' : 'warning'} icon="lock" title={`Your account can't read ${all ? "these runs' files" : "some runs' files"}`} style={{ marginBottom: 8 }}>
      Copies are made as you: {unreadable.length} of the {plural(check.nb_checked, 'file')} checked can't be read by your account ({check.user}), from the {sides.join(' and ')} runs, e.g. <code style={{ wordBreak: 'break-all' }}>{unreadable[0].error}</code>. {all ? 'The copies would fail.' : 'Their copies would fail.'}
      {groups}
      <Fixes fixes={fixes.filter(f => f.fix.type)} onFix={onFix}/>
    </Callout>}
    {!unreadable.length && groups}
    {check.error && <p className={Classes.TEXT_MUTED} style={{ margin: '4px 0' }}>QA-Board couldn't check what your account can copy: {check.error}</p>}
  </>;
};

const ProblemList = ({ items, more }) => <ul style={{ margin: '4px 0', paddingLeft: 18 }}>
  {items.map((item, index) => <li key={index}>{item}</li>)}
  {more > 0 && <li className={Classes.TEXT_MUTED}>and {more} more</li>}
</ul>;


// Saved export settings: a menu of the presets, with those that don't fit these runs disabled, and why. Save the form
// as one, delete the one loaded.
const Presets = ({ project, settings, onLoad, fit_context }) => {
  const presets = usePrefsStore(state => state.exportPresets);
  const save = usePrefsStore(state => state.saveExportPreset);
  const remove = usePrefsStore(state => state.deleteExportPreset);
  const [loaded, setLoaded] = useState(null);
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState('');
  const [this_project, setThisProject] = useState(false);
  const available = presets_for(presets, project);
  const current = available.find(p => p.id === loaded);
  const menu = <Menu aria-label="Presets" style={{ maxWidth: 420 }}>
    {available.length === 0 && <MenuItem disabled text="No presets yet" multiline
      label={null} labelElement={null} icon="info-sign"/>}
    {available.map(preset => {
      const fit = preset_fit(preset.settings, fit_context);
      return <MenuItem key={preset.id} icon={preset.id === loaded ? 'tick' : 'bookmark'} multiline disabled={!!fit.disabled}
        label={preset.project ? 'this project' : undefined} onClick={() => { setLoaded(preset.id); onLoad(preset.settings); }}
        text={<span>
          {preset.name}
          {fit.disabled && <span className={Classes.TEXT_MUTED} style={{ display: 'block', fontSize: 12 }}>Doesn't fit these runs. {fit.disabled}.</span>}
          {!fit.disabled && fit.notes.map(note => <span key={note} className={Classes.TEXT_MUTED} style={{ display: 'block', fontSize: 12 }}>{note}</span>)}
        </span>}/>;
    })}
    <MenuDivider/>
    <MenuItem icon="floppy-disk" text="Save these settings as a preset…" onClick={() => { setSaving(true); setName(current?.name ?? ''); }}/>
  </Menu>;
  return <div style={{ marginBottom: 14 }}>
    <Row style={{ alignItems: 'center', gap: 8 }}>
      <PopoverNext content={menu} placement="bottom-start">
        <Button size="small" variant="outlined" icon="bookmark" endIcon="caret-down" text={current ? `Preset: ${current.name}` : 'Presets'}/>
      </PopoverNext>
      {current && !saving && <Button size="small" variant="minimal" icon="trash" aria-label={`Delete the preset ${current.name}`} onClick={() => { remove(current.id); setLoaded(null); }}/>}
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
  </div>;
};


// Which settings names say, and how
const SettingsPicker = ({ plan, naming, update, onToggle }) => <div style={{ margin: '6px 0 2px' }}>
  <div role="group" aria-label="Settings in names" style={{ display: 'flex', flexWrap: 'wrap', gap: '0 16px' }}>
    {plan.candidates.map(c => <Checkbox key={c.key} inline style={{ margin: '2px 0' }} checked={plan.picked.includes(c.key)} onChange={() => onToggle(c.key)}
      labelElement={<Tooltip content={`${plural(c.values, 'value')}${c.needed ? ', tells runs on the same input apart' : c.on_input ? ', differs between runs on the same input, but the settings checked tell them apart already' : ', only differs between inputs'}`} placement="top" hoverOpenDelay={300}>
        <span>{[CONFIGURATIONS, PLATFORM, BATCH, DATABASE].includes(c.key) ? c.key : <code>{c.key}</code>}{c.needed && <span className={Classes.TEXT_MUTED}> (needed)</span>}</span>
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
  {plan.picked.length > 0 && <Checkbox style={{ margin: '8px 0 0' }} checked={naming.settings_where !== 'all'} onChange={e => update({ settings_where: e.target.checked ? 'needed' : 'all' })}
    labelElement={<span>Only in the names that need them <span className={Classes.TEXT_MUTED} style={{ fontSize: 12 }}>
      {naming.settings_where !== 'all'
        ? 'A run says a setting if another run on the same input has another value.'
        : <>Every name says every setting checked, <code>{ABSENT}</code> for runs that don't set it: for scripts that read them.</>}
    </span></span>}/>}
  {plan.picked.length > 0 && naming.settings_format !== 'values' && <p className={Classes.TEXT_MUTED} style={{ margin: '4px 0 0', fontSize: 12 }}>
    {SETTINGS_FORMATS.find(s => s.value === naming.settings_format)?.description}
  </p>}
</div>;


// The regions of interest to crop, from the image viewer: presets, where the images differ, annotations, quarters
const CropsStep = ({ crops, picked, enabled, whole, shown, max_found, onChange }) => {
  // what users type, until they leave the field: a number from 1 to MAX_FOUND applies at once
  const [max_text, setMaxText] = useState(null);
  const usable = crops.sources.filter(s => !s.disabled);
  const unusable = crops.sources.filter(s => s.disabled);
  const toggle = (source, checked) => {
    const next = checked ? [...picked.filter(id => id !== source.id), source.id] : picked.filter(id => id !== source.id);
    onChange({ crop_sources: next });
    // finding them is what users asked for
    if (checked && source.kind === 'find') crops.start(source.id);
  };
  const source_row = source => {
    const is_picked = picked.includes(source.id);
    const done = source.kind !== 'find' || source.searched >= source.total;
    return <div key={source.id} style={{ marginBottom: 4 }}>
      <Checkbox style={{ margin: 0 }} checked={is_picked && !source.disabled} disabled={!!source.disabled} onChange={e => toggle(source, e.target.checked)}
        labelElement={<span>
          <Tooltip content={source.disabled ?? source.description} placement="top" hoverOpenDelay={300}><span>{source.label}</span></Tooltip>
          {source.experimental && <Tag minimal style={{ marginLeft: 6 }}>Experimental</Tag>}
          {shown.includes(source.id) && <Tag minimal intent="primary" style={{ marginLeft: 6 }} title="The regions shown in the image viewers">shown in the viewers</Tag>}
          {' '}<span className={Classes.TEXT_MUTED} style={{ fontSize: 12 }}>
            {source.disabled ? source.disabled
              : source.kind === 'quarters' ? 'top-left, top-right, bottom-left, bottom-right'
              : source.kind === 'known' ? `${plural(source.regions, 'region')} in ${plural(source.runs, 'run')}`
              : source.searched === 0 ? (is_picked ? '' : `in ${plural(source.total, 'run')}`)
              : `${plural(source.regions, 'region')} in ${plural(source.runs, 'run')}${source.automatic && source.found > source.regions ? ` (of ${source.found} found)` : ''}${done ? '' : `, ${source.searched}/${source.total} runs searched`}`}
          </span>
        </span>}/>
      {is_picked && source.kind === 'find' && !source.disabled && !done && <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '2px 0 4px 26px' }}>
        <div style={{ flex: 1, maxWidth: 220 }}><ProgressBar value={source.total ? source.searched / source.total : 0} animate={source.fetching > 0} stripes={source.fetching > 0} intent="primary"/></div>
        {source.fetching > 0
          ? <><span className={Classes.TEXT_MUTED} style={{ fontSize: 12 }}>Finding… {source.searched}/{source.total}</span><Button size="small" variant="minimal" icon="stop" text="Stop" onClick={() => crops.stop(source.id)}/></>
          : <Button size="small" variant="minimal" icon="search" text={source.searched ? `Find in the ${source.total - source.searched === 1 ? 'last run' : `other ${source.total - source.searched}`}` : `Find in the ${plural(source.total, 'run')}`} onClick={() => crops.start(source.id)}/>}
        {source.failed > 0 && <span className="bp6-text-danger" style={{ fontSize: 12 }}>{source.failed} failed</span>}
      </div>}
    </div>;
  };
  return <Step aria-label="Regions of interest">
    <h4 className={Classes.HEADING}>Regions of interest <span className={Classes.TEXT_MUTED} style={{ fontWeight: 400, fontSize: 13 }}>(optional)</span></h4>
    <Switch checked={enabled} onChange={e => onChange({ crops: e.target.checked })} style={{ marginBottom: enabled ? 8 : 0 }}
      label="Also export crops of the images' regions of interest"/>
    {enabled && <div style={{ paddingLeft: 26 }}>
      {usable.map(source_row)}
      {unusable.length > 0 && <details style={{ margin: '2px 0 6px' }}>
        <summary className={Classes.TEXT_MUTED} style={{ cursor: 'pointer', fontSize: 12 }}>{plural(unusable.length, 'other source')} can't be used here</summary>
        {unusable.map(source_row)}
      </details>}
      {usable.some(s => s.automatic && picked.includes(s.id)) && <label style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '6px 0 0', flexWrap: 'wrap' }}>
        <span>Where they differ: the</span>
        <input type="number" className={Classes.INPUT} aria-label="Differences per image" min={1} max={MAX_FOUND} step={1} value={max_text ?? max_found}
          style={{ width: 64, height: 26 }} onBlur={() => setMaxText(null)}
          onChange={e => {
            setMaxText(e.target.value);
            const n = Number(e.target.value);
            if (e.target.value !== '' && Number.isInteger(n) && n >= 1 && n <= MAX_FOUND) onChange({ crop_max: n });
          }}/>
        <span>largest differences of each image</span>
      </label>}
      <Checkbox style={{ margin: '6px 0 0' }} checked={whole} label="Export the whole images too" onChange={e => onChange({ whole_files: e.target.checked })}/>
      <p className={Classes.TEXT_MUTED} style={{ fontSize: 12, margin: '4px 0 0' }}>
        Crops are named after their <span style={{ color: 'var(--qa-export-region)' }}>region</span>: its label when it has a short one, e.g. <code>face</code>,
        else <code>diff-01</code>, <code>diff-02</code>… (the largest difference first) or <code>roi-01</code>. Reference images are cropped at the same place.
        Crops are new files, even when files are exported as links. <code>0.export.csv</code> says where each crop comes from.
      </p>
    </div>}
  </Step>;
};


// The export's form, its live preview from the server (what the export would do), and the result.
// It stays mounted while the dialog is closed: the form and the last export stay.
const ExportDialog = ({
  isOpen, onClose, project, ref_project, config, new_batch, ref_batch, labels, batch_dir_url,
  new_commit_id, ref_commit_id, selected_batch_new, selected_batch_ref, filter_batch_new, filter_batch_ref, path: config_path,
  nb_references = 1,
}) => {
  const { docs_root, cli_requirements, support_url } = useSiteConfig();
  // the last export's settings in this project
  const last = usePrefsStore(state => state.exportLast?.[project]);
  const setLast = usePrefsStore(state => state.setExportLast);
  const [settings, setSettings] = useState(() => ({ ...default_naming, ...last }));
  const update = changes => setSettings(s => ({ ...s, ...changes }));
  const naming = { ...default_naming, ...settings };
  const [label_overrides, setLabelOverrides] = useState({ new: '', reference: '' });
  // exporting one side alone: names don't say new or reference, unless users name it, e.g. after the tuning batch
  const [label_alone, setLabelAlone] = useState('');
  // "both": the runs shown and their reference, or only "new" or "reference". Each export starts with both.
  const [sides_choice, setSides] = useState('both');
  const [folder_name, setFolderName] = useState('');
  const [folder_id, setFolderId] = useState(new_folder_id);
  const [is_exporting, setExporting] = useState(false);
  const [result, setResult] = useState(null);
  // what's open: the settings picker, renaming new and reference, more options
  const [open_part, setOpenPart] = useState(null);
  const [more, setMore] = useState(false);
  const path_id = useId();
  const template_id = useId();
  const path_input = useRef(null);
  const template_input = useRef(null);

  const path = settings.files ?? default_path(config, config_path);
  const problem = pattern_problem(path);
  const folder_mode = settings.folder_mode ?? 'new';
  const folder_path = settings.folder_path ?? '';

  // crops: the sources users picked, else what the viewers show, else the presets
  const images = may_be_images(path);
  const crops_enabled = images && !!settings.crops;
  const shown_sets = useShownRegionSets(path);
  // what users picked in this dialog, else what the viewers show, else what they picked last time
  const [sources_picked, setSourcesPicked] = useState(false);
  const chosen_sources = sources_picked || shown_sets.length === 0 ? (settings.crop_sources ?? null) : null;
  const max_found = Math.min(MAX_FOUND, Math.max(1, Math.round(Number(settings.crop_max) || DEFAULT_MAX_FOUND)));
  const crops = useCrops({ enabled: crops_enabled, picked: chosen_sources, shown: shown_sets, files: path, new_batch, ref_batch, max_found });
  const crop_sources = crops.picked;
  const whole_files = settings.whole_files ?? true;
  // the folders the pattern matches, with their files
  const folders = settings.folders ?? true;

  const label_new = label_overrides.new.trim() || labels?.new || 'new';
  const label_ref = label_overrides.reference.trim() || labels?.reference || 'reference';
  const plan = export_runs({ new_batch, ref_batch, labels: { new: label_new, reference: label_ref, alone: label_alone }, naming, regions: crops.regions, sides: sides_choice });
  // the page compares with a reference, and the export has both sides: names say which
  const { has_reference, both } = plan;
  const fields = template_fields(naming.template);
  // the runs named after themselves: the new ones, or the reference's when it's exported alone
  const main_items = plan.items.filter(i => i.side === plan.side);
  const nb_regions = crops_enabled ? main_items.reduce((n, i) => n + (i.regions?.length ?? 0), 0) : 0;

  let template_error = null;
  try { parse_template(naming.template); } catch (e) { template_error = e.message; }

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
    file_in_names: naming.file_in_names === 'auto' ? 'auto' : true,
    ...(crops_enabled && nb_regions > 0 ? { whole_files } : {}),
    folders,
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

  // the names, as colored parts: the server's when it listed the files, else an example from the pattern
  const side_fields = item => item_fields(item, item?.side === 'reference'
    ? { commit_id: ref_commit_id, batch_label: selected_batch_ref }
    : { commit_id: new_commit_id, batch_label: selected_batch_new });
  const file_in_names = p && is_current && typeof p.file_in_names === 'boolean' ? p.file_in_names : guess_file_in_names(naming, path);
  const parts_of = f => {
    const item = plan.items[f.item];
    if (!is_current || !item || item.id !== f.run) return null;
    // a file in a folder exported whole: the folder's name, then the file's path in it
    if (f.folder) try {
      const parts = render_parts(naming.template, { ...side_fields(item), file: file_in_names ? f.folder.file : '', region: '' }, naming.separator, '', naming.windows);
      if (parts.map(x => x.text).join('') !== f.folder.to) return null;
      return [...parts, { text: f.to.slice(f.folder.to.length), field: null }];
    } catch { return null; }
    try {
      const parts = file_name_parts(f.region ? crop_template(naming.template) : naming.template, { ...side_fields(item), region: f.region ?? '' }, f.file, naming.separator, naming.windows, file_in_names);
      return parts.map(x => x.text).join('') === f.to ? parts : null;
    } catch { return null; }
  };
  const example_parts = (item, region = '') => {
    if (!item || template_error) return null;
    try {
      return file_name_parts(region ? crop_template(naming.template) : naming.template, { ...side_fields(item), region }, example_file(path), naming.separator, naming.windows, file_in_names);
    } catch (e) { return { error: e.message }; }
  };
  const listed = p && is_current ? p.files : [];
  // the example: the name that says the most, e.g. the run that needs its settings
  const fields_in = parts => new Set(parts?.filter(x => x.field).map(x => x.field)).size;
  const richest = candidates => candidates.reduce((best, parts) => fields_in(parts) > fields_in(best) ? parts : best, null);
  const listed_main = listed.filter(f => f.side === plan.side);
  const whole_listed = listed_main.filter(f => !f.region);
  const first_item = main_items.find(i => i.fields.settings) ?? main_items[0];
  const example = richest((whole_listed.length ? whole_listed : listed_main).slice(0, 200).map(parts_of))
    ?? example_parts(first_item, crops_enabled && !whole_files ? first_item?.regions?.[0]?.name : '');
  if (example?.error && !template_error) template_error = example.error;
  const example_side = plan.side;

  const setLayout = key => {
    const layout = LAYOUTS.find(l => l.key === key);
    // with what users put before new or reference, e.g. @
    if (layout) update({ layout: key, template: with_side_separator(layout.template, side_separator(naming.template) ?? '__'), separator: layout.separator });
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

  const finding = crops_enabled ? crops.finding : [];
  // copies are made as the user: the server checks what their account can do (copy_check)
  const copy_check = type === 'copy' ? p?.copy_check : null;
  const can_export = can_preview && is_current && !preview.isFetching && !preview.error && p && p.nb_files > 0 && p.nb_collisions === 0 && !(p.nb_too_long > 0) && finding.length === 0 && !copy_check?.folder_error;
  const doExport = () => {
    setExporting(true);
    http.post('/api/v1/exports', body, { params: { project } })
      .then(({ data }) => {
        track('export_start', { export_type: type, n_runs: data.nb_runs, n_files: data.nb_files_exported, n_failed: data.nb_failed ?? 0, layout: layout_of(naming.template, naming.separator), windows: naming.windows, crops: data.nb_crops ?? 0, crop_sources: crops_enabled ? crop_sources.join(',') : '', sides: both ? 'both' : plan.side }, { project_id: project });
        if (data.nb_files_exported === 0 && data.nb_failed > 0)
          toaster.show({ message: 'Nothing was exported: the dialog says why.', intent: Intent.DANGER });
        else
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
  const same_name = name => naming.windows ? name.toLowerCase() : name;
  const collided = new Set((p?.collisions ?? []).map(c => same_name(c.to)));
  const too_long = new Set((p?.too_long ?? []).map(t => t.to));
  const requirements = cli_requirements?.length ? cli_requirements : ['qaboard'];
  const snippet = python_snippet(runs_url({ project, commit_id: new_commit_id, batch: selected_batch_new, filter: filter_batch_new, ref_project, ref_commit_id, batch_ref: selected_batch_ref, filter_ref: filter_batch_ref }), requirements);
  const sides = labels?.colors;
  const quick_files = visualization_files(config).filter(v => v.path !== path);

  // the values each part takes
  const new_items = main_items;
  const inputs = [...new Set(new_items.map(i => i.fields.input))];
  const settings_values = [...new Set(new_items.map(i => i.fields.settings).filter(Boolean))];
  const with_settings = new_items.filter(i => i.fields.settings).length;
  const files_listed = [...new Set(listed.filter(f => !f.region).map(f => f.folder ? `${f.folder.file}/` : f.file))];
  const region_names = [...new Set(new_items.flatMap(i => (i.regions ?? []).map(r => r.name)))];
  const needed = plan.candidates.filter(c => c.needed);

  // What each part of the names says, and the values it takes. The parts names don't need say why.
  const part = (field, { title, body, muted, action, children }) => <div className="part" key={field}>
    <FieldDot field={field} side="new" sides={sides} muted={muted}/>
    <div className="part-body" style={muted ? { color: 'var(--qa-text-muted)' } : undefined}>
      <span className="part-name" style={!muted && ['settings', 'file', 'region'].includes(field) ? { color: `var(--qa-export-${field})` } : undefined}>{title}</span>
      {body}
      {action}
      {children}
    </div>
  </div>;
  const has = field => fields.includes(field);
  // the batch of the side exported alone, to name it after: tuning batches have names, "default" doesn't say much
  const alone_batch = [plan.side === 'reference' ? selected_batch_ref : selected_batch_new].find(b => b && b !== 'default') ?? '';
  const settings_picker = <SettingsPicker plan={plan} naming={naming} update={update} onToggle={toggleSetting}/>;
  const settings_action = text => <Button className="part-action" size="small" variant="minimal" intent="primary" text={open_part === 'settings' ? 'Done' : text} onClick={() => setOpenPart(open_part === 'settings' ? null : 'settings')}/>;
  // The parts names don't need, on one line, and why
  const left_out = [
    has('settings') && with_settings === 0 && {
      name: 'settings',
      why: plan.candidates.length === 0 ? 'the runs have the same'
        : needed.length === 0 ? 'they only differ between inputs' : 'none picked: runs on the same input get the same names',
      action: plan.candidates.length > 0 && settings_action('Pick some'),
    },
    has('file') && !file_in_names && {
      name: 'file',
      why: <>one <code>{path}</code> per run</>,
      action: <Button className="part-action" size="small" variant="minimal" intent="primary" text="Always say it" onClick={() => update({ file_in_names: true })}/>,
    },
    has('side') && !both && !label_alone.trim() && {
      name: 'new or reference',
      why: has_reference ? `only ${plan.side === 'reference' ? 'the reference' : 'the new results'} exported` : 'no reference: one version',
      action: open_part !== 'alone' && <Button className="part-action" size="small" variant="minimal" intent="primary" text="Name them" onClick={() => setOpenPart('alone')}/>,
    },
  ].filter(Boolean);
  const parts_list = <Parts aria-label="What names say">
    {(has('input') || has('input_name')) && part(has('input') ? 'input' : 'input_name', {
      title: has('input') ? 'Input' : 'Input\'s name',
      body: <>{has('input') ? 'the input\'s path' : 'the input\'s name, without its folders'}: <Values max={2} values={inputs.map(i => has('input') ? i : i.split('/').pop())}/></>,
    })}
    {has('settings') && with_settings > 0 && part('settings', {
      title: 'Settings',
      body: <>{with_settings < new_items.length
        ? <>only for the {plural(with_settings, 'run')} of {new_items.length} that share{with_settings === 1 ? 's' : ''} an input with another</>
        : <>what tells runs on the same input apart</>}: <Values max={3} values={settings_values} color="var(--qa-export-settings)"/></>,
      action: settings_action('Change'),
      children: open_part === 'settings' && settings_picker,
    })}
    {has('file') && file_in_names && part('file', {
      title: 'File',
      body: <>the file's path in its run's folder{files_listed.length > 0 && <>: <Values values={files_listed} color="var(--qa-export-file)"/></>}{naming.file_in_names === 'auto' && <span className={Classes.TEXT_MUTED}> (runs have several files)</span>}</>,
    })}
    {crops_enabled && region_names.length > 0 && part('region', {
      title: 'Region',
      body: <>crops only: <Values values={region_names} color="var(--qa-export-region)"/></>,
    })}
    {has('side') && both && part('side', {
      title: 'New or reference',
      body: <><code style={{ color: sides?.new?.css ?? 'var(--qa-side-0)', fontWeight: 600 }}>{plan.labels.new}</code> and{' '}
        <code style={{ color: sides?.reference?.css ?? 'var(--qa-side-1)', fontWeight: 600 }}>{plan.labels.reference}</code>{label_overrides.new.trim() || label_overrides.reference.trim() ? '' : ', as on the page'}</>,
      action: <Button className="part-action" size="small" variant="minimal" intent="primary" text={open_part === 'side' ? 'Done' : 'Rename'} onClick={() => setOpenPart(open_part === 'side' ? null : 'side')}/>,
      children: open_part === 'side' && <Row style={{ marginTop: 4 }}>
        <FormGroup label="New results" labelFor={`${template_id}-new`} style={{ margin: 0 }}>
          <InputGroup id={`${template_id}-new`} small value={label_overrides.new} placeholder={labels?.new || 'new'} onChange={e => setLabelOverrides(l => ({ ...l, new: e.target.value }))}/>
        </FormGroup>
        <FormGroup label="Reference" labelFor={`${template_id}-ref`} style={{ margin: 0 }}>
          <InputGroup id={`${template_id}-ref`} small value={label_overrides.reference} placeholder={labels?.reference || 'reference'} onChange={e => setLabelOverrides(l => ({ ...l, reference: e.target.value }))}/>
        </FormGroup>
        {side_separator(naming.template) !== null && <FormGroup label="Before it" labelFor={`${template_id}-side-separator`} style={{ margin: 0 }}>
          <HTMLSelect id={`${template_id}-side-separator`} value={side_separator(naming.template)} onChange={e => update({ template: with_side_separator(naming.template, e.target.value) })}
            options={[...new Set([...SIDE_SEPARATORS, side_separator(naming.template)])].map(sep => ({ value: sep, label: `${sep}${plan.labels.new}` }))}/>
        </FormGroup>}
        <p className={Classes.TEXT_MUTED} style={{ flexBasis: '100%', margin: '2px 0 0', fontSize: 12 }}>These names are only for this export: the page and its milestones keep theirs.</p>
      </Row>,
    })}
    {has('side') && !both && (label_alone.trim() || open_part === 'alone') && part('side', {
      title: 'Label',
      body: label_alone.trim()
        ? <>after the {plan.side === 'reference' ? 'reference' : 'new'} results: <code style={{ color: plan.side === 'reference' ? sides?.reference?.css : sides?.new?.css, fontWeight: 600 }}>{label_alone.trim()}</code></>
        : <>what to call the {plan.side === 'reference' ? 'reference' : 'new'} results in names, e.g. the batch's name</>,
      children: <Row style={{ marginTop: 4, alignItems: 'center' }}>
        <InputGroup aria-label="Label in names" small autoFocus={!label_alone} value={label_alone} placeholder={alone_batch || 'e.g. tuning-gain'} onChange={e => setLabelAlone(e.target.value)}/>
        {alone_batch && label_alone.trim() !== alone_batch && <Button size="small" variant="minimal" intent="primary" text={<>The batch: <code>{alone_batch}</code></>} onClick={() => setLabelAlone(alone_batch)}/>}
        {label_alone && <Button size="small" variant="minimal" text="Remove" onClick={() => { setLabelAlone(''); setOpenPart(null); }}/>}
        <p className={Classes.TEXT_MUTED} style={{ flexBasis: '100%', margin: '2px 0 0', fontSize: 12 }}>Only for this export. In the template, <code>{'{side}'}</code> says it.</p>
      </Row>,
    })}
    {left_out.length > 0 && <div className="part" aria-label="Not in names">
      <FieldDot field="input" muted/>
      <div className="part-body" style={{ color: 'var(--qa-text-muted)' }}>
        Not needed here:{' '}
        {left_out.map((item, index) => <span key={item.name}>{index > 0 && ' · '}<strong>{item.name}</strong> ({item.why}){item.action}</span>)}
        {open_part === 'settings' && with_settings === 0 && settings_picker}
      </div>
    </div>}
  </Parts>;

  // the options most people don't need, and how many differ from the defaults
  const layout_info = LAYOUTS.find(l => l.key === layout);
  const changed = [
    type !== 'link', folder_mode !== 'new', !naming.windows, naming.file_in_names !== 'auto', !naming.pair_references,
    layout === 'custom', layout_info && naming.separator !== layout_info.separator,
  ].filter(Boolean).length;
  const more_options = <>
    <FormGroup label="As" helperText={type === 'link'
      ? 'Links: nothing is copied, the exported files are the runs\' files. Don\'t edit them.'
      : folder_mode === 'path' && !path_is_same_fs && folder_path ? `Copies: links only work on the same filesystem (${batch_output_fs}).` : 'Copies: they take space of their own.'}>
      <SegmentedControl aria-label="As" small value={type} onValueChange={value => update({ type: value })}
        options={[{ label: 'Links', value: 'link', disabled: folder_mode === 'path' && !path_is_same_fs }, { label: 'Copies', value: 'copy' }]}/>
    </FormGroup>
    <FormGroup label="Where">
      <SegmentedControl aria-label="Where" small value={folder_mode} onValueChange={mode => update({ folder_mode: mode })}
        options={[{ label: 'A new folder', value: 'new' }, { label: 'A folder I choose', value: 'path' }]}/>
    </FormGroup>
    {folder_mode === 'path' && <FormGroup label="Folder" labelFor={`${template_id}-folder`} helperText="On the shared storage. QA-Board adds files there, it doesn't replace what's there.">
      <InputGroup id={`${template_id}-folder`} value={folder_path} placeholder="/linux or \\windows path on the shared storage" onChange={e => update({ folder_path: e.target.value })}/>
    </FormGroup>}
    <Row>
      <FormGroup label="The file in names">
        <HTMLSelect aria-label="The file in names" value={naming.file_in_names === 'auto' ? 'auto' : 'always'} onChange={e => update({ file_in_names: e.target.value === 'auto' ? 'auto' : true })}
          options={[{ value: 'auto', label: 'When runs have several files' }, { value: 'always', label: 'Always' }]}/>
      </FormGroup>
      <FormGroup label="Folders in paths" labelFor={`${template_id}-separator`}>
        <HTMLSelect id={`${template_id}-separator`} value={naming.separator} onChange={e => update({ separator: e.target.value })}
          options={SEPARATORS.map(s => ({ value: s.value, label: s.label }))}/>
      </FormGroup>
    </Row>
    <FormGroup helperText={naming.windows
      ? 'No \\ / : * ? " < > |, paths under 260 characters, names that differ only by case are the same.'
      : 'Names only for Linux: paths can be long, and use any character but /.'}>
      <Switch checked={naming.windows} label="Windows-compatible names" style={{ marginBottom: 0 }} onChange={e => update({ windows: e.target.checked })}/>
    </FormGroup>
    {both && <FormGroup>
      <Switch checked={naming.pair_references} style={{ marginBottom: 0 }} onChange={e => update({ pair_references: e.target.checked })}
        labelElement={<Tooltip content="A reference run compared to several new runs is exported once per new run, with its input and settings: files pair up." placement="top">
          <span>Name reference files like the new runs they're compared to</span>
        </Tooltip>}/>
    </FormGroup>}
    <FormGroup label="Template" labelFor={template_id} helperText={template_error
      ? <span style={{ color: 'var(--bp-intent-danger-text, #c23030)' }}>{template_error}</span>
      : <>Fields in braces, the extension is added. Empty fields leave out the separator next to them. Add a field:{' '}
        {FIELDS.map(f => <Tooltip key={f} content={FIELD_HELP[f]} placement="bottom" hoverOpenDelay={300}>
          <Button size="small" variant="minimal" style={{ fontFamily: 'monospace', padding: '0 4px' }} onClick={() => insertField(f)}>{`{${f}}`}</Button>
        </Tooltip>)}</>}>
      <InputGroup id={template_id} inputRef={template_input} value={naming.template} intent={template_error ? 'danger' : undefined}
        style={{ fontFamily: 'monospace' }} onChange={e => update({ template: e.target.value })}/>
    </FormGroup>
  </>;

  const preview_block = !can_preview ? null : <section aria-label="Preview" style={{ marginTop: 4 }}>
    <h4 className={Classes.HEADING} style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '0 0 6px' }}>
      Preview {checking && <Spinner size={14} aria-label="Checking"/>}
    </h4>
    {preview.error && !preview.isFetching && <Callout intent="danger" icon="error">{errorMessage(preview.error)}</Callout>}
    {p && <div style={{ opacity: is_current ? 1 : 0.6 }}>
      <p style={{ marginBottom: 6 }}>
        <strong>{plural(p.nb_files, 'file')}</strong>{p.nb_crops > 0 && <> ({plural(p.nb_crops, 'crop')})</>} from {plural(p.nb_runs, 'run')} into{' '}
        {p.folder_exists ? 'the folder' : 'a new folder'} <code style={{ wordBreak: 'break-all' }}>{p.folder}</code>
        {type === 'link' ? ', as links to the runs\' files.' : ', as copies.'}
      </p>
      {p.runs_without_files > 0 && <p className={Classes.TEXT_MUTED} style={{ marginBottom: 6 }}>
        {plural(p.runs_without_files, 'run has', 'runs have')} no file matching <code>{path}</code>.
      </p>}
      {p.nb_not_croppable > 0 && <p className={Classes.TEXT_MUTED} style={{ marginBottom: 6 }}>
        {plural(p.nb_not_croppable, 'file isn\'t an image', 'files aren\'t images')} QA-Board can crop (PNG, JPEG, TIFF, BMP, WebP), e.g. <code>{p.not_croppable?.[0]}</code>: exported whole.
      </p>}
      {p.nb_files === 0 && <Callout intent="warning" icon="search">No file matches <code>{path}</code> in these runs: check the pattern, e.g. <code>**/*.png</code> looks in subfolders too.</Callout>}
      {p.nb_collisions > 0 && <Callout intent="danger" icon="duplicate" title={`${plural(p.nb_collisions, 'name is', 'names are')} used by several files`} style={{ marginBottom: 8 }}>
        <ProblemList more={p.nb_collisions - p.collisions.length} items={p.collisions.slice(0, 5).map(c => <span key={c.to}>
          <code>{c.to}</code>: {c.sources.map(s => `run ${s.run} (${s.side}) ${s.file}${s.region ? ` ${s.region}` : ''}`).join(', ')}{c.count > c.sources.length ? '…' : ''}
        </span>)}/>
        {naming.windows && <p className={Classes.TEXT_MUTED} style={{ margin: '4px 0' }}>Names that differ only by case are the same name on Windows.</p>}
        <p style={{ margin: '6px 0 0' }}>To make names unique:</p>
        <Fixes fixes={collision_fixes(naming, plan.candidates, plan.picked, both)} onFix={update}/>
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
      {copy_check && <CopyCheck check={copy_check} folder={p.folder} onFix={update} fixes={[
        !(folder_mode === 'path' && !path_is_same_fs) && { text: 'Export links instead', fix: { type: 'link' } },
        folder_mode === 'path' && copy_check.folder_error && { text: 'Export into a new folder', fix: { folder_mode: 'new' } },
      ].filter(Boolean)}/>}
      {p.nb_folders > 0 && <p className={Classes.TEXT_MUTED} style={{ marginBottom: 6 }}>
        {plural(p.nb_folders, 'folder')} with the {plural(p.nb_in_folders, 'file')} in {p.nb_folders === 1 ? 'it' : 'them'}: each folder is named like a file, and its files keep their names and subfolders.{' '}
        <Button size="small" variant="minimal" intent="primary" text="Only files" onClick={() => update({ folders: false })}/>
      </p>}
      {p.folders_skipped > 0 && <p className={Classes.TEXT_MUTED} style={{ marginBottom: 6 }}>
        {plural(p.folders_skipped, 'folder matches', 'folders match')} the pattern, not exported.{' '}
        <Button size="small" variant="minimal" intent="primary" text="Export them with their files" onClick={() => update({ folders: true })}/>
      </p>}
      {p.files.length > 0 && <div role="list" aria-label="Exported files" style={{ maxHeight: 'min(440px, 45vh)', overflow: 'auto', border: '1px solid var(--qa-border)', borderRadius: 3, padding: '4px 0', fontFamily: 'var(--bp-typography-family-mono, monospace)', fontSize: 12 }}>
        {p.files.map((f, index) => {
          const parts = parts_of(f);
          return <div role="listitem" key={index} title={`run ${f.run} (${f.side}), ${f.file}${f.region ? `, region ${f.region}` : ''}`}
            style={{ display: 'flex', gap: 8, alignItems: 'baseline', padding: '1px 8px', background: index % 2 ? 'var(--qa-surface-alt)' : undefined }}>
            <span style={{ flex: 1, minWidth: 0, wordBreak: 'break-all', paddingLeft: f.region ? 12 : 0 }}>{parts ? <NameParts parts={parts} side={f.side} sides={sides}/> : f.to}</span>
            {collided.has(same_name(f.to)) && <Tag minimal intent="danger">same name</Tag>}
            {too_long.has(f.to) && <Tag minimal intent="danger">too long</Tag>}
            {f.exists && <Tag minimal intent={p.existing_policy === 'replace' ? 'warning' : 'primary'}>{p.existing_policy === 'replace' ? 'replaced' : 'kept'}</Tag>}
          </div>;
        })}
        {p.nb_files > p.files.length && <div className={Classes.TEXT_MUTED} style={{ padding: '0 8px' }}>and {p.nb_files - p.files.length} more</div>}
      </div>}
    </div>}
  </section>;

  const feedback_url = reportUrl(support_url, {
    subject: 'Feedback on the new Export',
    body: `What worked, what's missing or confusing?\n\n\n--\nPage: ${window.location.href}`,
  });
  // the server groups what failed (`problems`); `errors` ends with a line per problem, after the plan's own errors
  const nb_failed = result?.nb_failed ?? 0;
  const other_errors = result?.problems ? (result.errors ?? []).slice(0, (result.errors ?? []).length - result.problems.length) : (result?.errors ?? []);
  const result_block = result && <section aria-label="Last export" style={{ marginBottom: 12 }}>
    {result.error
      ? <Callout intent="danger" icon="error" title="The export failed">{result.error}</Callout>
      : result.nb_files_exported === 0 && nb_failed > 0
      ? <Callout intent="danger" icon="error" title="Nothing was exported">
          <p style={{ margin: 0 }}>None of the {plural(nb_failed + (result.nb_not_attempted ?? 0), 'file')} could be {result.type === 'copy' ? 'copied' : 'linked'} into <code style={{ wordBreak: 'break-all' }}>{result.folder}</code>.</p>
          <ExportProblems result={result} support_url={support_url}/>
          {other_errors.length > 0 && <ProblemList items={other_errors.map(e => <code key={e}>{e}</code>)}/>}
        </Callout>
      : <Callout intent={nb_failed || other_errors.length || result.nb_skipped ? 'warning' : 'success'} icon={nb_failed ? 'warning-sign' : 'tick'}
          title={`${plural(result.nb_files_exported, 'file')} exported from ${plural(result.nb_runs, 'run')}${nb_failed ? `, ${plural(nb_failed, 'file')} failed` : ''}`}>
          <Paths folder={result.folder}/>
          {result.mapping && <p style={{ margin: '6px 0 0' }}><code>{result.mapping}</code> in the folder lists each file and where it comes from: its run, input and settings (with the runs' configurations in <code>{result.mapping.replace(/\.csv$/, '.json')}</code>).</p>}
          {result.type === 'link' && <p style={{ margin: '4px 0 0' }} className={Classes.TEXT_MUTED}>The files are links to the runs' files, not copies: don't edit them.</p>}
          {result.nb_symlinks > 0 && <p style={{ margin: '4px 0 0' }}>
            {plural(result.nb_symlinks, 'file is a symbolic link', 'files are symbolic links')}: the runs' files are on another filesystem, where hard links can't go. Windows often can't open symbolic links: if they don't open, export copies.
          </p>}
          {result.export_id && <p style={{ margin: '4px 0 0' }} className={Classes.TEXT_MUTED}>Find your exports, their size, and delete them in <Link to="/storage/exports">Storage usage → Exports</Link>.</p>}
          {result.nb_skipped > 0 && <ProblemList more={result.nb_skipped - result.skipped.length} items={result.skipped.map(s => <code key={s}>{s}</code>)}/>}
          <ExportProblems result={result} support_url={support_url}/>
          {other_errors.length > 0 && <ProblemList items={other_errors.map(e => <code key={e}>{e}</code>)}/>}
          {support_url && <p style={{ margin: '8px 0 0' }}>This export is new. Something missing, confusing, or better before? <a href={feedback_url} target="_blank" rel="noopener noreferrer">Tell us</a>: it shapes what comes next.</p>}
        </Callout>}
  </section>;

  const layouts = LAYOUTS.filter(l => !l.needs_reference || both || layout === l.key);
  const export_text = finding.length > 0
    ? `Finding regions… ${finding.reduce((n, s) => n + s.searched, 0)}/${finding.reduce((n, s) => n + s.total, 0)}`
    : p && is_current ? `Export ${plural(p.nb_files, 'file')}` : 'Export';

  return <Dialog isOpen={isOpen} onClose={onClose} title="Export files" icon="export" style={{ width: 'min(1180px, calc(100vw - 32px))' }}
    onOpened={() => path_input.current?.focus()}>
    <DialogBody>
      <Columns>
        <div>
          <Presets project={project} settings={{ ...settings, files: path }} onLoad={preset => setSettings({ ...default_naming, ...preset })}
            fit_context={{ new_batch, ref_batch, labels: { new: label_new, reference: label_ref } }}/>

          <Step aria-label="Files">
            <h4 className={Classes.HEADING}><label htmlFor={path_id}>Which files</label></h4>
            <InputGroup id={path_id} inputRef={path_input} value={path} placeholder="*.png" intent={problem ? 'warning' : undefined}
              aria-label="Files" style={{ fontFamily: 'monospace' }}
              onChange={e => update({ files: e.target.value })}
              onKeyDown={e => { if (e.key === 'Enter' && can_export && !is_exporting) doExport(); }}/>
            <div className={Classes.FORM_HELPER_TEXT} style={{ marginTop: 4 }}>
              {problem
                ? <span style={{ color: 'var(--bp-intent-warning-text, #935610)' }}>{problem}</span>
                : <>In each run's folder, e.g. <code>*.png</code>, <code>**/*.jpg</code> (<code>**/</code>: in any folder).{!has_reference && <> From {plural(plan.counts.new, 'run')}.</>}</>}
            </div>
            {quick_files.length > 0 && <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 6, alignItems: 'center' }}>
              <span className={Classes.TEXT_MUTED} style={{ fontSize: 12 }}>Visualizations:</span>
              {quick_files.map(v => <Tag key={v.path} minimal interactive round title={`${v.label}: ${v.path}`} onClick={() => update({ files: v.path })}>{short_label(v.label)}</Tag>)}
            </div>}
            {has_reference && <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '4px 10px', marginTop: 10 }}>
              <span>From</span>
              <SegmentedControl aria-label="What to export" small value={sides_choice} onValueChange={setSides} options={[
                { value: 'both', label: `${plural(plan.counts.new, 'run')} + ${plural(plan.counts.reference, 'reference run')}` },
                { value: 'new', label: `Only ${labels?.new || 'new'}` },
                { value: 'reference', label: `Only ${labels?.reference || 'the reference'}` },
              ]}/>
              {both && plan.counts.without_reference > 0 && <span className={Classes.TEXT_MUTED} style={{ fontSize: 12 }}>{plural(plan.counts.without_reference, 'run has', 'runs have')} no reference</span>}
            </div>}
            {has_reference && nb_references > 1 && sides_choice !== 'new' && <div className={Classes.FORM_HELPER_TEXT} style={{ marginTop: 4 }}>
              The page compares with {nb_references} references: the export takes the one shown, <strong>{labels?.reference || 'the reference'}</strong>. Show another on the page to export it.
            </div>}
          </Step>

          <Step aria-label="Names">
            <h4 className={Classes.HEADING}>Names</h4>
            {example && !example.error && <NameAnatomy parts={example} side={example_side} sides={sides}/>}
            {parts_list}
            <div style={{ marginTop: 10 }}>
              <SegmentedControl aria-label="Layout" small options={[...layouts.map(l => ({ label: l.label, value: l.key })), ...(layout === 'custom' ? [{ label: 'Custom', value: 'custom' }] : [])]}
                value={layout} onValueChange={setLayout}/>
              <div className={Classes.FORM_HELPER_TEXT} style={{ marginTop: 4 }}>{!layout_info ? 'Your own template, in More options.' : layout === 'flat' && !both ? 'All the files in one folder.' : layout_info.description}</div>
            </div>
          </Step>

          {images && <CropsStep crops={crops} picked={crop_sources} enabled={crops_enabled} whole={whole_files} shown={shown_sets} max_found={max_found}
            onChange={changes => { if (changes.crop_sources) setSourcesPicked(true); update(changes); }}/>}

          <Step aria-label="Where">
            {folder_mode === 'new'
              ? <FormGroup label={<strong>Name of the export</strong>} labelInfo="(optional)" labelFor={`${template_id}-name`} helperText="In the new folder's name, after the date: find it later in Storage usage → Exports." style={{ marginBottom: 0 }}>
                  <InputGroup id={`${template_id}-name`} value={folder_name} placeholder="e.g. night-scenes-for-review" onChange={e => setFolderName(e.target.value)}/>
                </FormGroup>
              : <p style={{ margin: 0 }}>Into <code>{folder_path || '…'}</code>, the folder you chose in More options.</p>}
          </Step>

          <Button variant="minimal" size="small" icon={more ? 'chevron-down' : 'chevron-right'} onClick={() => setMore(!more)} aria-expanded={more}>
            More options{changed > 0 && <Tag minimal round style={{ marginLeft: 6 }}>{changed} changed</Tag>}
          </Button>
          <Collapse isOpen={more} keepChildrenMounted>
            <div style={{ padding: '10px 0 0 22px' }}>{more_options}</div>
          </Collapse>
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
      <Button intent="primary" icon="export" loading={is_exporting} disabled={!can_export} text={export_text} onClick={doExport}/>
    </>}>
      <span className={Classes.TEXT_SMALL}>
        <span className={Classes.TEXT_MUTED}>Running your own code on these files? You may not need an export:</span>{' '}
        <Button size="small" variant="minimal" icon="code" text="Copy a Python snippet" onClick={() => copyWithToast(snippet, { what: 'the snippet' })}/>
        <a target="_blank" rel="noopener noreferrer" href={`${docs_root}docs/user-guide/sharing#exporting-files`}>How exports work</a>
      </span>
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
