// What an export sends to the server: the runs shown, the reference runs they're compared to, and the fields of
// their names (src/export/names.js): what the new and reference results are called on the page, and the settings
// that tell runs on the same input apart. The server lists their files and names them (backend/api/export_to_folder.py).
// Pure functions, tested in __tests__/plan.test.js.
import { output_tokens, format_value } from '../configurations/tokens';
import { input_fields, file_name } from './names';

// How files are named. Each sets a template and how slashes in inputs' and files' paths become names.
export const LAYOUTS = [
  {
    key: 'flat', label: 'One folder', template: '{input}__{settings}__{file}__{side}', separator: '_',
    description: 'All files in one folder: a run\'s new and reference files sort next to each other.',
  },
  {
    key: 'by-side', label: 'A folder per side', template: '{side}/{input}__{settings}__{file}', separator: '_',
    description: 'The same names in each side\'s folder: compare the folders with a diff tool.',
  },
  {
    key: 'like-inputs', label: 'Folders like the inputs', template: '{input}/{settings}__{file}__{side}', separator: '/',
    description: 'Folders like the inputs\' and the runs\' files.',
  },
];

export const SEPARATORS = [
  { value: '/', label: 'Keep folders' },
  { value: '_', label: 'Join with _' },
  { value: '__', label: 'Join with __' },
  { value: '-', label: 'Join with -' },
  { value: '.', label: 'Join with .' },
];

// How {settings} tells runs on the same input apart
export const SETTINGS_FORMATS = [
  { value: 'changes', label: 'What differs', example: 'gain=4,night', description: 'The settings that differ between runs: configurations and tuning parameters.' },
  { value: 'id', label: 'Short id', example: '3f9a2c', description: 'A short id of the run\'s settings, the same in all exports. The mapping file says what it is.' },
  { value: 'number', label: 'Number', example: 's1, s2…', description: 'Numbers in this export. The mapping file says what they are.' },
];
export const SETTINGS_WHEN = [
  { value: 'needed', label: 'When runs share an input' },
  { value: 'always', label: 'Always, if runs differ' },
  { value: 'never', label: 'Never' },
];

export const default_naming = {
  layout: 'flat',
  template: LAYOUTS[0].template,
  separator: LAYOUTS[0].separator,
  settings: 'changes',
  settings_when: 'needed',
  // reference files are named like the new runs they're compared to: they pair up, in one folder or a folder per side
  pair_references: true,
};

export const layout_of = (template, separator) =>
  LAYOUTS.find(l => l.template === template && l.separator === separator)?.key ?? 'custom';


// A short, stable id: FNV-1a
const short_hash = text => {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0').slice(0, 6);
};

// "conf/night.yaml" => "night"
const short_string = text => text.replace(/[\\/]+$/, '').split(/[\\/]/).pop().replace(/\.(ya?ml|json|toml|cfg|ini|txt)$/i, '') || text;
const value_text = token => typeof token.value === 'string' ? token.value : format_value(token.value).replace(/\s+/g, '');

const group_by_input = outputs => {
  const groups = new Map();
  for (const o of outputs) {
    const key = o.test_input_path ?? '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(o);
  }
  return [...groups.values()];
};

// What tells runs apart: settings (strings by their text, parameters by their key), and "platform".
// `when`: "needed" looks at runs on the same input, "always" at all runs.
export const distinguishing_settings = (outputs, when = 'needed') => {
  const varying = new Set();
  if (when === 'never') return varying;
  const groups = when === 'always' ? [outputs] : group_by_input(outputs);
  for (const group of groups) {
    if (group.length < 2) continue;
    const lists = group.map(output_tokens);
    const counts = new Map();
    for (const tokens of lists)
      for (const full of new Set(tokens.map(t => t.full))) counts.set(full, (counts.get(full) ?? 0) + 1);
    for (const tokens of lists)
      for (const t of tokens)
        if (counts.get(t.full) < group.length) varying.add(t.kind === 'param' ? t.id : t.full);
    if (new Set(group.map(o => o.platform)).size > 1) varying.add('platform');
  }
  return varying;
};

// "gain=4,night": a run's settings that differ from other runs'
const changes_text = (output, varying, short_keys, short_strings) => {
  const parts = [];
  if (varying.has('platform') && output.platform) parts.push(output.platform);
  for (const t of output_tokens(output)) {
    if (t.kind === 'string' && varying.has(t.full)) parts.push(short_strings.get(t.text) ?? t.text);
    else if (t.kind === 'param' && varying.has(t.id)) parts.push(`${short_keys.get(t.key) ?? t.key}=${value_text(t)}`);
  }
  return [...new Set(parts)].join(',');
};

