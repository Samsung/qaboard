/**
 * What the web app understands of a batch whose runs differ by their parameters.
 * Run with: cd webapp && npm test -- analysis
 */
import { analyze, compare, insights, is_tuning, tuning_kind, varying_metrics, pareto_front, as_search_space, set_filter, flatten } from '../analysis';
import { filter_batch } from '../../../utils';

let next_id = 1;
const run = (input, params, metrics, extra = {}) => ({
  id: next_id++, test_input_path: input, configurations: ['base'], params, metrics, ...extra,
});
// 3 thresholds by 2 modes on 2 images: the loss is lowest at threshold 2, "fast" costs 1, b.jpg is harder
const grid = () => [1, 2, 3].flatMap(threshold => ['fast', 'slow'].flatMap(mode => ['a.jpg', 'b.jpg'].map(input => run(
  input, { threshold, mode },
  { loss: (threshold - 2) ** 2 + (mode === 'fast' ? 1 : 0) + (input === 'b.jpg' ? 10 : 0), time: mode === 'fast' ? 1 : 5 },
))));

describe('analyze', () => {
  it('groups runs by the parameters that change, and averages each set over its tests', () => {
    const analysis = analyze([...grid(), run('c.jpg', { threshold: 1, mode: 'fast' }, { loss: 100 }, { is_failed: true })]);
    expect(analysis.parameters.map(p => [p.name, p.type, p.values])).toEqual([
      ['threshold', 'integer', [1, 2, 3]],
      ['mode', 'categorical', ['fast', 'slow']],
    ]);
    expect(analysis.sets).toHaveLength(6);
    expect(analysis.tests).toHaveLength(3);
    expect(analysis.runs).toEqual({ total: 13, done: 12, failed: 1, pending: 0 });
    const best = analysis.sets.find(s => s.params.threshold === 2 && s.params.mode === 'slow');
    expect(best.metrics).toEqual({ loss: 5, time: 5 });
    expect(best.counts.loss).toBe(2);
    expect(is_tuning(analysis)).toBe(true);
    expect(analysis.confounded).toBe(false);
  });

  it('uses the median when asked', () => {
    const outputs = [1, 2, 30].map((loss, i) => run(`${i}.jpg`, { x: 1 }, { loss })).concat(run('0.jpg', { x: 2 }, { loss: 0 }));
    expect(analyze(outputs, { aggregation: 'median' }).sets[0].metrics.loss).toBe(2);
    expect(analyze(outputs).sets[0].metrics.loss).toBe(11);
  });

  it('ignores parameters that never change, and batches without tuning', () => {
    const analysis = analyze([run('a.jpg', { x: 1 }, { loss: 1 }), run('b.jpg', { x: 1 }, { loss: 2 })]);
    expect(analysis.parameters).toEqual([]);
    expect(is_tuning(analysis)).toBe(false);
  });

  it('knows the runs without the parameters as the defaults, and nested parameters by their dotted name', () => {
    expect(flatten({ denoise: { strength: 2 }, lut: [1, 2] })).toEqual({ 'denoise.strength': 2, lut: [1, 2] });
    const analysis = analyze([run('a.jpg', {}, { loss: 3 }), run('a.jpg', { denoise: { strength: 2 } }, { loss: 1 })]);
    expect(analysis.parameters[0]).toMatchObject({ name: 'denoise.strength', has_default: true });
    expect(analysis.sets.find(s => s.is_default).metrics.loss).toBe(3);
    const comparison = compare(analysis, 'loss', 'min');
    expect(comparison.baseline.is_default).toBe(true);
    expect(comparison.best.params).toEqual({ 'denoise.strength': 2 });
  });

  it('says when the parameters only differ between tests', () => {
    const analysis = analyze([run('a.jpg', { x: 1 }, { loss: 1 }), run('b.jpg', { x: 2 }, { loss: 2 })]);
    expect(analysis.confounded).toBe(true);
    expect(insights(analysis, compare(analysis, 'loss', 'min')).map(i => i.kind)).toContain('confounded');
  });

  it('leaves the iterations of automated tunings to their own report', () => {
    expect(analyze([{ ...run('a.jpg', { x: 1 }, { objective: 1 }), output_type: 'optim_iteration' }]).sets).toEqual([]);
    expect(tuning_kind({ data: { optimization: true }, outputs: { 1: { output_type: 'optim_iteration' } } })).toEqual({ kind: 'automated', evaluations: 1 });
    expect(tuning_kind({ outputs: Object.fromEntries(grid().map(o => [o.id, o])) })).toMatchObject({ kind: 'manual', sets: 6, tests: 2, has_metrics: true });
    expect(tuning_kind({ outputs: {} })).toBeNull();
  });
});

