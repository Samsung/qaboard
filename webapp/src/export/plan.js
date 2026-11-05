// What an export sends to the server: the runs shown, the reference runs they're compared to, and the fields of
// their names (src/export/names.js): what the new and reference results are called on the page, and the settings
// that tell runs apart. The server lists their files and names them (backend/api/export_files.py).
// Pure functions, tested in __tests__/plan.test.js.
//
// {settings}: the dialog lists what differs between the runs shown (settings_candidates): parameters, configurations
// and platforms. Users pick what goes in names; by default, what differs between runs on the same input, since
// their files would otherwise get the same names. Each run then says the value of each picked parameter, `default`
// if it doesn't set it: "gain=4,iso=default".
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

// How {settings} says the settings picked
export const SETTINGS_FORMATS = [
  { value: 'values', label: 'Their values', description: 'Each setting picked, and its value.' },
  { value: 'id', label: 'A short id', description: 'A short id of the values: the same in every export. 0.export.csv says what it stands for. Use it when names get too long.' },
  { value: 'number', label: 'A number', description: 's1, s2… in this export. 0.export.csv says what they stand for.' },
];
// between a parameter and its value: gain=4, gain-4, gain_4, or only 4
export const SETTINGS_ASSIGN = [
  { value: '=', label: 'gain=4' },
  { value: '-', label: 'gain-4' },
  { value: '_', label: 'gain_4' },
  { value: '', label: '4 (values only)' },
];
// between settings
export const SETTINGS_JOIN = [
  { value: ',', label: 'a,b' },
  { value: '_', label: 'a_b' },
  { value: '+', label: 'a+b' },
  { value: '-', label: 'a-b' },
];
// what a run that doesn't set a parameter says
export const ABSENT = 'default';

export const default_naming = {
  layout: 'flat',
  template: LAYOUTS[0].template,
  separator: LAYOUTS[0].separator,
  // the settings in names, by name (parameters' keys, "configurations", "platform"). null: what differs between runs
  // on the same input
  settings_keys: null,
  settings_format: 'values',
  settings_assign: '=',
  settings_join: ',',
  // reference files are named like the new runs they're compared to: they pair up, in one folder or a folder per side
  pair_references: true,
  // names and paths Windows can open (see names.js), the server checks paths' lengths
  windows: true,
};

export const layout_of = (template, separator) =>
  LAYOUTS.find(l => l.template === template && l.separator === separator)?.key ?? 'custom';


