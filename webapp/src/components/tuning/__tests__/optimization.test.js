/**
 * What the web app understands of an automated tuning. The batches come from webapp/e2e/fixtures/make_tuning.py,
 * which runs qa optimize's engine: they are what the API returns.
 * Run with: cd webapp && npm test -- optimization
 */
import batches from '../../../../e2e/fixtures/tuning.json';
import { iterations, search_space, position, summarize, insights, as_yaml, metric_bests, pareto_iterations } from '../optimization';

const analyze = label => {
  const batch = batches[label];
  const evaluations = iterations(batch.outputs);
  const space = search_space(batch.data, evaluations);
  const summary = summarize(batch.data, evaluations);
  return { batch, evaluations, space, summary, found: insights(summary, space) };
};
const kinds = found => found.map(i => i.kind);

describe('iterations', () => {
  it("keeps the evaluations, sorted, and says which failed", () => {
    const { evaluations } = analyze('tune-int8');
    expect(evaluations).toHaveLength(40);
    expect(evaluations.map(e => e.iteration)).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
    // the best iteration's runs, moved into the batch, are not evaluations
    expect(evaluations.every(e => e.id.includes('iter'))).toBe(true);
    const failed = evaluations.filter(e => e.failed);
    expect(failed.map(e => e.iteration)).toEqual([13]);
    expect(failed[0].objective).toBeNull();
  });
});

describe('search_space', () => {
  it("is the batch's when qa optimize sent it", () => {
    const { space } = analyze('tune-int8');
    expect(space.map(d => d.name)).toEqual(['quant_percentile', 'quant_keep_fp32', 'score_threshold', 'nms_iou']);
    expect(space[0]).toEqual({ name: 'quant_percentile', type: 'categorical', choices: [99.9, 99.99, 99.999] });
  });

  it('is inferred for tunings from before Optuna', () => {
    const evaluations = [
      { params: { x: 0.2, mode: 'a', fixed: 1 } },
      { params: { x: 0.8, mode: 'b', fixed: 1 } },
    ];
    expect(search_space({}, evaluations)).toEqual([
      { name: 'x', type: 'real', low: 0.2, high: 0.8, log: false, inferred: true },
      { name: 'mode', type: 'categorical', choices: ['a', 'b'], inferred: true },
    ]);
  });
});

describe('position', () => {
  it('is linear, or logarithmic for log parameters', () => {
    expect(position({ type: 'real', low: 0, high: 10 }, 5)).toBe(0.5);
    expect(position({ type: 'real', low: 1, high: 100, log: true }, 10)).toBeCloseTo(0.5);
    expect(position({ type: 'categorical', choices: [1] }, 1)).toBeNull();
  });
});

describe('summarize', () => {
  it('finds the best evaluation, and when the search last improved', () => {
    const { summary, evaluations } = analyze('tune-int8');
    const best = evaluations.filter(e => !e.failed).reduce((a, b) => (b.objective < a.objective ? b : a));
    expect(summary.best.iteration).toBe(best.iteration);
    expect(summary.last_improvement).toBe(best.iteration);
    expect(summary.since_improvement).toBe(40 - best.iteration);
    expect(summary.status).toBe('done');
    expect(summary.budget).toBe(40);
    expect(summary.completed).toBe(39);
    expect(summary.failed).toEqual([13]);
    expect(summary.gain).toBeGreaterThan(0);
    expect(summary.startup).toBe(8);
    expect(summary.sampler).toBe('tpe');
  });

  it('in Pareto mode, improves when the front changes', () => {
    const { summary, batch } = analyze('tune-int8-tradeoffs');
    expect(summary.pareto).toBe(true);
    const front = batch.data.pareto_front.map(p => p.iteration);
    expect(summary.front).toEqual(front);
    expect(summary.last_improvement).toBe(Math.max(...front));
  });

  it("can't tell the status of tunings from before Optuna, unless they used their budget", () => {
    expect(summarize({ iterations: 10 }, []).status).toBeNull();
    const evaluations = Array.from({ length: 10 }, (_, i) => ({ iteration: i + 1, objective: 1, failed: false, params: {}, metrics: {} }));
    expect(summarize({ iterations: 10 }, evaluations).status).toBe('done');
  });
});

