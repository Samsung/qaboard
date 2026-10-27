// What the web app understands of an automated tuning (`qa optimize`): its iterations, its search space, how it went,
// and what users could do next. Pure functions, for OptimizationReport.jsx.
//
// `qa optimize` (qaboard/optimize.py) gives:
// - one output per evaluation, with output_type "optim_iteration": the parameters it tried (extra_parameters), and as
//   metrics its `iteration` (1-based), the `objective` it minimizes (absent when the evaluation failed) and the
//   objective's metrics, averaged over the evaluation's runs.
// - the batch's data: `iterations` (the budget), `iteration` (the last one reported), `best_iter`, `best_params`,
//   `best_metrics`, and since Optuna: `optimization_status`, `optimization_config` (search space, objective, sampler...),
//   `importances`, `pareto_front`, `evaluations_completed`, `evaluations_failed`.
// Batches tuned before Optuna have no status, config nor importances: we infer what we can.

const is_number = x => typeof x === 'number' && Number.isFinite(x);

// The evaluations, by iteration: [{iteration, objective, failed, params, metrics}]
export const iterations = outputs => Object.values(outputs ?? {})
  .filter(o => o.output_type === 'optim_iteration' && is_number(o.metrics?.iteration))
  .map(o => ({
    id: o.id,
    iteration: o.metrics.iteration,
    objective: is_number(o.metrics.objective) ? o.metrics.objective : null,
    failed: !!o.is_failed || !is_number(o.metrics.objective),
    params: o.extra_parameters ?? {},
    metrics: o.metrics,
  }))
  .sort((a, b) => a.iteration - b.iteration);

// The parameters searched: [{name, type: integer|real|categorical, low, high, log, choices}]
// Before Optuna, the batch doesn't say: we take the parameters that changed, and the range they covered.
export const search_space = (data, evaluations) => {
  const described = data?.optimization_config?.search_space;
  if (Array.isArray(described) && described.length > 0) return described;
  const values = {};
  for (const e of evaluations)
    for (const [name, value] of Object.entries(e.params))
      (values[name] ??= []).push(value);
  return Object.entries(values)
    .filter(([, v]) => new Set(v.map(x => JSON.stringify(x))).size > 1)
    .map(([name, v]) => {
      if (v.every(is_number))
        return { name, type: v.every(Number.isInteger) ? 'integer' : 'real', low: Math.min(...v), high: Math.max(...v), log: false, inferred: true };
      return { name, type: 'categorical', choices: [...new Map(v.map(x => [JSON.stringify(x), x])).values()], inferred: true };
    });
};

// Where a value sits in a parameter's range, from 0 to 1 (log-scaled for log parameters)
export const position = (dimension, value) => {
  if (!is_number(value) || dimension.type === 'categorical') return null;
  const { low, high, log } = dimension;
  if (log && low > 0 && value > 0) return (Math.log(value) - Math.log(low)) / (Math.log(high) - Math.log(low));
  return high === low ? 0.5 : (value - low) / (high - low);
};

// Running, done, stopped early... `null` when we can't tell (tuned before Optuna, without a status)
const statuses = ['running', 'done', 'stopped_early', 'failed', 'interrupted'];
export const status = (data, completed) => {
  const s = data?.optimization_status;
  if (statuses.includes(s)) return s;
  if (is_number(data?.iterations) && completed >= data.iterations) return 'done';
  return null;
};

// The search's progress and results
export const summarize = (data, evaluations) => {
  const completed = evaluations.filter(e => !e.failed);
  const failed = evaluations.filter(e => e.failed);
  let best = null;
  let running_best = Infinity;
  // the best objective after each completed evaluation, and when it last improved
  let last_improvement = null;
  for (const e of completed) {
    if (e.objective < running_best) {
      running_best = e.objective;
      best = e;
      last_improvement = e.iteration;
    }
  }
  const first = completed[0] ?? null;
  const budget = is_number(data?.iterations) ? data.iterations : null;
  const last = evaluations.length > 0 ? evaluations[evaluations.length - 1].iteration : 0;
  // Pareto mode: the search improves when the front of best trade-offs changes, i.e. when an evaluation joins it
  const pareto = !!data?.optimization_config?.pareto;
  const front = (data?.pareto_front ?? []).map(p => p.iteration);
  if (pareto && front.length > 0) last_improvement = Math.max(...front);
  return {
    status: status(data, evaluations.length),
    budget,
    evaluated: evaluations.length,
    last,
    completed: completed.length,
    failed: failed.map(e => e.iteration),
    best,
    first,
    // how much better than where it started: the objective is minimized, often negative (e.g. -mAP)
    gain: best && first ? first.objective - best.objective : null,
    last_improvement,
    since_improvement: last_improvement === null ? null : last - last_improvement,
    startup: data?.optimization_config?.sampler === 'random' ? null : (data?.optimization_config?.n_startup_trials ?? null),
    sampler: data?.optimization_config?.sampler ?? null,
    parallel: data?.optimization_config?.parallel_sampling ?? 1,
    patience: data?.optimization_config?.early_stopping ?? null,
    pareto,
    front,
    importances: data?.importances ?? null,
    started_at: data?.optimization_started_at ?? null,
    ended_at: data?.optimization_ended_at ?? null,
  };
};

