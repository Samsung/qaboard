// The flame graph viewer's model: call trees, their comparison with the reference's, search and top functions.
//
// A tree's nodes are {name, value, self, children}: `value` is inclusive (the node's own value, `self`, plus its
// children's), the shape d3-flame-graph draws. Nodes are matched between the new and the reference profile by their
// path of names, from the root, and siblings never share a name (they're merged when parsed).

export const newNode = name => ({ name, value: 0, self: 0, children: [] });

// The child named `name`, created if needed. The index of children by name is built on demand.
export const childNamed = (node, name) => {
  let index = node.index;
  if (!index) {
    index = new Map();
    for (const child of node.children) index.set(child.name, child);
    Object.defineProperty(node, 'index', { value: index, enumerable: false, writable: true });
  }
  let child = index.get(name);
  if (child === undefined) {
    child = newNode(name);
    node.children.push(child);
    index.set(name, child);
  }
  return child;
};
const findChild = (node, name) => node.index ? node.index.get(name) : node.children.find(c => c.name === name);

// Inclusive values from the self values, after the parsers added self values only
export const sumValues = root => {
  // iterative post-order: stacks can be thousands of frames deep
  const stack = [root];
  const order = [];
  while (stack.length) {
    const node = stack.pop();
    order.push(node);
    for (const child of node.children) stack.push(child);
  }
  for (let i = order.length - 1; i >= 0; i--) {
    const node = order[i];
    let value = node.self;
    for (const child of node.children) value += child.value;
    node.value = value;
  }
  return root;
};

// Adds a tree into another (e.g. a speedscope file's threads), by path of names. Iterative, like all the walks of
// whole trees here: stacks can be thousands of frames deep.
export const mergeInto = (target, tree) => {
  const stack = [[target, tree]];
  while (stack.length) {
    const [into, node] = stack.pop();
    into.self += node.self;
    for (const child of node.children) stack.push([childNamed(into, child.name), child]);
  }
  return target;
};

export const mergeTrees = (trees, name = 'all') => {
  const root = newNode(name);
  for (const tree of trees) mergeInto(root, tree);
  return sumValues(root);
};

export const countNodes = tree => {
  let count = 0;
  const stack = [tree];
  while (stack.length) {
    const node = stack.pop();
    count++;
    for (const child of node.children) stack.push(child);
  }
  return count;
};


// ---------------------------------------------------------------------------- units
const TIME_UNITS = { nanoseconds: 1e-9, microseconds: 1e-6, milliseconds: 1e-3, seconds: 1 };
const ALIASES = {
  ns: 'nanoseconds', nanosecond: 'nanoseconds', nanoseconds: 'nanoseconds',
  us: 'microseconds', 'µs': 'microseconds', 'μs': 'microseconds', microsecond: 'microseconds', microseconds: 'microseconds',
  ms: 'milliseconds', millisecond: 'milliseconds', milliseconds: 'milliseconds',
  s: 'seconds', sec: 'seconds', second: 'seconds', seconds: 'seconds',
  b: 'bytes', byte: 'bytes', bytes: 'bytes',
  sample: 'samples', samples: 'samples', none: 'samples', count: 'samples', '': 'samples',
};

// "microseconds of CPU per 1,000 requests" -> {unit: 'microseconds', note: 'of CPU per 1,000 requests'}
export const parseUnit = text => {
  const [word = '', ...rest] = `${text ?? ''}`.trim().split(/\s+/);
  const unit = ALIASES[word.toLowerCase()];
  if (unit) return { unit, note: rest.join(' ') };
  return { unit: word, note: rest.join(' ') };
};

const significant = (value, digits = 3) => {
  if (value === 0 || !Number.isFinite(value)) return `${value}`;
  const abs = Math.abs(value);
  if (abs >= 10 ** digits) return Math.round(value).toLocaleString('en-US');
  return `${parseFloat(value.toPrecision(digits))}`;
};

