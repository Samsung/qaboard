// What a run logged at its steps besides numbers: images, audio, tables, histograms... (run.log() in Python, see
// qaboard/media.py for the format). The run's media.jsonl has one line per item:
//   {"_step": 1200, "_time": 1731500000.5, "key": "val/samples", "kind": "image", "index": 0, "path": "media/...", ...}
// Read like Python's read_media(): both are tested on tests/fixtures/media/. Change one, change the other.
// Pure JS: it imports nothing from the app.

export const MEDIA_INDEX = 'media.jsonl';
export const KINDS = ['image', 'video', 'audio', 'table', 'histogram', 'text', 'html', 'plotly', 'file'];
const known_kinds = new Set(KINDS);

const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const index_of = item => item.index ?? 0;

// The line as Python keeps it, or null: lines that don't parse (a run killed while it wrote one), unknown kinds, and
// lines without a key or an integer step are skipped
const read_line = text => {
  let line;
  try {
    line = JSON.parse(text);
  } catch {
    return null;
  }
  if (line === null || typeof line !== 'object' || Array.isArray(line)) return null;
  if (!known_kinds.has(line.kind) || typeof line.key !== 'string') return null;
  // like Python's read_media: an index that is there is an integer (null isn't 0)
  if (!Number.isInteger(line._step) || (Object.hasOwn(line, 'index') && !Number.isInteger(line.index))) return null;
  return line;
};

// { items, keys, steps }
// - items: the items, sorted by key, step and index. The same key, step and index logged again: the last line wins
// - keys: { [key]: { kind, steps: [sorted steps], by_step: Map(step => [items, by index]) } }
// - steps: all the keys' steps, sorted
export const parseMedia = text => {
  const unique = new Map();
  for (const line of (text ?? '').split('\n')) {
    if (!line.trim()) continue;
    const item = read_line(line);
    if (item) unique.set(JSON.stringify([item.key, item._step, index_of(item)]), item);
  }
  const items = [...unique.values()].sort((a, b) => compare(a.key, b.key) || a._step - b._step || index_of(a) - index_of(b));
  const keys = {};
  const steps = new Set();
  for (const item of items) {
    const key = keys[item.key] ??= { kind: item.kind, steps: [], by_step: new Map() };
    // a key whose kind changed is shown as what it is now
    key.kind = item.kind;
    if (!key.by_step.has(item._step)) {
      key.by_step.set(item._step, []);
      key.steps.push(item._step);
    }
    key.by_step.get(item._step).push(item);
    steps.add(item._step);
  }
  return { items, keys, steps: [...steps].sort((a, b) => a - b) };
};

export const empty_media = Object.freeze({ items: [], keys: {}, steps: [] });

// The greatest of the sorted steps <= step, or null when step is before them all
export const snap = (steps, step) => {
  let low = 0, high = steps.length - 1, found = null;
  while (low <= high) {
    const middle = (low + high) >> 1;
    if (steps[middle] <= step) {
      found = steps[middle];
      low = middle + 1;
    } else high = middle - 1;
  }
  return found;
};

// What a key shows at a step: the items of its greatest step <= step. { step, items }; before its first step,
// { step: null, items: [] }: "not logged yet at step N"
export const itemAt = (model, key, step) => {
  const entry = model?.keys?.[key];
  if (!entry) return { step: null, items: [] };
  const at = step === null || step === undefined ? entry.steps.at(-1) ?? null : snap(entry.steps, step);
  return { step: at, items: at === null ? [] : entry.by_step.get(at) };
};

// The steps of several models (the new run's and the reference's), sorted
export const unionSteps = (...models) => [...new Set(models.flatMap(model => model?.steps ?? []))].sort((a, b) => a - b);

// The logged step before or after a step (arrow keys), or the step itself at the ends
export const nextStep = (steps, step, direction) => direction > 0
  ? steps.find(s => s > step) ?? steps.at(-1) ?? step
  : steps.findLast(s => s < step) ?? steps[0] ?? step;

// The keys grouped by their prefix: "val/samples" and "val/masks" under "val", keys without "/" under "".
// [{ group, keys: [key] }], groups sorted, "" first
// What people come to look at first: images and videos, then sounds, tables, distributions, and texts last
const KIND_RANK = { image: 0, video: 1, audio: 2, table: 3, histogram: 4, plotly: 5, text: 6, html: 7, file: 8 };
const rank = kind => KIND_RANK[kind] ?? 9;