// What the search tells users, and what they could do next, most important first:
// [{kind, intent, ...details}]. OptimizationReport.jsx writes the sentences.
export const insights = (summary, space) => {
  const found = [];
  const { status: s, completed, best, since_improvement, last, budget } = summary;
  const finished = s === 'done' || s === 'stopped_early';

  if (summary.failed.length > 0)
    found.push({ kind: 'failed', intent: 'warning', iterations: summary.failed });
  if (s === 'failed')
    return found;
  if (!best) return found;

  // Where the search stands. With few evaluations, it's too early to say.
  if (completed >= 6) {
    const late = since_improvement !== null && since_improvement <= Math.max(1, Math.floor(0.2 * last));
    const flat = since_improvement !== null && since_improvement >= Math.max(8, Math.ceil(0.35 * last));
    if (s === 'stopped_early')
      found.push({ kind: 'stopped_early', intent: 'success', since: since_improvement, best: summary.last_improvement, pareto: summary.pareto });
    else if (late)
      found.push({ kind: 'still_improving', intent: 'primary', best: summary.last_improvement, last, budget, running: !finished, pareto: summary.pareto });
    else if (flat)
      found.push({ kind: 'converged', intent: 'success', since: since_improvement, best: summary.last_improvement, pareto: summary.pareto });
    else if (finished)
      found.push({ kind: 'slowing', intent: 'none', since: since_improvement, best: summary.last_improvement, last, pareto: summary.pareto });
  }

  // A best value at the edge of its range: the best may be outside of it. In Pareto mode there is no single best value.
  const importances = summary.importances;
  for (const dimension of summary.pareto ? [] : space) {
    const p = position(dimension, best.params[dimension.name]);
    if (p === null || dimension.inferred) continue;
    const matters = !importances || (importances[dimension.name] ?? 0) >= 0.1;
    if (!matters) continue;
    if (p <= 0.05)
      found.push({ kind: 'edge', intent: 'warning', name: dimension.name, side: 'low', value: best.params[dimension.name], dimension });
    else if (p >= 0.95)
      found.push({ kind: 'edge', intent: 'warning', name: dimension.name, side: 'high', value: best.params[dimension.name], dimension });
  }

  // Parameters that barely matter: fixing them makes the next search faster. Not while it runs: they could still matter.
  if (s !== 'running' && importances && Object.keys(importances).length >= 2 && completed >= 10) {
    const weak = Object.entries(importances).filter(([, v]) => v < 0.05).map(([name]) => name);
    if (weak.length > 0 && weak.length < Object.keys(importances).length)
      found.push({ kind: 'unimportant', intent: 'none', names: weak });
  }

  if (s === 'running' && summary.startup && completed < summary.startup)
    found.push({ kind: 'exploring', intent: 'none', startup: summary.startup, completed });
  return found;
};

// Each metric's best value over the evaluations, and where: {metric: {value, iteration}}
// The metrics' definitions, with which way is better for those of the objective as qa optimize used it: the objective's
// `goal`, else what the code that computes them or the metrics file declared
export const objective_definitions = (available_metrics, data) => {
  const goals = Object.entries(data?.optimization_config?.objective ?? {}).filter(([, o]) => o?.goal === 'max' || o?.goal === 'min');
  if (goals.length === 0) return available_metrics;
  return {
    ...available_metrics,
    ...Object.fromEntries(goals.map(([m, o]) => [m, {
      ...(available_metrics?.[m] ?? { key: m, label: m, short_label: m, scale: 1, suffix: '' }),
      smaller_is_better: o.goal === 'min',
    }])),
  };
};

export const metric_bests = (evaluations, metrics, available_metrics) => Object.fromEntries(metrics.map(m => {
  const higher = available_metrics?.[m]?.smaller_is_better === false;
  let best = null;
  for (const e of evaluations)
    if (!e.failed && is_number(e.metrics[m]) && (best === null || (higher ? e.metrics[m] > best.value : e.metrics[m] < best.value)))
      best = { value: e.metrics[m], iteration: e.iteration };
  return [m, best];
}));

// The best parameters as preset_params for another tuning, or as `qa --tuning`
export const as_json = params => JSON.stringify(params, null, 2);
export const as_yaml = params => Object.entries(params)
  .map(([k, v]) => `  ${/^[\w.|-]+$/.test(k) ? k : JSON.stringify(k)}: ${typeof v === 'string' && /^[\w.+-]+$/.test(v) && !/^(true|false|null|yes|no|on|off|[-+]?[\d.]+(e[-+]?\d+)?)$/i.test(v) ? v : JSON.stringify(v)}`)
  .join('\n');

// The Pareto front's iterations, from the batch's data
export const pareto_iterations = data => new Set((data?.pareto_front ?? []).map(p => p.iteration));
