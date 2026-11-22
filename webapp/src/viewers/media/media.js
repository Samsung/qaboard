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
  if (!Number.isInteger(line._step) || !Number.isInteger(line.index ?? 0)) return null;
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
export const groupKeys = keys => {
  const groups = new Map();
  for (const key of [...keys].sort(compare)) {
    const slash = key.indexOf('/');
    const group = slash > 0 ? key.slice(0, slash) : '';
    if (!groups.has(group)) groups.set(group, []);
    groups.get(group).push(key);
  }
  return [...groups.entries()].sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : compare(a, b))).map(([group, keys]) => ({ group, keys }));
};

// A box of an image in its pixels: boxes may be given as fractions of the image's size
export const boxInPixels = (box, width, height) => box.units === 'fraction'
  ? { ...box, x: box.x * width, y: box.y * height, w: box.w * width, h: box.h * height, units: undefined }
  : box;

export const boxLabel = box => [box.label, Number.isFinite(box.score) ? box.score.toFixed(2) : null].filter(v => v !== null && v !== undefined && v !== '').join(' ');

// The boxes of an image as the image viewer's regions of interest (src/image-viewer/regions.js), a color per group
// (e.g. predictions and ground truth). The viewer scales them to the image it shows.
const BOX_COLORS = ['#4c90f0', '#fbb360', '#72ca9b', '#f5498b', '#bdadff', '#68c1ee'];
export const boxColor = (groups, box) => BOX_COLORS[Math.max(0, groups.indexOf(box.group ?? '')) % BOX_COLORS.length];
export const boxGroups = boxes => [...new Set(boxes.map(box => box.group ?? ''))];
export const validBoxes = item => (Array.isArray(item?.boxes) ? item.boxes : [])
  .filter(box => box && [box.x, box.y, box.w, box.h].every(Number.isFinite));
export const boxRegions = item => {
  const boxes = validBoxes(item);
  const groups = boxGroups(boxes);
  return boxes.map(box => ({
    x: box.x, y: box.y, w: box.w, h: box.h,
    label: boxLabel(box) || undefined,
    detail: box.group,
    color: boxColor(groups, box),
    ...(box.units === 'fraction' ? { imageWidth: 1, imageHeight: 1 }
      : item.width && item.height ? { imageWidth: item.width, imageHeight: item.height } : {}),
  }));
};