// The keys grouped by their prefix ("val/samples" in "val"), keys without one in a group of their own name. With
// `kind_of`, the most visual groups and keys come first, then by name; without it, by name.
export const groupKeys = (keys, kind_of = () => undefined) => {
  const groups = new Map();
  for (const key of keys) {
    const slash = key.indexOf('/');
    const group = slash > 0 ? key.slice(0, slash) : '';
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(key);
  }
  const by_kind = (a, b) => rank(kind_of(a)) - rank(kind_of(b)) || compare(a, b);
  const entries = [...groups.entries()].map(([group, keys]) => ({ group, keys: keys.sort(by_kind), rank: Math.min(...keys.map(key => rank(kind_of(key)))) }));
  return entries
    .sort((a, b) => a.rank - b.rank || (a.group === '' ? -1 : b.group === '' ? 1 : compare(a.group, b.group)))
    .map(({ group, keys }) => ({ group, keys }));
};

// A box of an image in its pixels: boxes may be given as fractions of the image's size
export const boxInPixels = (box, width, height) => box.units === 'fraction'
  ? { ...box, x: box.x * width, y: box.y * height, w: box.w * width, h: box.h * height, units: undefined }
  : box;

export const boxLabel = box => [box.label, Number.isFinite(box.score) ? box.score.toFixed(2) : null].filter(v => v !== null && v !== undefined && v !== '').join(' ');

// --- samples: the same sample across steps and runs ------------------------------------------------------------
// Items match by their `id` (e.g. "img_0042"), else their caption, else their position in the list: loaders shuffle,
// so positions only work for fixed sets. Ids or captions logged several times at a step (two "cat" images) match in
// order: the second "cat" with the other side's second "cat".
const has = value => value !== undefined && value !== null && value !== '';
const base_key = item => has(item?.id) ? `id:${item.id}` : has(item?.caption) ? `caption:${item.caption}` : `index:${index_of(item ?? {})}`;

// The samples' names at a step, for URLs and React keys, unique: "id:img_0042", "caption:cat", "caption:cat#1" (the
// second "cat"), "index:3"
const keys_cache = new WeakMap();
export const sampleKeys = items => {
  if (keys_cache.has(items)) return keys_cache.get(items);
  const seen = new Map();
  const keys = items.map(item => {
    const key = base_key(item);
    const n = seen.get(key) ?? 0;
    seen.set(key, n + 1);
    return n ? `${key}#${n}` : key;
  });
  keys_cache.set(items, keys);
  return keys;
};

// A sample's name (see sampleKeys), unique among `items`, the items logged with it
export const sampleKey = (item, items) => {
  const i = items ? items.indexOf(item) : -1;
  return i >= 0 ? sampleKeys(items)[i] : base_key(item);
};

// Which of the items with the same value of `field` the item is: 0 for the first
const occurrence = (item, items, field) => {
  let n = 0;
  for (const other of items ?? []) {
    if (other === item) return n;
    if (has(other[field]) && String(other[field]) === String(item[field])) n++;
  }
  return 0;
};
const nth = (items, field, value, n) => {
  for (const item of items) if (has(item[field]) && String(item[field]) === String(value) && n-- === 0) return item;
  return null;
};

// The item of `items` that is the same sample as `item` (or as a sampleKey), and how it matched: { item, by }, item null
// when there is none. Ids are used when both sides have some, captions likewise, else positions. `from`: the items
// logged with `item`, to match the n-th of the same id or caption with the n-th.
export const matchItem = (sample, items, from) => {
  if (typeof sample === 'string') {
    const [by, ...rest] = sample.split(':');
    if (by === 'index') {
      const index = Number(rest.join(':'));
      return { item: items.find(c => index_of(c) === index) ?? null, by };
    }
    const i = sampleKeys(items).indexOf(sample);
    return { item: i >= 0 ? items[i] : null, by };
  }
  const item = sample ?? {};
  if (has(item.id) && items.some(c => has(c.id)))
    return { item: nth(items, 'id', item.id, occurrence(item, from, 'id')), by: 'id' };
  if (has(item.caption) && items.some(c => has(c.caption)))
    return { item: nth(items, 'caption', item.caption, occurrence(item, from, 'caption')), by: 'caption' };
  const index = index_of(item);
  return { item: items.find(c => index_of(c) === index) ?? null, by: 'index' };
};

