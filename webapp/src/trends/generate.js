// Generated commits for the playground and the tests: a project that uploads its test report and its benchmarks on
// every commit of its main branch, with a history that has something to find:
// - tests are added over time, a package is removed, some tests break and stay broken, one is fixed, a few are flaky,
//   one gets slower;
// - benchmarks: one family regresses at a commit, another improves, a few are added halfway, one is removed, and
//   some commits have no benchmarks at all (the job didn't run).

// a deterministic random: the same data on every load
export function rng(seed = 7) {
  let state = seed;
  const random = () => (state = (state * 16807) % 2147483647) / 2147483647;
  const gauss = () => Math.sqrt(-2 * Math.log(random() + 1e-9)) * Math.cos(2 * Math.PI * random());
  return { random, gauss };
}

const PACKAGES = ['codec', 'planning', 'battery', 'missions', 'client', 'telemetry', 'maps', 'auth'];
const MESSAGES = ['Fix rounding in the tone curve', 'Add retries to the client', 'Refactor the planner', 'Bump dependencies', 'Speed up decode', 'Handle empty missions', 'Cache the map tiles', 'Add telemetry batching'];
const FAMILIES = { codec: ['encode', 'decode', 'roundtrip', 'entropy'], planning: ['astar', 'smooth', 'replan'], maps: ['tile_load', 'tile_render', 'index'], client: ['connect', 'send', 'receive'] };

export const TEST_DEFINITIONS = {
  tests: { label: 'Tests', group: 'Tests', aggregation: 'sum', smaller_is_better: false },
  passed: { label: 'Passed', group: 'Tests', aggregation: 'sum', part_of: 'tests', intent: 'success', smaller_is_better: false },
  failed: { label: 'Failed', group: 'Tests', aggregation: 'sum', part_of: 'tests', intent: 'danger', smaller_is_better: true },
  errors: { label: 'Errors', group: 'Tests', aggregation: 'sum', part_of: 'tests', intent: 'danger', smaller_is_better: true },
  skipped: { label: 'Skipped', group: 'Tests', aggregation: 'sum', part_of: 'tests', intent: 'none', smaller_is_better: true },
  flaky: { label: 'Flaky', group: 'Tests', aggregation: 'sum', part_of: 'tests', intent: 'warning', smaller_is_better: true },
  test_time: { label: 'Test time', group: 'Tests', aggregation: 'sum', suffix: ' s', smaller_is_better: true },
};

// {points, definitions, reports}: `reports[i]` are the tests of commit i (what the JUnit parser returns)
export function generate({ commits = 60, tests = 1200, benchmarks = 120, seed = 7 } = {}) {
  const { random, gauss } = rng(seed);
  const start = Date.UTC(2026, 9, 1);
  const definitions = { ...TEST_DEFINITIONS };

  // --- tests ---
  const cases = [];
  for (let t = 0; t < tests; t++) {
    const pkg = PACKAGES[t % PACKAGES.length];
    const module = `test_${pkg}_${Math.floor(t / 97) % 6}`;
    const name = `test_case_${t}`;
    const classname = `tests.${pkg}.${module}`;
    cases.push({
      id: `${classname}::${name}`, name, path: ['tests', pkg, module, name],
      // a third of the tests arrive over the commits
      added: t % 3 === 0 ? Math.floor(random() * commits * 0.9) : 0,
      // the auth package's legacy module is removed two thirds in
      removed: pkg === 'auth' && Math.floor(t / 97) % 6 === 1 ? Math.floor(commits * 0.66) : Infinity,
      time: random() ** 6 * 2 + 0.002,
      skipped: t % 97 === 50,
      // broken at a commit, most stay broken, some are fixed a few commits later
      broken: t % 211 === 7 ? Math.floor(commits * (0.3 + 0.6 * random())) : Infinity,
      fixed: t % 422 === 7 ? 4 : Infinity,
      flaky: t % 173 === 11 ? 0.25 : 0,
      slower: t % 389 === 5 ? Math.floor(commits * 0.5) : Infinity,
    });
  }
  const reports = [];
  const points = [];
  for (let i = 0; i < commits; i++) {
    const report = [];
    const counts = { passed: 0, failed: 0, error: 0, skipped: 0, flaky: 0 };
    let time = 0;
    for (const c of cases) {
      if (i < c.added || i >= c.removed) continue;
      let status = 'passed';
      if (c.skipped) status = 'skipped';
      else if (i >= c.broken && i < c.broken + c.fixed) status = c.id.length % 5 === 0 ? 'error' : 'failed';
      else if (c.flaky && random() < c.flaky) status = random() < 0.3 ? 'flaky' : 'failed';
      const t = status === 'skipped' ? 0 : c.time * (i >= c.slower ? 4 : 1) * (1 + 0.05 * gauss());
      report.push({ id: c.id, name: c.name, path: c.path, status, time: Math.max(t, 0) });
      counts[status] += 1;
      time += t;
    }
    reports.push(report);
    const sha = Math.floor(random() * 0xffffffff).toString(16).padStart(8, '0');
    points.push({
      id: sha,
      label: sha,
      message: MESSAGES[i % MESSAGES.length],
      date: new Date(start + i * 19 * 3600 * 1000).toISOString(),
      runs: [{
        name: 'junit.xml',
        metrics: { tests: report.length, passed: counts.passed, failed: counts.failed, errors: counts.error, skipped: counts.skipped, flaky: counts.flaky, test_time: time },
      }],
    });
  }

  // --- benchmarks ---
  const suites = Object.entries(FAMILIES).flatMap(([suite, families]) => families.map(family => ({ suite, family })));
  const regress_at = Math.floor(commits * 0.62), improve_at = Math.floor(commits * 0.35), added_at = Math.floor(commits * 0.5);
  for (let b = 0; b < benchmarks; b++) {
    const { suite, family } = suites[b % suites.length];
    const size = 2 ** (4 + Math.floor(b / suites.length) % 9);
    // past 9 sizes per family, variants: keys stay unique however many benchmarks are asked for
    const variant = Math.floor(b / (suites.length * 9));
    const name = variant ? `${family}_v${variant + 1}` : family;
    const key = `bench_${suite}_${name}_${size}`;
    definitions[key] = {
      label: `${suite}::${name}[${size}]`, short_label: `${name}[${size}]`, group: `Benchmarks/${suite}/${family}`,
      suffix: ' ms', scale: 1000, smaller_is_better: true,
    };
    const base = 10 ** (-4 + 3 * random()) * (1 + Math.log2(size) / 4);
    const noise = 0.006 + 0.02 * random();
    const added = b % 23 === 5 ? added_at : 0;
    const removed = b % 41 === 9 ? Math.floor(commits * 0.8) : Infinity;
    for (let i = 0; i < commits; i++) {
      // the benchmark job didn't run on a few commits
      if (i % 17 === 11 || i < added || i >= removed) continue;
      let value = base;
      if (suite === 'codec' && family === 'decode' && i >= regress_at) value *= 1.18 + (size > 1024 ? 0.12 : 0);
      if (suite === 'maps' && family === 'tile_load' && i >= improve_at) value *= 0.7;
      if (suite === 'planning' && family === 'astar') value *= 1 + 0.002 * i;   // a slow drift
      value *= 1 + noise * gauss();
      points[i].runs[1] ??= { name: 'pytest.benchmarks.json', metrics: {} };
      points[i].runs[1].metrics[key] = value;
    }
  }
  return { points, definitions, reports };
}
