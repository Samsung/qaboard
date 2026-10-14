import { convergence, convergence_traces } from '../convergence';

describe('convergence', () => {
  it('sorts the iterations and keeps the best objective so far', () => {
    const outputs = {
      a: { metrics: { iteration: 3, objective: -0.5 } },
      b: { metrics: { iteration: 1, objective: -0.45 } },
      c: { metrics: { iteration: 2, objective: -0.4 } },
      d: { metrics: { iteration: 4, objective: -0.48 } },
      // not an iteration
      e: { metrics: { map: 0.3 } },
    };
    expect(convergence(outputs)).toEqual([
      { iteration: 1, objective: -0.45, best: -0.45 },
      { iteration: 2, objective: -0.4, best: -0.45 },
      { iteration: 3, objective: -0.5, best: -0.5 },
      { iteration: 4, objective: -0.48, best: -0.5 },
    ]);
  });

  it('gives a trace of dots and one of steps', () => {
    const traces = convergence_traces(convergence({ a: { metrics: { iteration: 1, objective: 2 } } }), { dots: 'gray', line: 'blue' });
    expect(traces.map(t => t.name)).toEqual(['Objective', 'Best so far']);
    expect(traces[1].line.shape).toBe('hv');
    expect(traces[0].y).toEqual([2]);
  });
});
