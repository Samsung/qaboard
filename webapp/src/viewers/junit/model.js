// What the JUnit viewer shows: tests compared with the reference's, as a tree with counts, filtered and flattened
// into the rows the list renders. Everything here is linear in the number of tests: 50,000 tests take a few ms.

const FAILING = new Set(['failed', 'error']);
export const isFailing = test => FAILING.has(test.status);

// How a test changed vs the reference, from the most to the least important. `null`: no change worth showing.
export const CHANGES = {
  'new-failure': { label: 'New failure', short: 'new failure', many: 'new failures', intent: 'danger' },
  'still-failing': { label: 'Still failing', short: 'still failing', intent: 'danger', minor: true },
  'fixed': { label: 'Fixed', short: 'fixed', intent: 'success' },
  'removed': { label: 'Removed', short: 'removed', intent: 'none' },
  'added': { label: 'Added', short: 'added', intent: 'primary' },
  'newly-flaky': { label: 'Newly flaky', short: 'newly flaky', intent: 'warning' },
  'newly-skipped': { label: 'Newly skipped', short: 'newly skipped', intent: 'none' },
  'unskipped': { label: 'No longer skipped', short: 'unskipped', intent: 'none' },
  'slower': { label: 'Much slower', short: 'slower', intent: 'warning', minor: true },
};
export const CHANGE_ORDER = Object.keys(CHANGES);
// "3 new failures", "1 fixed"
export const changeCount = (n, change) => `${n.toLocaleString()} ${n === 1 ? CHANGES[change].short : CHANGES[change].many ?? CHANGES[change].short}`;

// A test is "much slower" when it takes twice as long and at least 100 ms more: test times are noisy
const SLOWER_RATIO = 2;
const SLOWER_DELTA = 0.1;

export function changeOf(test, ref) {
  if (!ref) return 'added';
  const failing = isFailing(test);
  const ref_failing = isFailing(ref);
  if (failing && ref_failing) return 'still-failing';
  if (failing) return 'new-failure';
  // a failing test that is now skipped isn't fixed
  if (test.status === 'skipped' && ref.status !== 'skipped') return 'newly-skipped';
  if (ref_failing) return 'fixed';
  if (test.status === 'flaky' && ref.status !== 'flaky') return 'newly-flaky';
  if (test.status !== 'skipped' && ref.status === 'skipped') return 'unskipped';
  if (test.time >= SLOWER_RATIO * ref.time && test.time - ref.time >= SLOWER_DELTA) return 'slower';
  return null;
}

// The new tests, each with its reference test (`ref`) and how it changed (`change`), then the reference's tests that
// are gone, with the status `removed`. Without a reference, nothing changed.
export function compareTests(tests, ref_tests) {
  if (!ref_tests)
    return tests.map(test => ({ ...test, ref: null, change: null }));
  const by_id = new Map(ref_tests.map(t => [t.id, t]));
  const compared = tests.map(test => {
    const ref = by_id.get(test.id) ?? null;
    by_id.delete(test.id);
    return { ...test, ref, change: changeOf(test, ref) };
  });
  for (const ref of by_id.values())
    compared.push({ ...ref, status: 'removed', time: 0, message: '', text: '', stdout: '', stderr: '', ref, change: 'removed' });
  return compared;
}

const emptyCounts = () => ({ tests: 0, passed: 0, failed: 0, error: 0, flaky: 0, skipped: 0, removed: 0 });

// Counts over tests: by status (`tests` leaves out the removed ones), by change, and their time
export function countTests(tests) {
  const counts = emptyCounts();
  const changes = {};
  let time = 0;
  let ref_time = 0;
  for (const test of tests) {
    counts[test.status] += 1;
    if (test.status !== 'removed') {
      counts.tests += 1;
      time += test.time;
    }
    if (test.ref) ref_time += test.ref.time;
    if (test.change) changes[test.change] = (changes[test.change] || 0) + 1;
  }
  return { counts, changes, time, ref_time };
}

function addCounts(node, test) {
  node.counts[test.status] += 1;
  if (test.status !== 'removed') {
    node.counts.tests += 1;
    node.time += test.time;
  }
  if (test.ref) node.ref_time += test.ref.time;
  if (test.change) node.changes[test.change] = (node.changes[test.change] || 0) + 1;
}

const newNode = (key, name) => ({ key, name, children: [], tests: [], counts: emptyCounts(), changes: {}, time: 0, ref_time: 0 });

// The tests as a tree: a node per part of their path (packages, modules, classes, suites), tests as leaves. Chains of
// nodes with one child and no test of their own are merged ("tests.codec"), like an IDE's compact folders.
export function buildTree(tests) {
  const root = newNode('', '');
  const nodes = new Map([['', root]]);
  for (const test of tests) {
    addCounts(root, test);
    let node = root;
    let key = '';
    for (const part of test.path.slice(0, -1)) {
      key = key ? `${key}\u0000${part}` : part;
      let child = nodes.get(key);
      if (!child) {
        child = newNode(key, part);
        nodes.set(key, child);
        node.children.push(child);
      }
      addCounts(child, test);
      node = child;
    }
    node.tests.push(test);
  }
  const compact = node => {
    node.children = node.children.map(child => {
      while (child.children.length === 1 && child.tests.length === 0) {
        const only = child.children[0];
        child = { ...only, name: `${child.name}.${only.name}` };
      }
      compact(child);
      return child;
    });
  };
  compact(root);
  return root;
}

