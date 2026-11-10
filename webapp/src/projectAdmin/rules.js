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

// A rule's `batch` and `label`: a name, a list, or shell patterns ("perf-*"). null: every run, every label
export const names_of = value => {
  if (value === null || value === undefined || value === '') return null;
  const names = (Array.isArray(value) ? value : [value]).map(name => String(name).trim()).filter(name => name !== '');
  return names.length > 0 ? names : null;
};

// Which runs a rule checks, for people: "only `qa batch perf`", "only the label nightly", null for all
export const scope_parts = ({ batch, label }) => {
  const batches = names_of(batch);
  const labels = names_of(label);
  return [
    ...(batches ? [{ what: 'batch', text: 'only ', names: batches.map(name => `qa batch ${name}`) }] : []),
    ...(labels ? [{ what: 'label', text: labels.length > 1 ? 'only the labels ' : 'only the label ', names: labels }] : []),
  ];
};
export const scope_text = rule => {
  const parts = scope_parts(rule);
  if (parts.length === 0) return null;
  return parts.map(part => part.text + part.names.join(part.what === 'batch' ? ' or ' : ', ')).join(', ');
};

// Saved rules can have several limits ({metric, max_regression, min}): one row per limit, with the value as written
export const rule_rows = rules => (Array.isArray(rules) ? rules : [])
  .filter(rule => rule && typeof rule === 'object')
  .flatMap(rule => {
    const kinds = rule_kinds.filter(kind => kind in rule);
    // a rule without a limit isn't valid: still a row, to give it one
    const batch = names_of(rule.batch);
    const label = names_of(rule.label);
    return (kinds.length > 0 ? kinds : [rule_kinds[0]]).map(kind => ({
      metric: String(rule.metric ?? ''),
      kind,
      limit: rule[kind] ?? '',
      aggregate: has_aggregate(kind) ? rule.aggregate ?? default_aggregate : null,
      // only for rules on some batches or labels
      ...(batch ? { batch } : {}),
      ...(label ? { label } : {}),
    }));
  });


// `expect_batches`, the batches that must have runs: a list for every label ("ci, perf"), or a list per label
// ("default: ci, perf; nightly: all"), as owners type them
export const expect_batches_text = expect => {
  if (Array.isArray(expect) || typeof expect === 'string') return (names_of(expect) ?? []).join(', ');
  if (!expect || typeof expect !== 'object') return '';
  const entries = Object.entries(expect).map(([label, batches]) => [label, names_of(batches) ?? []]).filter(([, batches]) => batches.length > 0);
  // what qa gate reads from a list: every label ('*')
  if (entries.length === 1 && entries[0][0] === '*') return entries[0][1].join(', ');
  return entries.map(([label, batches]) => `${label}: ${batches.join(', ')}`).join('; ');
};

const split_names = text => text.split(',').map(name => name.trim()).filter(name => name !== '');

export const expect_batches_from_text = text => {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  if (!trimmed.includes(':')) return split_names(trimmed);
  const expect = {};
  for (const part of trimmed.split(';')) {
    const [label, ...rest] = part.split(':');
    if (label.trim() === '' && rest.length === 0) continue;
    expect[label.trim()] = split_names(rest.join(':'));
  }
  return expect;
};


// What the editor holds: the limits and the failed runs as the text owners type
export const new_rule = () => ({ metric: '', kind: 'max_regression', limit: '', aggregate: default_aggregate, batch: '', label: '' });

export const form_from_gate = gate => ({
  rules: rule_rows(gate?.rules).map(row => ({
    ...row, limit: String(row.limit), aggregate: row.aggregate ?? default_aggregate,
    batch: (row.batch ?? []).join(', '), label: (row.label ?? []).join(', '),
  })),
  // empty: no limit from the project
  max_failed_runs: gate?.max_failed_runs === null || gate?.max_failed_runs === undefined ? '' : String(gate.max_failed_runs),
  require_bit_accuracy: !!gate?.require_bit_accuracy,
  on_looser_rules: gate?.on_looser_rules === 'fail' ? 'fail' : 'warn',
  expect_batches: expect_batches_text(gate?.expect_batches),
});

// "perf" for one name, as qaboard.yaml usually writes it, a list for several
const names_value = text => {
  const names = split_names(text ?? '');
  if (names.length === 0) return null;
  return names.length === 1 ? names[0] : names;
};

// Numbers as numbers. What isn't one is sent as typed: the server says what's wrong with it
const number_or_text = text => {
  const number = Number(text);
  return text !== '' && Number.isFinite(number) ? number : text;
};

// The settings to save, in qaboard.yaml's format: one rule per row. Rows left empty are skipped.
// Rules without a scope, and settings without expect_batches, are written as before.
export const gate_from_form = form => {
  const expect_batches = expect_batches_from_text(form.expect_batches ?? '');
  return {
    rules: form.rules
      .map(row => ({ ...row, metric: row.metric.trim(), limit: row.limit.trim() }))
      .filter(row => row.metric !== '' || row.limit !== '')
      .map(({ metric, kind, limit, aggregate, batch, label }) => {
        const batches = names_value(batch);
        const labels = names_value(label);
        return {
          metric,
          [kind]: is_regression_kind(kind) ? limit : number_or_text(limit),
          // the median is the default
          ...(has_aggregate(kind) && aggregate && aggregate !== default_aggregate ? { aggregate } : {}),
          ...(batches ? { batch: batches } : {}),
          ...(labels ? { label: labels } : {}),
        };
      }),
    max_failed_runs: form.max_failed_runs.trim() === '' ? null : number_or_text(form.max_failed_runs.trim()),
    require_bit_accuracy: form.require_bit_accuracy,
    on_looser_rules: form.on_looser_rules,
    ...(expect_batches ? { expect_batches } : {}),
  };
};
