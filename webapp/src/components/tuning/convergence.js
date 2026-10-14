// The Analysis view's convergence plot of a `qa optimize` batch: each iteration's objective, and the best one so far.
// qa optimize minimizes the objective.

// [{iteration, objective, best}], sorted by iteration, from the batch's iterations (outputs with both metrics)
export const convergence = outputs => {
  const points = Object.values(outputs)
    .map(o => ({ iteration: o.metrics?.iteration, objective: o.metrics?.objective }))
    .filter(p => Number.isFinite(p.iteration) && Number.isFinite(p.objective))
    .sort((a, b) => a.iteration - b.iteration);
  let best = Infinity;
  return points.map(p => {
    best = Math.min(best, p.objective);
    return { ...p, best };
  });
};

// Plotly traces: the iterations as dots, the best so far as steps
export const convergence_traces = (points, colors) => [
  {
    type: 'scatter',
    mode: 'markers',
    name: 'Objective',
    x: points.map(p => p.iteration),
    y: points.map(p => p.objective),
    marker: { color: colors.dots, size: 7 },
    hovertemplate: 'iteration %{x}: %{y:.4g}<extra></extra>',
  },
  {
    type: 'scatter',
    mode: 'lines',
    name: 'Best so far',
    line: { shape: 'hv', color: colors.line, width: 2 },
    x: points.map(p => p.iteration),
    y: points.map(p => p.best),
    hovertemplate: 'best after %{x}: %{y:.4g}<extra></extra>',
  },
];
