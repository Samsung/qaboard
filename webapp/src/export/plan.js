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
import { input_fields, file_name, parse_template } from './names';
import { databaseLabels } from '../components/runNames';

// How files are named. Each sets a template and how slashes in inputs' and files' paths become names.
// Empty fields take their separator along: without a reference, settings that differ, crops or several files per run,
// names are only the input, e.g. "scenes_a.png". `previous`: the template before {region}, saved in settings.
export const LAYOUTS = [
  {
    key: 'flat', label: 'One folder', template: '{input}__{settings}__{file}__{region}__{side}', separator: '_',
    previous: '{input}__{settings}__{file}__{side}',
    description: 'All the files in one folder: new and reference files sort next to each other.',
  },
  {
    key: 'by-side', label: 'A folder for new, one for reference', short: 'Folder per side', template: '{side}/{input}__{settings}__{file}__{region}', separator: '_',
    previous: '{side}/{input}__{settings}__{file}',
    description: 'The same names in both folders: compare them side by side, or with a diff tool.',
    needs_reference: true,
  },
  {
    key: 'like-inputs', label: 'Folders like the inputs', short: 'Like the inputs', template: '{input}/{settings}__{file}__{region}__{side}', separator: '/',
    previous: '{input}/{settings}__{file}__{side}',
    description: 'A folder per input, like where the inputs are.',
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
  // "auto": names say the file only when runs have several files matching the pattern (the server knows), or true
  file_in_names: 'auto',
  // "needed": a run's name says a setting only if another run on the same input has another value, and a parameter only
  // if the run sets it. "all": every name says every setting picked, `default` for runs that don't set it (for scripts
  // that expect the same fields in every name).
  settings_where: 'needed',
};

// What's between names and their new or reference label, e.g. "@" in "{file}@{side}": null if {side} doesn't follow
// a separator (it's a folder, or starts the name)
export const SIDE_SEPARATORS = ['__', '_', '-', '@', '.', '+'];
const before_side = /\}([^{}/]+)\{side\}/;
export const side_separator = template => before_side.exec(template ?? '')?.[1] ?? null;
export const with_side_separator = (template, separator) => side_separator(template) === null ? template
  : template.replace(before_side, () => `}${separator}{side}`);

// The layout of a template, whatever its separator before new or reference
export const layout_of = (template, separator) => {
  const normal = with_side_separator(template, '__');
  return LAYOUTS.find(l => (l.template === normal || l.previous === normal) && l.separator === separator)?.key ?? 'custom';
};


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
// the batch of qaboard.yaml the run comes from, and its input's database: when runs come from several
export const BATCH = 'batch';
export const DATABASE = 'database';
const VALUE_ONLY = [CONFIGURATIONS, PLATFORM, BATCH, DATABASE];
const batch_of = o => o.data?.batch || null;
const database_of = o => o.test_input_database && o.test_input_database !== '/' ? o.test_input_database : null;