// One sample at every step of a key: [{ step, item }], item null where it wasn't logged
export const evolution = (model, key, sample) => {
  const entry = model?.keys?.[key];
  if (!entry) return [];
  return entry.steps.map(step => ({ step, item: matchItem(sample, entry.by_step.get(step)).item }));
};

// The key, sample and evolution strip users are on (controls.media_focus): from the address, so anything. What isn't
// of the expected type is dropped.
export const cleanFocus = focus => {
  if (!focus || typeof focus !== 'object' || Array.isArray(focus)) return {};
  const clean = {};
  if (typeof focus.run === 'number' || typeof focus.run === 'string') clean.run = focus.run;
  if (typeof focus.key === 'string') clean.key = focus.key;
  if (typeof focus.sample === 'string') clean.sample = focus.sample;
  if (typeof focus.open === 'boolean') clean.open = focus.open;
  if (typeof focus.evolution === 'boolean') clean.evolution = focus.evolution;
  return clean;
};

// The smallest and greatest of sorted (or not) step arrays, without spreading them (too many arguments past ~100k)
export const stepRange = (...arrays) => {
  let min = Infinity, max = -Infinity;
  for (const steps of arrays) for (const s of steps) {
    if (s < min) min = s;
    if (s > max) max = s;
  }
  return { min, max };
};

// What a run logged: "12 keys · steps 0–24 000 · images, audio, tables"
const KIND_NAMES = { image: 'images', video: 'videos', audio: 'audio', table: 'tables', histogram: 'histograms', text: 'texts', html: 'HTML', plotly: 'plots', file: 'files' };
export const formatStep = step => String(step).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
export const summary = model => {
  const keys = Object.values(model.keys);
  const kinds = KINDS.filter(kind => keys.some(key => key.kind === kind)).map(kind => KIND_NAMES[kind]);
  const steps = model.steps.length === 0 ? null : model.steps.length === 1 ? `step ${formatStep(model.steps[0])}` : `steps ${formatStep(model.steps[0])}–${formatStep(model.steps.at(-1))}`;
  return [`${keys.length} ${keys.length === 1 ? 'key' : 'keys'}`, steps, kinds.join(', ')].filter(Boolean).join(' · ');
};

// --- boxes ---------------------------------------------------------------------------------------------------------
// One color per label, the same on every image and run: from a hash of the label
const BOX_COLORS = ['#4c90f0', '#fbb360', '#72ca9b', '#f5498b', '#bdadff', '#68c1ee', '#fbd065', '#d1f26d', '#ff9980', '#c5cbd3'];
export const labelColor = label => {
  let hash = 7;
  for (const c of String(label ?? '')) hash = (Math.imul(hash, 31) + c.charCodeAt(0)) >>> 0;
  return BOX_COLORS[hash % BOX_COLORS.length];
};
export const boxGroups = boxes => [...new Set(boxes.map(box => box.group ?? ''))];
export const validBoxes = item => (Array.isArray(item?.boxes) ? item.boxes : [])
  .filter(box => box && [box.x, box.y, box.w, box.h].every(Number.isFinite));
// What users chose to see: { hidden: Set of groups, min_score }. Boxes without a score are always shown.
export const filterBoxes = (boxes, { hidden, min_score = 0 } = {}) => boxes.filter(box =>
  !hidden?.has(box.group ?? '') && !(Number.isFinite(box.score) && box.score < min_score));

// The boxes of an image as the image viewer's regions of interest (src/image-viewer/regions.js). The viewer scales them
// to the image it shows.
export const boxRegions = (item, filters) => filterBoxes(validBoxes(item), filters).map(box => ({
  x: box.x, y: box.y, w: box.w, h: box.h,
  label: boxLabel(box) || undefined,
  detail: box.group,
  color: labelColor(box.label),
  ...(box.units === 'fraction' ? { imageWidth: 1, imageHeight: 1 }
    : item.width && item.height ? { imageWidth: item.width, imageHeight: item.height } : {}),
}));