// "codec -fuzz": every word must be in the test's id or message, words starting with - must not
export function parseSearch(search) {
  const words = (search || '').toLowerCase().split(/\s+/).filter(Boolean);
  return {
    include: words.filter(w => !w.startsWith('-')),
    exclude: words.filter(w => w.startsWith('-') && w.length > 1).map(w => w.slice(1)),
  };
}

const haystack = test => {
  if (test._haystack === undefined)
    test._haystack = `${test.id} ${test.message}`.toLowerCase();
  return test._haystack;
};

// The filter of the list: statuses (a Set, empty: all), a change ('' all, 'changed', or one of CHANGES), a search
export function testFilter({ statuses, change, search }) {
  const { include, exclude } = parseSearch(search);
  const any = !statuses?.size && !change && !include.length && !exclude.length;
  if (any) return null;
  return test => {
    if (statuses?.size && !statuses.has(test.status)) return false;
    if (change === 'changed') {
      if (!test.change || CHANGES[test.change].minor) return false;
    } else if (change && test.change !== change) return false;
    if (include.length || exclude.length) {
      const text = haystack(test);
      if (!include.every(w => text.includes(w))) return false;
      if (exclude.some(w => text.includes(w))) return false;
    }
    return true;
  };
}

// How many tests of each node pass the filter: node key -> count. null when nothing is filtered.
export function visibleCounts(root, filter) {
  if (!filter) return null;
  const visible = new Map();
  const walk = node => {
    let count = 0;
    for (const child of node.children) count += walk(child);
    for (const test of node.tests) if (filter(test)) count += 1;
    visible.set(node.key, count);
    return count;
  };
  walk(root);
  return visible;
}

const SEVERITY = { 'new-failure': 0, failed: 1, error: 1, removed: 2, flaky: 3, skipped: 4, passed: 5 };
// removed tests that failed in the reference come first: deleting a failing test is how a CI gets green
const severity = test => test.change === 'new-failure' ? 0
  : test.status === 'removed' && test.ref && isFailing(test.ref) ? 1.5
  : SEVERITY[test.status];
const problems = node => node.changes['new-failure'] || 0;
const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

const SORTS = {
  // groups by name, tests in the report's order (the order they ran)
  name: { groups: (a, b) => collator.compare(a.name, b.name), tests: null },
  // what fails first: new failures, failures, removed, flaky, skipped
  status: {
    groups: (a, b) => (problems(b) - problems(a))
      || ((b.counts.failed + b.counts.error) - (a.counts.failed + a.counts.error))
      || (b.counts.removed - a.counts.removed) || (b.counts.flaky - a.counts.flaky)
      || collator.compare(a.name, b.name),
    tests: (a, b) => (severity(a) - severity(b)) || 0,
  },
  time: { groups: (a, b) => b.time - a.time, tests: (a, b) => b.time - a.time },
};
export const SORT_OPTIONS = [
  { value: 'status', label: 'Failures first' },
  { value: 'name', label: 'Name' },
  { value: 'time', label: 'Slowest first' },
];

// The rows of the list: the expanded groups' children, depth first, only those with visible tests.
// `expanded`: a Set of node keys, or `true` for all of them (when searching).
export function flatten(root, { expanded, visible, sort = 'status', filter }) {
  const rows = [];
  const { groups, tests } = SORTS[sort] ?? SORTS.status;
  const walk = (node, depth) => {
    const children = visible ? node.children.filter(c => visible.get(c.key) > 0) : [...node.children];
    children.sort(groups);
    for (const child of children) {
      const open = expanded === true || expanded.has(child.key);
      rows.push({ kind: 'group', key: child.key, node: child, depth, open });
      if (open) walk(child, depth + 1);
    }
    let leaves = filter ? node.tests.filter(filter) : node.tests;
    if (tests) leaves = [...leaves].sort(tests);
    for (const test of leaves) rows.push({ kind: 'test', key: `t\u0000${test.id}`, test, depth, parent: node.key });
  };
  walk(root, 0);
  return rows;
}

// The groups to open at first: the top level, and every group with a test that needs a look
export function defaultExpanded(root, { has_reference }) {
  const keys = new Set();
  const needs_look = node => node.counts.failed + node.counts.error + node.counts.flaky > 0
    || (has_reference && (node.changes['new-failure'] || node.changes['fixed'] || node.changes['removed'] || node.changes['added']));
  const walk = (node, depth) => {
    for (const child of node.children) {
      if (depth === 0 || needs_look(child)) {
        keys.add(child.key);
        walk(child, depth + 1);
      }
    }
  };
  walk(root, 0);
  return keys;
}

export function allGroupKeys(root) {
  const keys = new Set();
  const walk = node => node.children.forEach(child => { keys.add(child.key); walk(child); });
  walk(root);
  return keys;
}

// The keys of the groups above a test, to open them when we jump to it. A group's key is its path's parts joined, so
// they are the test's path prefixes that are groups (merged groups keep the key of their last part).
export function ancestorKeys(test, group_keys) {
  const keys = [];
  let key = '';
  for (const part of test.path.slice(0, -1)) {
    key = key ? `${key}\u0000${part}` : part;
    if (group_keys.has(key)) keys.push(key);
  }
  return keys;
}

export const formatTime = seconds => {
  if (!Number.isFinite(seconds)) return '';
  if (seconds === 0) return '0 s';
  if (seconds < 0.001) return '<1 ms';
  if (seconds < 1) return `${Math.round(seconds * 1000)} ms`;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 2 : 1)} s`;
  const minutes = Math.floor(seconds / 60);
  return `${minutes} min ${Math.round(seconds - 60 * minutes)} s`;
};