// A short, stable id: FNV-1a
export const short_hash = text => {
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

export const CONFIGURATIONS = 'configurations';
export const PLATFORM = 'platform';

// What differs between runs, that names can say: [{key, kind: "configurations" | "parameter" | "platform", needed, values}]
// - configurations: the strings of their configurations (e.g. "conf/night.yaml") that not all runs have,
// - parameters: from their configurations' objects and tuning parameters, by key ("isp.gain"), with different
//   values or that not all runs set,
// - platform.
// `needed`: runs on the same input differ by it. `values`: how many different values it has.
export const settings_candidates = outputs => {
  outputs = outputs.filter(Boolean);
  if (outputs.length < 2) return [];
  const lists = outputs.map(output_tokens);
  const string_counts = new Map();
  const params = new Map();
  lists.forEach((tokens, index) => {
    for (const full of new Set(tokens.filter(t => t.kind === 'string').map(t => t.full)))
      string_counts.set(full, (string_counts.get(full) ?? 0) + 1);
    for (const t of tokens) {
      if (t.kind !== 'param') continue;
      if (!params.has(t.key)) params.set(t.key, new Map());
      params.get(t.key).set(index, value_text(t));
    }
  });
  const varying_strings = new Set([...string_counts].filter(([, n]) => n < outputs.length).map(([full]) => full));
  // what tells each run apart, by candidate
  const value_of = new Map();
  if (varying_strings.size > 0)
    value_of.set(CONFIGURATIONS, index => lists[index].filter(t => t.kind === 'string' && varying_strings.has(t.full)).map(t => t.text).join('\u0000'));
  for (const [key, values] of params) {
    const texts = new Set(values.values());
    if (texts.size > 1 || values.size < outputs.length) value_of.set(key, index => values.get(index) ?? null);
  }
  if (new Set(outputs.map(o => o.platform)).size > 1) value_of.set(PLATFORM, index => outputs[index].platform);

  const groups = new Map();
  outputs.forEach((o, index) => {
    const key = o.test_input_path ?? '';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(index);
  });
  return [...value_of].map(([key, value]) => ({
    key,
    kind: key === CONFIGURATIONS ? 'configurations' : key === PLATFORM ? 'platform' : 'parameter',
    needed: [...groups.values()].some(indices => indices.length > 1 && new Set(indices.map(value)).size > 1),
    values: new Set(outputs.map((_, index) => value(index))).size,
  }));
};

// The settings names say: what users picked, else what's needed
export const picked_settings = (candidates, settings_keys) => {
  if (settings_keys) return candidates.filter(c => settings_keys.includes(c.key));
  return candidates.filter(c => c.needed);
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

// Each run's {settings}: Map(id => text). The settings are those of `keys` (see settings_candidates), else what's needed.
export const settings_labels = (outputs, naming = default_naming, keys = null) => {
  const { settings_format = 'values', settings_assign = '=', settings_join = ',' } = naming;
  const picked = keys ?? picked_settings(settings_candidates(outputs), naming.settings_keys).map(c => c.key);
  const labels = new Map(outputs.map(o => [o.id, '']));
  if (picked.length === 0 || outputs.length === 0) return labels;
  const lists = new Map(outputs.map(o => [o.id, output_tokens(o)]));
  // configurations' strings that not all runs have
  const counts = new Map();
  for (const tokens of lists.values())
    for (const text of new Set(tokens.filter(t => t.kind === 'string').map(t => t.text))) counts.set(text, (counts.get(text) ?? 0) + 1);
  const varying = new Set([...counts].filter(([, n]) => n < outputs.length).map(([text]) => text));
  const short_strings = shorten(varying, short_string);
  const params = picked.filter(k => k !== CONFIGURATIONS && k !== PLATFORM);
  const short_keys = shorten(new Set(params), key => key.split('.').pop());

  // the same picked settings, always in the same order: "configurations, parameters..., platform"
  const parts = o => {
    const tokens = lists.get(o.id);
    const out = [];
    for (const key of picked) {
      if (key === CONFIGURATIONS) {
        const strings = tokens.filter(t => t.kind === 'string' && varying.has(t.text)).map(t => short_strings.get(t.text));
        out.push([CONFIGURATIONS, strings.length ? strings.join('+') : ABSENT]);
      } else if (key === PLATFORM) {
        out.push([PLATFORM, o.platform || ABSENT]);
      } else {
        const token = tokens.find(t => t.kind === 'param' && t.key === key);
        out.push([short_keys.get(key), token ? value_text(token) : ABSENT]);
      }
    }
    return out;
  };
  const texts = new Map(outputs.map(o => [o.id, parts(o).map(([key, value]) =>
    key === CONFIGURATIONS || key === PLATFORM || settings_assign === '' ? value : `${key}${settings_assign}${value}`
  ).join(settings_join)]));
  if (settings_format === 'values') return texts;
  if (settings_format === 'id') {
    // the same id for the same values, whatever their separators
    for (const o of outputs) labels.set(o.id, short_hash(JSON.stringify(parts(o))));
    return labels;
  }
  // numbers, in the order of the values
  const numbers = new Map([...new Set(texts.values())].sort().map((text, index) => [text, `s${index + 1}`]));
  for (const o of outputs) labels.set(o.id, numbers.get(texts.get(o.id)));
  return labels;
};


// The runs to export, and the fields of their names: [{id, side: "new" | "reference", fields}].
// `labels`: what the page calls the new and reference results (their milestones' names, "new", "ref"...).
// Also what differs between the new runs (`candidates`), and the settings names say (`picked`).
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
  const candidates = settings_candidates(outputs);
  const picked = picked_settings(candidates, naming.settings_keys).map(c => c.key);
  const settings = settings_labels(outputs, naming, picked);
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
    // the reference runs say the same settings, with their own values
    const ref_settings = settings_labels(unique_references, naming, picked);
    for (const r of unique_references) items.push({
      id: r.id, side: 'reference', output: r,
      fields: { side: label_ref, settings: ref_settings.get(r.id) ?? '', ...input_fields(r.test_input_path) },
    });
  }
  return {
    items,
    candidates,
    picked,
    labels: { new: label_new, reference: has_reference ? label_ref : '' },
    counts: { new: outputs.length, reference: unique_references.length, without_reference: references.filter(r => !r).length },
  };
};

// What the server needs: no outputs
export const request_runs = items => items.map(({ id, side, fields }) => ({ id, side, fields }));

// An example name, before the server lists the files: with the pattern as the file, e.g. "out.png" or "*.png"
export const example_name = (item, { template, separator, windows = true }, files, commit_id, batch_label) => {
  if (!item) return null;
  const file = (files || 'file').replace(/\*\*\//g, '').replace(/\*/g, 'file') || 'file';
  const fields = {
    platform: item.output?.platform ?? '', commit: (commit_id ?? '').slice(0, 8), batch: batch_label ?? '', run: String(item.id),
    ...item.fields,
  };
  return file_name(template, fields, file, separator, windows);
};


// Saved export settings (user preferences, synced to their account): the last export's, per project, and presets
// users name, for all projects or one. What's saved: how files are named, the files, links or copies, and a folder
// users chose (e.g. what their scripts read).
export const SAVED_KEYS = [...Object.keys(default_naming), 'files', 'type', 'folder_mode', 'folder_path'];
export const saved_settings = settings => Object.fromEntries(SAVED_KEYS.filter(k => settings[k] !== undefined).map(k => [k, settings[k]]));
// the presets that apply to a project, theirs first
export const presets_for = (presets, project) => (presets ?? [])
  .filter(p => !p.project || p.project === project)
  .sort((a, b) => (!!b.project - !!a.project) || a.name.localeCompare(b.name));
