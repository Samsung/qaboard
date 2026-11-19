// Each test over the commits, from the commits' test reports (the tests of the JUnit viewer's parser:
// {id, path, status, time}): what the totals don't say. Which tests fail now and since when, which are flaky, slower,
// new or gone. Nothing is stored for it: the reports are read again, for at most a hundred commits.

export const CODES = { absent: 0, passed: 1, skipped: 2, flaky: 3, failed: 4, error: 5 };
export const STATUS_NAMES = ['absent', 'passed', 'skipped', 'flaky', 'failed', 'error'];
const FAILING = code => code >= CODES.failed;
const RAN = code => code === CODES.passed || code >= CODES.flaky;

// reports: aligned with the commits, oldest first: the tests of a commit's reports, or null (no report, not loaded).
// => {loaded: [indexes of the commits with a report], tests: [{id, name, path, statuses, times, ...facts}]}
// Facts, only looking at commits with a report:
// - failing_since: the index where the current streak of failures started (the test fails in the last report),
// - fixed_at: it failed in these commits and passes now, since that index,
// - flips: how many times it went from passing to failing or back; `flaky`: 2 flips or more, or reported as flaky
//   by the test runner (it passed when run again),
// - added_at / removed_at: not in the first report / not in the last, with the index where that changed,
// - slowdown: its last time over its first, for tests that take long enough to tell (MIN_TIME).
export const MIN_TIME = 0.05;
export function buildTestHistory(reports) {
  const count = reports.length;
  const loaded = [];
  reports.forEach((tests, i) => { if (tests) loaded.push(i); });
  const by_id = new Map();
  for (const i of loaded) {
    for (const test of reports[i]) {
      let entry = by_id.get(test.id);
      if (!entry) {
        entry = { id: test.id, name: test.name ?? test.id, path: test.path ?? [test.id], statuses: new Uint8Array(count), times: new Float32Array(count) };
        by_id.set(test.id, entry);
      }
      entry.statuses[i] = CODES[test.status] ?? CODES.passed;
      entry.times[i] = test.time ?? 0;
    }
  }
  const tests = [...by_id.values()];
  if (loaded.length === 0) return { loaded, tests };
  const first = loaded[0], last = loaded[loaded.length - 1];
  for (const test of tests) {
    const { statuses, times } = test;
    let flips = 0, runner_flaky = 0, failures = 0, previous = null, since = null;
    let first_time = null, last_time = null;
    for (const i of loaded) {
      const code = statuses[i];
      if (code === CODES.flaky) runner_flaky += 1;
      if (!RAN(code)) continue;
      const failing = FAILING(code);
      if (failing) failures += 1;
      if (previous !== null && failing !== previous) flips += 1;
      if (previous === null || failing !== previous) since = i;
      previous = failing;
      if (!failing && times[i] > 0) {
        if (first_time === null) first_time = times[i];
        last_time = times[i];
      }
    }
    test.flips = flips;
    test.failures = failures;
    test.flaky = flips >= 2 || runner_flaky > 0;
    test.failing_since = FAILING(statuses[last]) ? since : null;
    test.fixed_at = !FAILING(statuses[last]) && statuses[last] !== CODES.absent && failures > 0 && previous === false ? since : null;
    test.added_at = statuses[first] === CODES.absent ? loaded.find(i => statuses[i] !== CODES.absent) : null;
    test.removed_at = statuses[last] === CODES.absent ? loaded.find(i => i > lastPresent(statuses, loaded)) ?? null : null;
    test.last_time = last_time;
    test.slowdown = first_time !== null && last_time !== null && Math.max(first_time, last_time) >= MIN_TIME ? last_time / first_time : null;
  }
  return { loaded, tests };
}
const lastPresent = (statuses, loaded) => {
  let found = -1;
  for (const i of loaded) if (statuses[i] !== CODES.absent) found = i;
  return found;
};

// What to look at first. Each has `is` and `sort` (most interesting first).
export const SLOWER = 1.5;
export const VIEWS = [
  { id: 'failing', label: 'Failing now', empty: 'No test fails in the latest report.',
    is: t => t.failing_since !== null, sort: (a, b) => b.failing_since - a.failing_since || b.flips - a.flips },
  { id: 'flaky', label: 'Flaky', empty: 'No test went back and forth between passing and failing.',
    is: t => t.flaky, sort: (a, b) => b.flips - a.flips || b.failures - a.failures },
  { id: 'slower', label: 'Slower', empty: 'No test takes over 1.5× the time it took at the start.',
    is: t => t.slowdown !== null && t.slowdown >= SLOWER, sort: (a, b) => (b.last_time * (1 - 1 / b.slowdown)) - (a.last_time * (1 - 1 / a.slowdown)) },
  { id: 'fixed', label: 'Fixed', empty: 'No test that failed in these commits passes now.',
    is: t => t.fixed_at !== null && !t.flaky, sort: (a, b) => b.fixed_at - a.fixed_at },
  { id: 'added', label: 'Added', empty: 'Every test was already there at the start.',
    is: t => t.added_at !== null && t.removed_at === null, sort: (a, b) => b.added_at - a.added_at },
  { id: 'removed', label: 'Removed', empty: 'Every test from the start is still there.',
    is: t => t.removed_at !== null, sort: (a, b) => b.removed_at - a.removed_at },
  { id: 'slowest', label: 'Slowest', empty: 'The reports have no times.',
    is: t => t.last_time !== null && t.last_time >= MIN_TIME, sort: (a, b) => b.last_time - a.last_time },
];

// The packages of the tests (the first `depth` + 1 names of their paths, without the test's name), with how many
// tests each view has in them: [{name, path, counts: {failing: 2, ...}, total}]
export function packagesOf(tests, prefix = []) {
  const packages = new Map();
  for (const test of tests) {
    const folders = test.path.slice(0, -1);
    if (folders.length <= prefix.length || !prefix.every((name, i) => folders[i] === name)) continue;
    const name = folders[prefix.length];
    let entry = packages.get(name);
    if (!entry) {
      entry = { name, path: [...prefix, name], total: 0, counts: Object.fromEntries(VIEWS.map(v => [v.id, 0])) };
      packages.set(name, entry);
    }
    entry.total += 1;
    for (const view of VIEWS) if (view.is(test)) entry.counts[view.id] += 1;
  }
  return [...packages.values()].sort((a, b) => a.name.localeCompare(b.name));
}
export const inPackage = prefix => test => prefix.every((name, i) => test.path[i] === name) && test.path.length > prefix.length;

// The package all the tests are in: ["tests"] for tests.codec.x and tests.maps.y
export function commonPackage(tests) {
  let prefix = null;
  for (const test of tests) {
    const folders = test.path.slice(0, -1);
    if (prefix === null) { prefix = folders; continue; }
    let n = 0;
    while (n < prefix.length && n < folders.length && prefix[n] === folders[n]) n += 1;
    prefix = prefix.slice(0, n);
    if (n === 0) break;
  }
  return prefix ?? [];
}