describe('compare', () => {
  it('ranks the parameter sets, the best first, whichever way is better', () => {
    const analysis = analyze(grid());
    const comparison = compare(analysis, 'loss', 'min');
    expect(comparison.best.params).toEqual({ threshold: 2, mode: 'slow' });
    expect(comparison.ranked).toHaveLength(6);
    expect(comparison.worst.metrics.loss).toBe(7);
    expect(comparison.wins).toBe(2);
    expect(compare(analysis, 'loss', 'max').best.metrics.loss).toBe(7);
    // without knowing which way is better, there is no best
    expect(compare(analysis, 'loss', null).best).toBeNull();
  });

  it('says how much each parameter matters', () => {
    const { importances } = compare(analyze(grid()), 'time', 'min');
    expect(importances.mode).toBeCloseTo(1);
    expect(importances.threshold).toBe(0);
  });

  it("doesn't rank the sets that miss tests", () => {
    const outputs = grid().filter(o => !(o.params.threshold === 2 && o.params.mode === 'slow' && o.test_input_path === 'b.jpg'));
    const analysis = analyze(outputs);
    const comparison = compare(analysis, 'loss', 'min');
    expect(comparison.partial).toHaveLength(1);
    // it ran on the easy image only: its average of 0 would win
    expect(comparison.best.metrics.loss).toBe(6);
    expect(comparison.partial[0].metrics.loss).toBe(0);
    expect(insights(analysis, comparison).map(i => i.kind)).toContain('partial');
  });

  it('finds the tests where the best on average loses', () => {
    // x=1 is the best on average, but loses on c.jpg
    const outputs = [
      run('a.jpg', { x: 1 }, { loss: 1 }), run('b.jpg', { x: 1 }, { loss: 1 }), run('c.jpg', { x: 1 }, { loss: 5 }),
      run('a.jpg', { x: 2 }, { loss: 3 }), run('b.jpg', { x: 2 }, { loss: 3 }), run('c.jpg', { x: 2 }, { loss: 2 }),
    ];
    const comparison = compare(analyze(outputs), 'loss', 'min');
    expect(comparison.wins).toBe(2);
    expect(comparison.regrets).toHaveLength(1);
    expect(comparison.regrets[0]).toMatchObject({ value: 5, best: 2 });
  });
});

describe('insights', () => {
  const kinds = outputs => {
    const analysis = analyze(outputs);
    return insights(analysis, compare(analysis, 'loss', 'min')).map(i => i.kind);
  };

  it('says when the best value is at the edge of what was tried, and suggests a search', () => {
    const outputs = [1, 2, 3, 4].flatMap(x => ['a.jpg', 'b.jpg'].map(input => run(input, { x }, { loss: 10 - x })));
    const analysis = analyze(outputs);
    const comparison = compare(analysis, 'loss', 'min');
    const found = insights(analysis, comparison);
    expect(found.find(i => i.kind === 'edge')).toMatchObject({ name: 'x', side: 'high', value: 4 });
    expect(found.at(-1).kind).toBe('automate');
    // the search starts wider on the side where the best was
    expect(as_search_space(analysis, comparison)).toEqual([{ kind: 'Integer', name: 'x', low: 1, high: 6, log: false }]);
  });

  it('says when nothing changes the metric, when runs failed, and when one test was used', () => {
    expect(kinds([1, 2, 3].map(x => run('a.jpg', { x }, { loss: 100 + x / 100 })))).toEqual(['flat']);
    expect(kinds([...grid(), run('c.jpg', { threshold: 1, mode: 'fast' }, {}, { is_failed: true })])[0]).toBe('failed');
    expect(kinds([1, 2, 3].map(x => run('a.jpg', { x }, { loss: (x - 2) ** 2 + 1 })))).toEqual(['one_test', 'automate']);
  });
});

describe('helpers', () => {
  it('lists the metrics that change between sets, the preferred first', () => {
    const outputs = [...grid()].map(o => ({ ...o, metrics: { ...o.metrics, constant: 1 } }));
    expect(varying_metrics(analyze(outputs), ['time'])).toEqual(['time', 'loss']);
  });

  it('finds the best trade-offs', () => {
    const analysis = analyze(grid());
    const front = pareto_front(analysis.sets, ['loss', 'time'], ['min', 'min']).map(id => analysis.sets.find(s => s.id === id).params);
    expect(front).toEqual(expect.arrayContaining([{ threshold: 2, mode: 'fast' }, { threshold: 2, mode: 'slow' }]));
    expect(front).toHaveLength(2);
  });

  it("filters a parameter set's runs exactly", () => {
    const outputs = [run('a.jpg', { x: 0.3, mode: 'fast' }, {}), run('a.jpg', { x: 0.35, mode: 'fast' }, {}), run('a.jpg', { x: 0.3, mode: 'faster' }, {})];
    const analysis = analyze(outputs);
    const filter = set_filter(analysis.sets[0]);
    const batch = { outputs: Object.fromEntries(outputs.map(o => [o.id, { ...o, configurations_str: '["base"]' }])) };
    expect(filter_batch(batch, filter).outputs).toEqual([String(outputs[0].id)]);
  });
});