// A value in its unit, e.g. "1.23 ms", "12,345 samples", "4.5 MiB"
export const formatValue = (value, unit = 'samples') => {
  if (value === undefined || value === null || Number.isNaN(value)) return '';
  if (TIME_UNITS[unit] !== undefined) {
    const seconds = value * TIME_UNITS[unit];
    const abs = Math.abs(seconds);
    if (abs === 0) return '0 s';
    if (abs < 1e-6) return `${significant(seconds * 1e9)} ns`;
    if (abs < 1e-3) return `${significant(seconds * 1e6)} µs`;
    if (abs < 1) return `${significant(seconds * 1e3)} ms`;
    return `${significant(seconds)} s`;
  }
  if (unit === 'bytes') {
    const abs = Math.abs(value);
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
    let i = 0;
    while (i < units.length - 1 && abs >= 1024 ** (i + 1)) i++;
    return `${significant(value / 1024 ** i)} ${units[i]}`;
  }
  const number = Number.isInteger(value) ? value.toLocaleString('en-US') : significant(value);
  if (unit === 'samples') return `${number} ${Math.abs(value) === 1 ? 'sample' : 'samples'}`;
  return unit ? `${number} ${unit}` : number;
};

export const formatShare = share => {
  if (!Number.isFinite(share)) return '';
  const percent = share * 100;
  if (percent === 0) return '0%';
  if (Math.abs(percent) < 0.01) return '<0.01%';
  return `${parseFloat(percent.toFixed(Math.abs(percent) < 10 ? 2 : 1))}%`;
};

// A change of share in percentage points: "+2.3 pp"
export const formatPoints = points => {
  const value = points * 100;
  if (Math.abs(value) < 0.005) return '0 pp';
  return `${value > 0 ? '+' : '−'}${parseFloat(Math.abs(value).toFixed(Math.abs(value) < 10 ? 2 : 1))} pp`;
};

export const formatDelta = (delta, unit) => {
  if (Math.abs(delta) < 1e-12) return formatValue(0, unit);
  return `${delta > 0 ? '+' : '−'}${formatValue(Math.abs(delta), unit)}`;
};


// ---------------------------------------------------------------------------- comparing with the reference
// Frames narrower than this share of the profile are not drawn: they'd be under a pixel wide until zoomed 50 times,
// and d3-flame-graph slows down with the number of nodes. Search, tooltips and the table use the whole tree.
export const MIN_SHARE_DRAWN = 2e-5;
// Nor deeper frames: d3-flame-graph walks its tree recursively, and deeper stacks overflow the browser's call stack.
export const MAX_DEPTH_DRAWN = 1000;

// What d3-flame-graph draws: a copy of the tree, without the frames too narrow to see, where each node knows its
// match in the other profile:
// - delta: what d3-flame-graph's computeDelta needs: it adds up the children's deltas, so we give each node its
//   inclusive delta minus its drawn children's. Frames only in the other profile, or too narrow, still count.
//   Positive when the new profile takes more: with `side: 'reference'` the tree is the reference's.
// - other_value, other_self: the other profile's raw values (undefined when the frame isn't there), and `missing`
//   ('new' or 'removed') for frames that aren't in the other profile.
// - mode 'share' (the default): the other profile's values are scaled by total / other total before they're
//   subtracted: we compare shares of each profile, since two runs rarely take the same number of samples.
//   With 'absolute', raw values are subtracted.
export const drawnTree = (tree, other, { mode = 'share', minShare = MIN_SHARE_DRAWN, side = 'new', maxDepth = MAX_DEPTH_DRAWN } = {}) => {
  const total = tree.value;
  const scale = other && mode === 'share' && other.value ? total / other.value : 1;
  const sign = side === 'reference' ? -1 : 1;
  const min = total * minShare;
  const copy = (node, match, key) => {
    const out = { name: node.name, value: node.value, self: node.self, key, children: [] };
    if (other) {
      out.other_value = match?.value;
      out.other_self = match?.self;
      if (!match) out.missing = side === 'reference' ? 'removed' : 'new';
      out.delta = sign * (node.value - (match?.value ?? 0) * scale);
      // not enumerable: d3-flame-graph doesn't need it
      Object.defineProperty(out, 'delta_inclusive', { value: out.delta, enumerable: false });
    }
    return out;
  };
  const root = copy(tree, other, tree.name);
  // iterative, depth first: [node, its match, its copy, depth]
  const stack = [[tree, other, root, 0]];
  while (stack.length) {
    const [node, match, out, depth] = stack.pop();
    if (depth >= maxDepth) {
      // said under the graph; not enumerable: d3-flame-graph doesn't need it
      if (node.children.length && !root.too_deep) Object.defineProperty(root, 'too_deep', { value: true, enumerable: false });
      continue;
    }
    for (const child of node.children) {
      if (child.value < min || child.value <= 0) continue;
      const child_match = match ? findChild(match, child.name) : undefined;
      const drawn = copy(child, child_match, `${out.key};${child.name}`);
      out.children.push(drawn);
      if (other) out.delta -= drawn.delta_inclusive;
      stack.push([child, child_match, drawn, depth + 1]);
    }
  }
  return root;
};