describe('insights', () => {
  it('a finished search: failures, a verdict, a best value at the edge, parameters that barely matter', () => {
    const { found, summary } = analyze('tune-int8');
    expect(kinds(found)[0]).toBe('failed');
    expect(found[0].iterations).toEqual([13]);
    expect(kinds(found)).toContain('unimportant');
    // one verdict on where the search stands
    expect(kinds(found).filter(k => ['still_improving', 'converged', 'slowing', 'stopped_early'].includes(k))).toHaveLength(1);
    // its best score_threshold is at the bottom of the range
    const edge = found.find(i => i.kind === 'edge');
    expect(edge).toMatchObject({ name: 'score_threshold', side: 'low' });
    expect(position(edge.dimension, summary.best.params[edge.name])).toBeLessThanOrEqual(0.05);
  });

  it('a running search: no advice to change it yet', () => {
    const { found } = analyze('tune-int8-running');
    expect(kinds(found)).not.toContain('unimportant');
    expect(kinds(found)).not.toContain('slowing');
  });

  it('Pareto mode: no single best value at the edge of its range', () => {
    const { found } = analyze('tune-int8-tradeoffs');
    expect(kinds(found)).not.toContain('edge');
  });

  const run = (objectives, data = {}) => {
    const evaluations = objectives.map((objective, i) => ({ iteration: i + 1, objective, failed: false, params: { x: 0.5 }, metrics: {} }));
    const space = [{ name: 'x', type: 'real', low: 0, high: 1, log: false }];
    return kinds(insights(summarize({ iterations: objectives.length, optimization_status: 'done', ...data }, evaluations), space));
  };

  it('says when the search is still improving at the end', () => {
    expect(run([5, 4, 4.5, 4.2, 3, 3.5, 3.1, 2.9, 2.5, 2])).toContain('still_improving');
  });

  it('says when it converged', () => {
    expect(run([5, 1, ...Array(18).fill(2)])).toContain('converged');
  });

  it('says when it stopped early', () => {
    expect(run([5, 1, ...Array(10).fill(2)], { optimization_status: 'stopped_early' })).toContain('stopped_early');
  });

  it('waits for a few evaluations before judging', () => {
    expect(run([3, 2, 1])).toEqual([]);
  });

  it('flags a best value at the edge, for parameters that matter', () => {
    const evaluations = Array.from({ length: 10 }, (_, i) => ({ iteration: i + 1, objective: i === 4 ? 0 : 1, failed: false, params: { x: i === 4 ? 0.99 : 0.5, y: 0.5 }, metrics: {} }));
    const space = [{ name: 'x', type: 'real', low: 0, high: 1 }, { name: 'y', type: 'real', low: 0, high: 1 }];
    const summary = summarize({ iterations: 10, optimization_status: 'done', importances: { x: 0.9, y: 0.1 } }, evaluations);
    const found = insights(summary, space);
    expect(found.filter(i => i.kind === 'edge').map(i => [i.name, i.side])).toEqual([['x', 'high']]);
    // when it barely matters, its edge isn't worth a warning
    const unimportant = insights({ ...summary, importances: { x: 0.02, y: 0.98 } }, space);
    expect(unimportant.filter(i => i.kind === 'edge')).toEqual([]);
  });
});

describe('copying the best parameters', () => {
  it('writes YAML that reads back as the same values', () => {
    expect(as_yaml({ a: 1, b: 'none', c: 'yes', d: '1e3', 'my block|x': 0.5, e: 99.999 })).toBe([
      '  a: 1',
      '  b: none',
      '  c: "yes"',
      '  d: "1e3"',
      '  "my block|x": 0.5',
      '  e: 99.999',
    ].join('\n'));
  });
});

describe('metric_bests', () => {
  it("follows each metric's direction", () => {
    const evaluations = [
      { iteration: 1, failed: false, metrics: { ap: 0.2, mb: 9 } },
      { iteration: 2, failed: false, metrics: { ap: 0.3, mb: 12 } },
      { iteration: 3, failed: true, metrics: {} },
    ];
    const bests = metric_bests(evaluations, ['ap', 'mb'], { ap: { smaller_is_better: false }, mb: { smaller_is_better: true } });
    expect(bests).toEqual({ ap: { value: 0.3, iteration: 2 }, mb: { value: 9, iteration: 1 } });
  });
});

describe('pareto_iterations', () => {
  it('reads the front from the batch', () => {
    expect(pareto_iterations({ pareto_front: [{ iteration: 3 }, { iteration: 7 }] })).toEqual(new Set([3, 7]));
    expect(pareto_iterations({})).toEqual(new Set());
  });
});