// What differs between runs, that names can say: [{key, kind: "batch" | "database" | "configurations" | "parameter" | "platform", needed, values}]
// - batch and database: when runs come from several batches of qaboard.yaml, or databases,
// - configurations: the strings of their configurations (e.g. "conf/night.yaml") that not all runs have,
// - parameters: from their configurations' objects and tuning parameters, by key ("isp.gain"), with different
//   values or that not all runs set,
// - platform.
// `needed`: names need it to tell runs on the same input apart (the fewest such settings). `on_input`: runs on the same
// input differ by it. `values`: how many different values it has.
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
  if (new Set(outputs.map(batch_of)).size > 1) value_of.set(BATCH, index => batch_of(outputs[index]));
  if (new Set(outputs.map(database_of)).size > 1) value_of.set(DATABASE, index => database_of(outputs[index]));
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
  // the pairs of runs on the same input, and the settings that tell each pair apart
  const pairs = [];
  for (const indices of groups.values())
    for (let a = 0; a < indices.length; a++)
      for (let b = a + 1; b < indices.length; b++) pairs.push([indices[a], indices[b]]);
  const splits = new Map([...value_of].map(([key, value]) => [key, new Set(pairs.map((pair, i) => value(pair[0]) !== value(pair[1]) ? i : -1).filter(i => i >= 0))]));
  // needed: the fewest settings that tell all those runs apart, e.g. only the batch when runs of several batches also
  // differ by their configurations and platform. Each time, the one that tells most pairs apart, in the listed order.
  const needed = new Set();
  const left = new Set(pairs.keys());
  while (left.size > 0) {
    let best = null, best_count = 0;
    for (const [key, split] of splits) {
      if (needed.has(key)) continue;
      const count = [...split].filter(i => left.has(i)).length;
      if (count > best_count) { best = key; best_count = count; }
    }
    if (!best) break;
    needed.add(best);
    for (const i of splits.get(best)) left.delete(i);
  }
  return [...value_of].map(([key, value]) => ({
    key,
    kind: VALUE_ONLY.includes(key) ? key : 'parameter',
    needed: needed.has(key),
    // it differs between runs on the same input, even if other settings tell them apart already
    on_input: splits.get(key).size > 0,
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
  const params = picked.filter(k => !VALUE_ONLY.includes(k));
  const databases = databaseLabels(outputs.map(database_of));
  const short_keys = shorten(new Set(params), key => key.split('.').pop());

  // the same picked settings, always in the same order: "batch, database, configurations, parameters..., platform"
  const parts = o => {
    const tokens = lists.get(o.id);
    const out = [];
    for (const key of picked) {
      if (key === BATCH) {
        out.push([BATCH, batch_of(o) ?? ABSENT]);
      } else if (key === DATABASE) {
        const database = database_of(o);
        out.push([DATABASE, database ? databases.get(database) : ABSENT]);
      } else if (key === CONFIGURATIONS) {
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
  // Only where needed: a run says a setting if another run on the same input has another value: their files can't
  // be told apart without it. Parameters written `key=value` are left out of the names of the runs that don't set
  // them: "street" and "street__crop=center", not "street__crop=default".
  let needed = parts;
  if (naming.settings_where !== 'all') {
    const groups = new Map();
    for (const o of outputs) {
      const key = o.test_input_path ?? '';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(parts(o));
    }
    const named = settings_assign !== '';
    const differs = (group, index) => new Set(group.map(other => other[index][1])).size > 1;
    // a setting users picked that never differs on an input, only between inputs: every run says it
    const between_inputs = picked.map((_, index) => ![...groups.values()].some(group => differs(group, index)));
    needed = o => {
      const group = groups.get(o.test_input_path ?? '');
      return parts(o).filter(([key, value], index) =>
        (between_inputs[index] || differs(group, index)) && !(value === ABSENT && named && !VALUE_ONLY.includes(key)));
    };
  }
  const texts = new Map(outputs.map(o => [o.id, needed(o).map(([key, value]) =>
    VALUE_ONLY.includes(key) || settings_assign === '' ? value : `${key}${settings_assign}${value}`
  ).join(settings_join)]));
  if (settings_format === 'values') return texts;
  if (settings_format === 'id') {
    // the same id for the same values, whatever their separators
    for (const o of outputs) labels.set(o.id, texts.get(o.id) ? short_hash(JSON.stringify(needed(o))) : '');
    return labels;
  }
  // numbers, in the order of the values
  const numbers = new Map([...new Set(texts.values())].filter(Boolean).sort().map((text, index) => [text, `s${index + 1}`]));
  for (const o of outputs) labels.set(o.id, numbers.get(texts.get(o.id)) ?? '');
  return labels;
};


// The runs to export, and the fields of their names: [{id, side: "new" | "reference", fields}].
// `labels`: what the page calls the new and reference results (their milestones' names, "new", "ref"...).
// `sides`: "both" (the runs shown and the reference runs they're compared to), or only "new" or "reference". One side
// alone is named like a page without a reference: names don't say new or reference, unless `labels.alone` says
// what to call them (e.g. the batch's name, "tuning-gain"), and the reference runs say their own settings.
// Also what differs between the runs exported (`candidates`), and the settings names say (`picked`).
// `regions`: Map(new run's id => [regions to crop]), see crop_regions: a reference run gets the regions of the new run
// it's compared to (of the first one when it's exported once).
export const export_runs = ({ new_batch, ref_batch, labels = {}, naming = default_naming, regions = null, sides = 'both' }) => {
  const new_outputs = (new_batch?.filtered?.outputs ?? []).map(id => new_batch.outputs[id]).filter(Boolean);
  const reference_of = o => {
    // comparing a batch with itself: no reference
    if (!o.reference_id || o.reference_id === o.id) return null;
    return ref_batch?.outputs?.[o.reference_id] ?? null;
  };
  const new_references = new_outputs.map(reference_of);
  const unique_references = [...new Map(new_references.filter(Boolean).map(r => [r.id, r])).values()];
  // the first new run each reference run is compared to
  const first_new = new Map();
  new_outputs.forEach((o, index) => { if (new_references[index] && !first_new.has(new_references[index].id)) first_new.set(new_references[index].id, o.id); });
  const has_reference = unique_references.length > 0;
  const only_reference = sides === 'reference' && has_reference;
  const both = sides === 'both' && has_reference;

  // the runs named after themselves, and their side
  const outputs = only_reference ? unique_references : new_outputs;
  const side = only_reference ? 'reference' : 'new';
  const references = both ? new_references : outputs.map(() => null);
  // one side alone: names don't need to say which, unless users name it
  const label_alone = String(labels.alone ?? '').trim();
  const label_new = both ? (labels.new || 'new') : label_alone;
  const label_ref = labels.reference || 'reference';
  const candidates = settings_candidates(outputs);
  const picked = picked_settings(candidates, naming.settings_keys).map(c => c.key);
  const settings = settings_labels(outputs, naming, picked);
  const items = outputs.map(o => ({
    id: o.id, side, output: o,
    fields: { side: only_reference ? label_alone : label_new, settings: settings.get(o.id) ?? '', ...input_fields(o.test_input_path) },
  }));
  if (both && naming.pair_references) {
    outputs.forEach((o, index) => {
      const r = references[index];
      if (r) items.push({
        id: r.id, side: 'reference', output: r, paired_with: o.id,
        fields: { side: label_ref, settings: settings.get(o.id) ?? '', ...input_fields(o.test_input_path) },
      });
    });
  } else if (both) {
    // the reference runs say the same settings, with their own values
    const ref_settings = settings_labels(unique_references, naming, picked);
    for (const r of unique_references) items.push({
      id: r.id, side: 'reference', output: r,
      fields: { side: label_ref, settings: ref_settings.get(r.id) ?? '', ...input_fields(r.test_input_path) },
    });
  }
  if (regions) {
    for (const item of items) {
      const of = item.side === 'new' ? item.id : (item.paired_with ?? first_new.get(item.id));
      const list = regions.get(of);
      if (list?.length) item.regions = list;
    }
  }
  return {
    items,
    candidates,
    picked,
    // the page compares with a reference, and the export has both sides
    has_reference,
    both,
    side,
    labels: only_reference ? { new: '', reference: label_alone } : { new: label_new, reference: both ? label_ref : '' },
    counts: { new: new_outputs.length, reference: unique_references.length, without_reference: new_references.filter(r => !r).length },
  };
};

// What the server needs: no outputs
export const request_runs = items => items.map(({ id, side, fields, regions }) => ({ id, side, fields, ...(regions ? { regions } : {}) }));

// A run's fields, as the server fills them (backend/api/export_files.py default_fields): for names on the page
export const item_fields = (item, { commit_id, batch_label } = {}) => ({
  platform: item?.output?.platform ?? '', commit: (commit_id ?? '').slice(0, 8), batch: batch_label ?? '', run: String(item?.id ?? ''),
  ...item?.fields,
});

// The file in example names, before the server lists the files: the pattern, e.g. "out.png", "*.png" => "file.png"
export const example_file = files => (files || 'file').replace(/\*\*\//g, '').replace(/\*/g, 'file') || 'file';
// Whether names would say the file, before the server knows how many files runs have: a pattern without wildcards
// matches one file per run
export const guess_file_in_names = (naming, files) => naming.file_in_names !== 'auto' || /[*?[]/.test(files ?? '');

// The server adds {region} at the end of templates without it, for crops
export const crop_template = template => template.includes('{region}') ? template : `${template}__{region}`;

// An example name, before the server lists the files: with the pattern as the file, e.g. "out.png" or "*.png"
export const example_name = (item, { template, separator, windows = true }, files, commit_id, batch_label, with_file = true, region = '') => {
  if (!item) return null;
  return file_name(region ? crop_template(template) : template, { ...item_fields(item, { commit_id, batch_label }), region }, example_file(files), separator, windows, with_file);
};


// Crops of regions of interest, for images. The regions come from the image viewer's providers (presets, where the
// images differ, annotations...), and quarters. Each crop is named after its region: its label when it has a short one,
// else the source and its rank, e.g. "diff-01" (the largest difference first), "roi-02".
export const QUARTERS = [
  { name: 'top-left', x: 0, y: 0, w: 0.5, h: 0.5 },
  { name: 'top-right', x: 0.5, y: 0, w: 0.5, h: 0.5 },
  { name: 'bottom-left', x: 0, y: 0.5, w: 0.5, h: 0.5 },
  { name: 'bottom-right', x: 0.5, y: 0.5, w: 0.5, h: 0.5 },
].map(q => ({ ...q, unit: 'fraction', source: 'quarters' }));

// what regions without a usable label are called, by source
export const region_prefix = source => source === 'presets' ? 'roi'
  : source?.startsWith('auto-') ? 'diff'
  : source?.startsWith('annotations-') ? 'annotation'
  : String(source ?? 'region').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').toLowerCase() || 'region';
const slug = text => String(text ?? '').trim().replace(/[\s/\\]+/g, '-').replace(/[^\p{L}\p{N}._=+-]+/gu, '').replace(/^[-.]+|[-.]+$/g, '');
// labels that make good names: short, e.g. "face" or "chart_3". Labels of differences say how much they differ: no.
const usable_label = (label, source) => {
  if (!label || source?.startsWith('auto-')) return null;
  const s = slug(label);
  return s && s.length <= 32 ? s : null;
};

// The regions of a run to crop, named, unique: [{name, x, y, w, h, unit?, image_width?, image_height?, file?, label?, source}]
// by_source: [[source id, regions (as the viewer's providers give them), file (null: any)]]
export const crop_regions = by_source => {
  const out = [];
  const used = new Map();
  const unique = name => {
    const key = name.toLowerCase();
    const n = (used.get(key) ?? 0) + 1;
    used.set(key, n);
    return n === 1 ? name : `${name}-${n}`;
  };
  for (const [source, regions, file] of by_source) {
    (regions ?? []).forEach((r, index) => {
      if (![r.x, r.y, r.w, r.h].every(Number.isFinite) || r.w <= 0 || r.h <= 0) return;
      const name = r.name ?? usable_label(r.label, source) ?? `${region_prefix(source)}-${String(index + 1).padStart(2, '0')}`;
      out.push({
        name: unique(name), x: r.x, y: r.y, w: r.w, h: r.h,
        ...(r.unit ? { unit: r.unit } : {}),
        ...(r.imageWidth ? { image_width: r.imageWidth } : {}),
        ...(r.imageHeight ? { image_height: r.imageHeight } : {}),
        ...(file ? { file } : {}),
        ...(r.label ? { label: String(r.label) } : {}),
        source,
      });
    });
  }
  return out;
};

// Patterns as regular expressions, to know which viewers show the files exported: "**/" any folders, "*" and "?"
export const glob_regex = pattern => new RegExp(`^${String(pattern ?? '').split(/(\*\*\/|\*|\?)/).map(part =>
  part === '**/' ? '(?:.*/)?' : part === '*' ? '[^/]*' : part === '?' ? '[^/]' : part.replace(/[.+^${}()|[\]\\]/g, '\\$&')).join('')}$`);
export const is_single_file = pattern => !!pattern && !/[*?[]/.test(pattern);
export const IMAGE_EXTENSIONS = /\.(png|jpe?g|tiff?|bmp|webp)$/i;
// Patterns whose files can be images that the server crops
export const may_be_images = pattern => !!pattern && (IMAGE_EXTENSIONS.test(pattern) || pattern.endsWith('*'));


// Whether a preset fits the runs shown: {disabled: why not, or null, notes: [what to know]}.
// It doesn't fit when runs would get the same names, e.g. runs on the same input differ by settings it doesn't say.
export const preset_fit = (preset_settings, { new_batch, ref_batch, labels }) => {
  const naming = { ...default_naming, ...preset_settings };
  const notes = [];
  let plan;
  try {
    parse_template(naming.template);
    plan = export_runs({ new_batch, ref_batch, labels, naming });
  } catch (e) {
    return { disabled: e.message, notes };
  }
  const candidates = new Set(plan.candidates.map(c => c.key));
  const unused = (preset_settings.settings_keys ?? []).filter(k => !candidates.has(k));
  if (unused.length) notes.push(`These runs don't differ by ${unused.join(', ')}: names won't say ${unused.length === 1 ? 'it' : 'them'}`);
  if (naming.folder_mode === 'path' && naming.folder_path) notes.push(`Exports into ${naming.folder_path}`);
  // the same name for different runs, with one file per run
  const seen = new Map();
  const missing = new Set();
  for (const item of plan.items) {
    let name;
    try { name = file_name(naming.template, item_fields(item), 'file.png', naming.separator, naming.windows); } catch (e) { return { disabled: e.message, notes }; }
    const key = naming.windows ? name.toLowerCase() : name;
    const other = seen.get(key);
    if (other && other.id !== item.id) {
      if (other.side !== item.side) missing.add('new or reference');
      else if (other.fields.input === item.fields.input) {
        const says_settings = /\{settings\}/.test(naming.template);
        missing.add(plan.candidates.filter(c => c.needed && (!says_settings || !plan.picked.includes(c.key))).map(c => c.key).join(', ') || 'the settings that differ');
      }
      else missing.add('the input');
    }
    else seen.set(key, item);
  }
  if (missing.size) return { disabled: `Runs would get the same names: they don't say ${[...missing].join(', ')}`, notes };
  return { disabled: null, notes };
};

// Saved export settings (user preferences, synced to their account): the last export's, per project, and presets
// users name, for all projects or one. What's saved: how files are named, the files, links or copies, and a folder
// users chose (e.g. what their scripts read).
// Crops too: if users export them, the regions they're from, and whether whole files go with them.
// `folders`: export the folders the pattern matches, with their files (the default).
export const SAVED_KEYS = [...Object.keys(default_naming), 'files', 'type', 'folder_mode', 'folder_path', 'crops', 'crop_sources', 'crop_max', 'whole_files', 'folders'];
export const saved_settings = settings => Object.fromEntries(SAVED_KEYS.filter(k => settings[k] !== undefined).map(k => [k, settings[k]]));
// the presets that apply to a project, theirs first
export const presets_for = (presets, project) => (presets ?? [])
  .filter(p => !p.project || p.project === project)
  .sort((a, b) => (!!b.project - !!a.project) || a.name.localeCompare(b.name));