// The frame with this path of names ("all;main;parse"), or undefined
export const findPath = (tree, key) => {
  const names = key.split(';');
  let node = tree;
  for (const name of names.slice(1)) {
    node = node && findChild(node, name);
  }
  return node;
};


// ---------------------------------------------------------------------------- search
// A function name -> bool from what users type. Regular expressions by default; an invalid one is searched as text.
export const makeMatcher = (query, { regex = true, matchCase = false } = {}) => {
  if (!query) return null;
  if (regex) {
    try {
      const re = new RegExp(query, matchCase ? '' : 'i');
      return Object.assign(name => re.test(name), { invalid: false });
    } catch {
      // searched as text below
    }
  }
  const needle = matchCase ? query : query.toLowerCase();
  const match = matchCase ? name => name.includes(needle) : name => name.toLowerCase().includes(needle);
  return Object.assign(match, { invalid: regex });
};

// The share of the profile in frames that match, counted once when they're nested, like d3-flame-graph's search
export const matchedValue = (tree, matches) => {
  if (!matches || !tree) return 0;
  let sum = 0;
  const stack = [tree];
  while (stack.length) {
    const node = stack.pop();
    if (matches(node.name)) {
      sum += node.value;
      continue;
    }
    for (const child of node.children) stack.push(child);
  }
  return sum;
};


// ---------------------------------------------------------------------------- top functions
// Per function name: {self, total}. A function's total counts each stack once, even when it's recursive.
export const functionTotals = tree => {
  const totals = new Map();
  const onPath = new Map();
  // iterative: entering a node, then leaving it ({leave: name}) once its children are done
  const stack = [...tree.children].reverse();
  while (stack.length) {
    const item = stack.pop();
    if ('leave' in item) {
      onPath.set(item.leave, onPath.get(item.leave) - 1);
      continue;
    }
    const node = item;
    let entry = totals.get(node.name);
    if (!entry) {
      entry = { self: 0, total: 0 };
      totals.set(node.name, entry);
    }
    entry.self += node.self;
    const depth = onPath.get(node.name) ?? 0;
    if (depth === 0) entry.total += node.value;
    onPath.set(node.name, depth + 1);
    stack.push({ leave: node.name });
    for (let i = node.children.length - 1; i >= 0; i--) stack.push(node.children[i]);
  }
  return totals;
};

// The rows of the "top functions" table: each function's self and total in both profiles, and the change of its
// self value: of its share of the profile (mode 'share') or of its value ('absolute').
export const topFunctions = (tree, other, { mode = 'share' } = {}) => {
  const totals = functionTotals(tree);
  const other_totals = other ? functionTotals(other) : new Map();
  const total = tree.value || 1;
  const other_total = other?.value || 1;
  const rows = [];
  const empty = { self: 0, total: 0 };
  for (const name of new Set([...totals.keys(), ...other_totals.keys()])) {
    const now = totals.get(name) ?? empty;
    const before = other ? other_totals.get(name) : undefined;
    const row = {
      name,
      self: now.self,
      total: now.total,
      self_share: now.self / total,
      total_share: now.total / total,
      is_new: !!other && !before,
      is_removed: !totals.has(name),
    };
    if (other) {
      const b = before ?? empty;
      row.other_self = b.self;
      row.other_total = b.total;
      row.change = mode === 'share' ? now.self / total - b.self / other_total : now.self - b.self;
    }
    rows.push(row);
  }
  return rows;
};
