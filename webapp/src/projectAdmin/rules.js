// The quality gate's rules, as qaboard.yaml writes them ({metric, max_regression: "5%", aggregate}) and as the
// Quality gate page shows and edits them: one row per limit, {metric, kind, limit, aggregate}.

// The limits a rule can have, in the order `qa gate` checks them
export const rule_kinds = ['max_regression', 'per_test_max_regression', 'min', 'max'];
export const aggregates = ['median', 'mean', 'min', 'max'];
export const default_aggregate = 'median';

// Relative limits ("5%"), the others are values of the metric
export const is_regression_kind = kind => kind === 'max_regression' || kind === 'per_test_max_regression';
// per_test_max_regression checks each test: it doesn't aggregate them
export const has_aggregate = kind => kind !== 'per_test_max_regression';

// "median may get worse by at most"
export const check_text = (kind, aggregate) => {
  const what = aggregate || default_aggregate;
  if (kind === 'max_regression') return `${what} may get worse by at most`;
  if (kind === 'per_test_max_regression') return 'each test may get worse by at most';
  if (kind === 'min') return `${what} is at least`;
  if (kind === 'max') return `${what} is at most`;
  return String(kind ?? '');
};

// 0.07 * 100 is 7.000000000000001
const percent = fraction => `${Number((fraction * 100).toPrecision(10))}%`;

// A limit, for people: regressions as percentages ("1%" for 0.01, or as it was written), the others as they are
export const limit_text = (kind, limit) => {
  if (limit === null || limit === undefined || limit === '') return '';
  if (!is_regression_kind(kind)) return String(limit);
  if (typeof limit === 'string' && limit.trim().endsWith('%')) return limit.trim();
  const fraction = Number(limit);
  return Number.isFinite(fraction) ? percent(fraction) : String(limit);
};

// Saved rules can have several limits ({metric, max_regression, min}): one row per limit, with the value as written
export const rule_rows = rules => (Array.isArray(rules) ? rules : [])
  .filter(rule => rule && typeof rule === 'object')
  .flatMap(rule => {
    const kinds = rule_kinds.filter(kind => kind in rule);
    // a rule without a limit isn't valid: still a row, to give it one
    return (kinds.length > 0 ? kinds : [rule_kinds[0]]).map(kind => ({
      metric: String(rule.metric ?? ''),
      kind,
      limit: rule[kind] ?? '',
      aggregate: has_aggregate(kind) ? rule.aggregate ?? default_aggregate : null,
    }));
  });


// What the editor holds: the limits and the failed runs as the text owners type
export const new_rule = () => ({ metric: '', kind: 'max_regression', limit: '', aggregate: default_aggregate });

export const form_from_gate = gate => ({
  rules: rule_rows(gate?.rules).map(row => ({ ...row, limit: String(row.limit), aggregate: row.aggregate ?? default_aggregate })),
  // empty: no limit from the project
  max_failed_runs: gate?.max_failed_runs === null || gate?.max_failed_runs === undefined ? '' : String(gate.max_failed_runs),
  require_bit_accuracy: !!gate?.require_bit_accuracy,
  on_looser_rules: gate?.on_looser_rules === 'fail' ? 'fail' : 'warn',
});

// Numbers as numbers. What isn't one is sent as typed: the server says what's wrong with it
const number_or_text = text => {
  const number = Number(text);
  return text !== '' && Number.isFinite(number) ? number : text;
};

// The settings to save, in qaboard.yaml's format: one rule per row. Rows left empty are skipped.
export const gate_from_form = form => ({
  rules: form.rules
    .map(row => ({ ...row, metric: row.metric.trim(), limit: row.limit.trim() }))
    .filter(row => row.metric !== '' || row.limit !== '')
    .map(({ metric, kind, limit, aggregate }) => ({
      metric,
      [kind]: is_regression_kind(kind) ? limit : number_or_text(limit),
      // the median is the default
      ...(has_aggregate(kind) && aggregate && aggregate !== default_aggregate ? { aggregate } : {}),
    })),
  max_failed_runs: form.max_failed_runs.trim() === '' ? null : number_or_text(form.max_failed_runs.trim()),
  require_bit_accuracy: form.require_bit_accuracy,
  on_looser_rules: form.on_looser_rules,
});