// Short names if they're unique: "isp.awb.mode" => "mode", "conf/night.yaml" => "night"
const shorten = (values, short) => {
  const by_short = new Map();
  for (const v of values) {
    const s = short(v);
    if (!by_short.has(s)) by_short.set(s, new Set());
    by_short.get(s).add(v);
  }
  return new Map([...values].map(v => [v, by_short.get(short(v)).size === 1 ? short(v) : v]));
};

// Each run's {settings}: Map(id => text)
export const settings_labels = (outputs, { settings = 'changes', settings_when = 'needed' } = {}) => {
  const varying = distinguishing_settings(outputs, settings_when);
  const labels = new Map();
  if (varying.size === 0) {
    for (const o of outputs) labels.set(o.id, '');
    return labels;
  }
  const keys = new Set(), strings = new Set();
  for (const o of outputs)
    for (const t of output_tokens(o)) {
      if (t.kind === 'param' && varying.has(t.id)) keys.add(t.key);
      if (t.kind === 'string' && varying.has(t.full)) strings.add(t.text);
    }
  const short_keys = shorten(keys, key => key.split('.').pop());
  const short_strings = shorten(strings, short_string);
  const changes = new Map(outputs.map(o => [o.id, changes_text(o, varying, short_keys, short_strings)]));
  if (settings === 'changes') return changes;
  if (settings === 'id') {
    for (const o of outputs)
      labels.set(o.id, short_hash(JSON.stringify([o.platform, o.configurations ?? null, o.extra_parameters ?? {}])));
    return labels;
  }
  // numbers, in the order of what differs
  const numbers = new Map([...new Set(changes.values())].sort().map((text, index) => [text, `s${index + 1}`]));
  for (const o of outputs) labels.set(o.id, numbers.get(changes.get(o.id)));
  return labels;
};


// The runs to export, and the fields of their names: [{id, side: "new" | "reference", fields}].
// `labels`: what the page calls the new and reference results (their milestones' names, "new", "ref"...).
export const export_runs = ({ new_batch, ref_batch, labels = {}, naming = default_naming }) => {
  const outputs = (new_batch?.filtered?.outputs ?? []).map(id => new_batch.outputs[id]).filter(Boolean);
  const reference_of = o => {
    // comparing a batch with itself: no reference
    if (!o.reference_id || o.reference_id === o.id) return null;
    return ref_batch?.outputs?.[o.reference_id] ?? null;
  };
  const references = outputs.map(reference_of);
  const has_reference = references.some(Boolean);
  // without a reference, names don't need to say "new"
  const label_new = has_reference ? (labels.new || 'new') : '';
  const label_ref = labels.reference || 'reference';
  const settings = settings_labels(outputs, naming);
  const items = outputs.map(o => ({
    id: o.id, side: 'new', output: o,
    fields: { side: label_new, settings: settings.get(o.id) ?? '', ...input_fields(o.test_input_path) },
  }));
  const unique_references = [...new Map(references.filter(Boolean).map(r => [r.id, r])).values()];
  if (naming.pair_references) {
    outputs.forEach((o, index) => {
      const r = references[index];
      if (r) items.push({
        id: r.id, side: 'reference', output: r, paired_with: o.id,
        fields: { side: label_ref, settings: settings.get(o.id) ?? '', ...input_fields(o.test_input_path) },
      });
    });
  } else {
    const ref_settings = settings_labels(unique_references, naming);
    for (const r of unique_references) items.push({
      id: r.id, side: 'reference', output: r,
      fields: { side: label_ref, settings: ref_settings.get(r.id) ?? '', ...input_fields(r.test_input_path) },
    });
  }
  return {
    items,
    labels: { new: label_new, reference: has_reference ? label_ref : '' },
    counts: { new: outputs.length, reference: unique_references.length, without_reference: references.filter(r => !r).length },
  };
};

// What the server needs: no outputs
export const request_runs = items => items.map(({ id, side, fields }) => ({ id, side, fields }));

// An example name, before the server lists the files: with the pattern as the file, e.g. "out.png" or "*.png"
export const example_name = (item, { template, separator }, files, commit_id, batch_label) => {
  if (!item) return null;
  const file = (files || 'file').replace(/\*\*\//g, '').replace(/\*/g, 'file') || 'file';
  const fields = {
    platform: item.output?.platform ?? '', commit: (commit_id ?? '').slice(0, 8), batch: batch_label ?? '', run: String(item.id),
    ...item.fields,
  };
  return file_name(template, fields, file, separator);
};
