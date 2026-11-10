"""
`qa gate`: fails the CI when quality regresses against a reference. Experimental: may change without notice.

The rules are in the `gate:` section of qaboard.yaml. The numbers come from the server
(GET /api/v1/commit/<sha>/compare), and are the ones the web app's Summary and Metrics Diff show.

Exit codes: 0 pass, 1 fail (a rule failed, or the gate's configuration has an error),
2 undecidable (the reference or the runs are missing or still running, the server can't be reached).
"""
import os
import re
import sys
import json
import math
from fnmatch import fnmatchcase
import statistics
import time
from pathlib import Path
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Mapping, Optional, Tuple
from urllib.parse import quote, urlencode

import click


EXIT_CODES = {'pass': 0, 'fail': 1, 'undecidable': 2}
EXPERIMENTAL_NOTICE = "qa gate is experimental: its configuration and output may change without notice."

# `labels` was named `batches`, which reads like `qa batch <name>`: still accepted
GATE_KEYS = {'reference', 'labels', 'batches', 'expect_batches', 'rules', 'max_failed_runs', 'require_bit_accuracy'}
RULE_KINDS = ('max_regression', 'per_test_max_regression', 'min', 'max')
# What a rule can be limited to: the runs of some `qa batch <name>`, or some labels (`qa --label`)
RULE_SCOPES = ('batch', 'label')
# How the rules on all the runs (min, max, max_regression) aggregate them. The server gives medians, the others are
# computed from each test's values: e.g. `max` for 0/1 metrics that no test may have.
AGGREGATES = ('median', 'mean', 'min', 'max')

# Floating point noise should not decide a verdict: a 10.0000000001% regression is a 10% regression
EPSILON = 1e-9


class GateConfigError(ValueError):
  pass


def matches(name: Optional[str], patterns: List[str]) -> bool:
  """Whether a batch's or label's name is one of the names or shell patterns (`perf-*`)"""
  return name is not None and any(fnmatchcase(str(name), pattern) for pattern in patterns)


@dataclass
class Rule:
  metric: str
  kind: str  # one of RULE_KINDS
  limit: float
  aggregate: Optional[str] = None  # one of AGGREGATES, None for per_test_max_regression
  # None: every run of every label checked. Else names or patterns
  batch: Optional[List[str]] = None
  label: Optional[List[str]] = None

  def to_dict(self) -> Dict[str, Any]:
    rule: Dict[str, Any] = {'metric': self.metric, 'kind': self.kind, 'limit': self.limit}
    if self.aggregate is not None:
      rule['aggregate'] = self.aggregate
    if self.batch is not None:
      rule['batch'] = self.batch
    if self.label is not None:
      rule['label'] = self.label
    return rule

  def applies_to(self, label_names: List[str]) -> bool:
    """Whether the rule is about the label being checked (any of its names, see names_of_label)"""
    return self.label is None or any(matches(name, self.label) for name in label_names)

  @property
  def identity(self) -> Tuple[Any, ...]:
    """What makes it the same rule in another qaboard.yaml: its limit can change, not what it checks"""
    return (self.metric, self.kind, self.aggregate, tuple(self.batch or ()), tuple(self.label or ()))


def names_of_label(requested: Optional[str], resolved: Optional[str] = None) -> List[str]:
  """
  The names of the label being checked: as given to the gate, and as the server found it. `ci` names the CI's
  results, whose label is `default`.
  """
  names = [str(n) for n in (requested, resolved) if n]
  if not names or any(n == 'default' or n.lower() == 'ci' for n in names):
    names += ['default', 'ci']
  return list(dict.fromkeys(names))


def section_label(label: Any) -> str:
  """The comment's sections have the same label whether a job said `ci` or `default`"""
  return 'default' if str(label).lower() == 'ci' else str(label)


@dataclass
class GateConfig:
  reference: Optional[str] = None
  # the labels to check, as `qa --label` sets them
  labels: List[str] = field(default_factory=lambda: ['default'])
  rules: List[Rule] = field(default_factory=list)
  # {label or pattern: [batch names or patterns]}: the batches that must have runs before the gate decides.
  # A list in qaboard.yaml applies to every label: {'*': [...]}
  expect_batches: Dict[str, List[str]] = field(default_factory=dict)
  max_failed_runs: Optional[int] = 0
  require_bit_accuracy: bool = False
  # What the project's owners set in the web app (docs/rfcs/project-admin.md), learned from the server with the
  # numbers: rules checked on top of ours, that no commit can change. None until we know, or if they set none.
  project: Optional['GateConfig'] = None
  # When our rules are looser than the reference's: 'warn' says so, 'fail' fails the gate. The project decides.
  on_looser_rules: str = 'warn'

  @property
  def batches(self) -> List[str]:
    """The labels' older name, that scripts may use"""
    return self.labels

  @batches.setter
  def batches(self, labels: List[str]) -> None:
    self.labels = labels

  def expected_batches(self, label_names: List[str]) -> Tuple[List[str], bool]:
    """The batches that must have runs in this label, ours and the project's, and whether they're only the project's"""
    def of(expect: Dict[str, List[str]]) -> List[str]:
      return [b for key, batches in expect.items() if any(fnmatchcase(name, key) for name in label_names) for b in batches]
    ours = of(self.expect_batches)
    project = of(self.project.expect_batches) if self.project else []
    return list(dict.fromkeys([*ours, *project])), bool(project) and not ours

  @property
  def metrics(self) -> List[str]:
    """The metrics the rules need, ours and the project's"""
    rules = [*self.rules, *(self.project.rules if self.project else [])]
    return list(dict.fromkeys(rule.metric for rule in rules))

  @property
  def needs_bit_accuracy(self) -> bool:
    return self.require_bit_accuracy or bool(self.project and self.project.require_bit_accuracy)

  @property
  def failed_runs_limit(self) -> Tuple[Optional[int], Optional[str]]:
    """How many runs may fail: the stricter of our limit and the project's, and 'project' when it's the project's"""
    ours, project = self.max_failed_runs, self.project.max_failed_runs if self.project else None
    if project is not None and (ours is None or project < ours):
      return project, 'project'
    return ours, None


ON_LOOSER_RULES = ('warn', 'fail')
# What the project's settings can have (the server validates them with this module: one list). Not `reference` or
# `labels`: those say what a commit is compared with.
PROJECT_GATE_KEYS = ('rules', 'max_failed_runs', 'require_bit_accuracy', 'on_looser_rules', 'expect_batches')


def apply_project_gate(gate: GateConfig, project_gate: Any) -> bool:
  """
  Adds the project's settings, as the server gives them, to the gate. Returns whether we must ask the server again:
  the project's rules need metrics we didn't ask for, or the comparison of the runs' files.
  Raises GateConfigError if we can't read them: a newer server's settings must not be half-applied.
  """
  if not isinstance(project_gate, dict):
    return False
  asked_metrics, asked_bit_accuracy = set(gate.metrics), gate.needs_bit_accuracy
  unknown = set(project_gate) - set(PROJECT_GATE_KEYS)
  if unknown:
    raise GateConfigError(f"the project's gate settings have keys this version of qa doesn't know ({', '.join(sorted(unknown))}): upgrade qaboard")
  try:
    project = parse_config({'gate': {
      'rules': project_gate.get('rules') or [],
      'max_failed_runs': project_gate.get('max_failed_runs'),
      'require_bit_accuracy': bool(project_gate.get('require_bit_accuracy')),
      'expect_batches': project_gate.get('expect_batches'),
    }})
  except GateConfigError as e:
    raise GateConfigError(f"the project's gate settings, set in the web app: {e}")
  on_looser_rules = project_gate.get('on_looser_rules') or 'warn'
  if on_looser_rules not in ON_LOOSER_RULES:
    raise GateConfigError(f"the project's gate settings: on_looser_rules is {on_looser_rules!r}, this version of qa knows {', '.join(ON_LOOSER_RULES)}: upgrade qaboard")
  gate.project, gate.on_looser_rules = project, on_looser_rules
  # without rules of our own we asked for every metric
  needs_metrics = bool(asked_metrics) and not set(gate.metrics) <= asked_metrics
  return needs_metrics or (gate.needs_bit_accuracy and not asked_bit_accuracy)


def parse_fraction(value: Any, where: str) -> float:
  """A relative change: `5%`, or a fraction like 0.05"""
  try:
    if isinstance(value, bool):
      raise ValueError
    if isinstance(value, str) and value.strip().endswith('%'):
      fraction = float(value.strip()[:-1]) / 100
    else:
      fraction = float(value)
  except (TypeError, ValueError):
    raise GateConfigError(f"{where}: expected a percentage like 5% (or a fraction like 0.05), got {value!r}")
  if fraction < 0 or not math.isfinite(fraction):
    raise GateConfigError(f"{where}: must be a positive percentage, got {value!r}")
  return fraction


def parse_number(value: Any, where: str) -> float:
  try:
    if isinstance(value, bool):
      raise ValueError
    number = float(value)
  except (TypeError, ValueError):
    raise GateConfigError(f"{where}: expected a number, got {value!r}")
  if not math.isfinite(number):
    raise GateConfigError(f"{where}: expected a number, got {value!r}")
  return number


def parse_config(config: Dict[str, Any]) -> GateConfig:
  """The `gate:` section of qaboard.yaml"""
  gate = config.get('gate')
  if gate is None:
    gate = {}
  if not isinstance(gate, dict):
    raise GateConfigError("gate: expected a mapping, with `rules:`...")
  unknown = set(gate) - GATE_KEYS
  if unknown:
    raise GateConfigError(f"gate: unknown keys {', '.join(sorted(unknown))}. Use: {', '.join(sorted(GATE_KEYS))}")

  reference = gate.get('reference') or (config.get('project') or {}).get('reference_branch') or None
  if 'labels' in gate and 'batches' in gate:
    raise GateConfigError("gate: give `labels`, or `batches`, its older name, not both")
  labels_key = 'labels' if 'labels' in gate else 'batches'
  labels = gate.get(labels_key, ['default'])
  if isinstance(labels, (str, int)) and not isinstance(labels, bool):
    labels = [labels]
  if not isinstance(labels, list) or not labels or not all(isinstance(b, (str, int)) and not isinstance(b, bool) for b in labels):
    raise GateConfigError(f"gate.{labels_key}: expected a list of labels (as `qa --label` sets them), e.g. [default]")
  expect_batches = parse_expect_batches(gate.get('expect_batches'))

  rules = []
  rules_config = gate.get('rules') or []
  if not isinstance(rules_config, list):
    raise GateConfigError("gate.rules: expected a list, e.g. [{metric: psnr, max_regression: 1%}]")
  for index, rule in enumerate(rules_config):
    where = f"gate.rules[{index}]"
    if not isinstance(rule, dict) or not rule.get('metric'):
      raise GateConfigError(f"{where}: expected a mapping with a `metric`, e.g. {{metric: psnr, max_regression: 1%}}")
    unknown = set(rule) - {'metric', 'aggregate', *RULE_KINDS, *RULE_SCOPES}
    if unknown:
      raise GateConfigError(f"{where}: unknown keys {', '.join(sorted(unknown))}. Use: metric, {', '.join(RULE_KINDS)}, aggregate, {', '.join(RULE_SCOPES)}")
    scope = {key: parse_names(rule[key], f"{where}.{key}") if rule.get(key) is not None else None for key in RULE_SCOPES}
    kinds = [k for k in RULE_KINDS if k in rule]
    if not kinds:
      raise GateConfigError(f"{where}: give a limit for {rule['metric']}: {', '.join(RULE_KINDS)}")
    aggregate = rule.get('aggregate')
    if aggregate is not None and aggregate not in AGGREGATES:
      raise GateConfigError(f"{where}.aggregate: expected one of {', '.join(AGGREGATES)}, got {aggregate!r}")
    if aggregate is not None and 'per_test_max_regression' in rule:
      raise GateConfigError(
        f"{where}.aggregate: per_test_max_regression checks each test, it doesn't aggregate them. "
        f"Give it its own rule, without aggregate, e.g. {{metric: {rule['metric']}, per_test_max_regression: 5%}}"
      )
    for kind in kinds:
      if kind in ('min', 'max'):
        limit = parse_number(rule[kind], f"{where}.{kind}")
      else:
        limit = parse_fraction(rule[kind], f"{where}.{kind}")
      rule_aggregate = None if kind == 'per_test_max_regression' else aggregate or 'median'
      rules.append(Rule(metric=str(rule['metric']), kind=kind, limit=limit, aggregate=rule_aggregate, batch=scope['batch'], label=scope['label']))

  max_failed_runs = gate.get('max_failed_runs', 0)
  if max_failed_runs is not None and (isinstance(max_failed_runs, bool) or not isinstance(max_failed_runs, int) or max_failed_runs < 0):
    raise GateConfigError(f"gate.max_failed_runs: expected a number of runs, got {max_failed_runs!r}")
  require_bit_accuracy = gate.get('require_bit_accuracy', False)
  if not isinstance(require_bit_accuracy, bool):
    raise GateConfigError(f"gate.require_bit_accuracy: expected true or false, got {require_bit_accuracy!r}")
  return GateConfig(
    reference=str(reference) if reference is not None else None,
    labels=[str(b) for b in labels],
    rules=rules,
    expect_batches=expect_batches,
    max_failed_runs=max_failed_runs,
    require_bit_accuracy=require_bit_accuracy,
  )


def parse_names(value: Any, where: str) -> List[str]:
  """A name, or a list of names, of batches or labels. Shell patterns like `perf-*` work too."""
  names = [value] if isinstance(value, (str, int)) and not isinstance(value, bool) else value
  if not isinstance(names, list) or not names or not all(isinstance(n, (str, int)) and not isinstance(n, bool) and str(n) for n in names):
    raise GateConfigError(f"{where}: expected a name, a list of names, or patterns like \"perf-*\", got {value!r}")
  return [str(n) for n in names]


def parse_expect_batches(value: Any) -> Dict[str, List[str]]:
  """`expect_batches: [ci, perf]`, for every label checked, or per label: `{default: [ci, perf], nightly: [all]}`"""
  if value is None or value == []:
    return {}
  if isinstance(value, dict):
    return {str(label): parse_names(batches, f"gate.expect_batches.{label}") for label, batches in value.items() if batches not in (None, [])}
  try:
    return {'*': parse_names(value, 'gate.expect_batches')}
  except GateConfigError:
    raise GateConfigError(f"gate.expect_batches: expected a list of batches, e.g. [ci, perf], or a list per label, e.g. {{default: [ci, perf]}}, got {value!r}")


def batches_text(patterns: List[str]) -> str:
  """`qa batch perf` or `qa batch perf-*`"""
  return ' or '.join(f"`qa batch {p}`" for p in patterns)


def knows_batches(tests: List[Dict[str, Any]]) -> bool:
  """Whether the server says which batch each run comes from (`tests[].batch`, servers from November 2026)"""
  return any('batch' in test for test in tests)


def upgrade_server(what: str) -> str:
  return f"QA-Board's server doesn't say which batch each run comes from: upgrade it to check {what}"


def smaller_is_better(metric: str, local_metrics: Dict[str, Any], server_info: Optional[Dict[str, Any]]) -> Optional[bool]:
  """
  Whether a smaller value is better. Like the web app, from what the server knows: the commit's metrics file with the
  metrics declared in code, which win. Else from the local metrics file (outputs.metrics in qaboard.yaml). None if unknown.
  """
  if server_info and server_info.get('declared') and server_info.get('smaller_is_better') is not None:
    return bool(server_info['smaller_is_better'])
  if metric in local_metrics:
    definition = local_metrics.get(metric) or {}
    # like the web app: metrics files leave it out when smaller is better, null says there is no better direction
    if 'smaller_is_better' not in definition:
      return True
    value = definition['smaller_is_better']
    if value is None:
      return None
    if isinstance(value, str):
      return value.lower() != 'false'
    return bool(value)
  return None


# ---------------------------------------------------------------------------- evaluating the rules

def regression_of(change: Optional[float], delta: Optional[float], is_smaller_better: bool) -> Optional[float]:
  """How much worse, as a fraction of the reference (negative: better). Infinite when the reference is 0."""
  sign = 1 if is_smaller_better else -1
  if change is not None:
    return sign * change
  if delta is None:
    return None
  if delta == 0:
    return 0.0
  return math.copysign(math.inf, sign * delta)


def relative_change(new: float, ref: float) -> Optional[float]:
  """(new - ref) / |ref|, like the server's for medians. None for a reference of 0 with a change: see regression_of"""
  if ref == 0:
    return 0.0 if new == ref else None
  return (new - ref) / abs(ref)


def aggregate_of(values: List[float], how: str) -> float:
  if how == 'mean':
    return sum(values) / len(values)
  if how == 'min':
    return min(values)
  if how == 'max':
    return max(values)
  return statistics.median(values)


def tests_values(tests: List[Dict[str, Any]], metric: str) -> Tuple[List[float], List[float]]:
  """
  The metric's values in each new run, and in the reference runs they're compared with (the Metrics Diff's).
  The server lists the new runs: reference runs that match none of them, or whose new run has no value, are left out.
  A reference run that matches several new runs counts once.
  """
  new_values: List[float] = []
  ref_values: Dict[Any, float] = {}
  for test in tests:
    cell = (test.get('metrics') or {}).get(metric)
    if not cell or cell.get('new') is None:
      continue
    new_values.append(cell['new'])
    if cell.get('ref') is not None:
      ref_values[test.get('reference_id') or ('test', test.get('id'))] = cell['ref']
  return new_values, list(ref_values.values())


def name_of_test(test: Dict[str, Any], tests: List[Dict[str, Any]]) -> str:
  name = test.get('label') or test.get('test_input_path') or str(test.get('id'))
  same_name = [t for t in tests if (t.get('label') or t.get('test_input_path')) == (test.get('label') or test.get('test_input_path'))]
  if len(same_name) > 1:
    details = [str(test.get('platform'))] + [json.dumps(c) if not isinstance(c, str) else c for c in test.get('configurations') or []]
    name = f"{name} ({', '.join(details)})"
  return name


def check_rule(rule: Rule, data: Dict[str, Any], local_metrics: Dict[str, Any]) -> Dict[str, Any]:
  info = (data.get('metrics') or {}).get(rule.metric)
  # `label` is the metric's name for people: the rule's labels are `scope_label`
  check: Dict[str, Any] = {**{k: v for k, v in rule.to_dict().items() if k != 'label'}, 'status': 'pass', 'message': ''}
  if rule.label is not None:
    check['scope_label'] = rule.label
  if info:
    check.update(label=info.get('label') or rule.metric, scale=info.get('scale') or 1, suffix=info.get('suffix') or '')
  all_tests = data.get('tests') or []
  tests = all_tests
  scoped = rule.batch is not None
  if scoped:
    assert rule.batch is not None
    # Only the runs of some `qa batch`: until they're there, the gate can't decide
    if all_tests and not knows_batches(all_tests):
      return {**check, 'status': 'unknown', 'message': upgrade_server(f"rules for {batches_text(rule.batch)}")}
    tests = [t for t in all_tests if matches(t.get('batch'), rule.batch)]
    check['tests_matched'] = len(tests)
    if not tests:
      return {**check, 'status': 'unknown', 'message': f"no runs from {batches_text(rule.batch)} yet"}
  where = f"the runs from {batches_text(rule.batch)}" if rule.batch else "the new runs"
  if not info or not info['new']['count']:
    return {**check, 'status': 'fail', 'message': f"no values of {rule.metric} in {where}"}
  # Medians of all the runs are the server's numbers, those of the Summary. Other aggregates, and the aggregates
  # of some batches, come from each test's values, as the Metrics Diff shows them.
  aggregate = rule.aggregate or 'median'
  if aggregate == 'median' and not scoped:
    check['new'] = info['new']['median']
    check['ref'] = info['ref']['median']
  else:
    new_values, ref_values = tests_values(tests, rule.metric)
    if not new_values:
      return {**check, 'status': 'fail', 'message': f"no values of {rule.metric} in {where}"}
    check['new'] = aggregate_of(new_values, aggregate)
    check['ref'] = aggregate_of(ref_values, aggregate) if ref_values else None

  if rule.kind in ('min', 'max'):
    ok = check['new'] >= rule.limit - EPSILON * abs(rule.limit) if rule.kind == 'min' else check['new'] <= rule.limit + EPSILON * abs(rule.limit)
    return {**check, 'status': 'pass' if ok else 'fail'}

  is_smaller_better = smaller_is_better(rule.metric, local_metrics, info)
  if is_smaller_better is None:
    raise GateConfigError(
      f"gate: declare whether smaller values of {rule.metric} are better, so that the gate knows what a regression is: "
      f"qaboard.Metric(value, smaller_is_better=...) where your code computes it, or `smaller_is_better` in your metrics file"
    )
  check['smaller_is_better'] = is_smaller_better
  if rule.kind == 'max_regression':
    if check['ref'] is None or (not scoped and not info['ref']['count']):
      return {**check, 'status': 'skip', 'message': f"the reference has no values of {rule.metric}"}
    if aggregate == 'median' and not scoped:
      change, delta = info.get('delta_relative'), info.get('delta')
    else:
      change, delta = relative_change(check['new'], check['ref']), check['new'] - check['ref']
    check['change'] = change
    check['regression'] = regression_of(change, delta, is_smaller_better)
    ok = check['regression'] is not None and check['regression'] <= rule.limit + EPSILON
    return {**check, 'status': 'pass' if ok else 'fail'}

  # per_test_max_regression, on the tests in scope
  regressions = []
  for test in tests:
    cell = (test.get('metrics') or {}).get(rule.metric) or {}
    if cell.get('delta') is None:
      continue
    regression = regression_of(cell.get('delta_relative'), cell.get('delta'), is_smaller_better)
    if regression is not None:
      regressions.append((regression, test, cell))
  if not regressions:
    return {**check, 'status': 'skip', 'message': f"no test has values of {rule.metric} in both the new and the reference runs"}
  regressions.sort(key=lambda r: r[0], reverse=True)
  worst_regression, worst, cell = regressions[0]
  over = [r for r in regressions if r[0] > rule.limit + EPSILON]
  check.update(
    new=cell.get('new'), ref=cell.get('ref'), change=cell.get('delta_relative'), regression=worst_regression,
    worst={'id': worst.get('id'), 'reference_id': worst.get('reference_id'), 'test': name_of_test(worst, all_tests)},
    tests_compared=len(regressions), over_limit=len(over),
    over_limit_tests=[{'test': name_of_test(t, all_tests), 'regression': r} for r, t, _ in over[:10]],
  )
  return {**check, 'status': 'fail' if over else 'pass'}


def check_expected_batches(expected: List[str], tests: List[Dict[str, Any]]) -> Dict[str, Any]:
  """`expect_batches`: each must have at least one run, else the results aren't complete yet"""
  check: Dict[str, Any] = {'kind': 'expect_batches', 'metric': None, 'limit': expected, 'message': ''}
  if tests and not knows_batches(tests):
    return {**check, 'status': 'unknown', 'message': upgrade_server(f"that {batches_text(expected)} have runs")}
  batches = {t.get('batch') for t in tests}
  missing = [pattern for pattern in expected if not any(matches(batch, [pattern]) for batch in batches)]
  check.update(new=len(expected) - len(missing), missing=missing)
  if missing:
    return {**check, 'status': 'unknown', 'message': f"no runs from {batches_text(missing)} yet"}
  return {**check, 'status': 'pass'}


def evaluate_batch(data: Dict[str, Any], gate: GateConfig, local_metrics: Dict[str, Any], changes: Optional[List[Dict[str, Any]]] = None,
                   label: Optional[str] = None) -> Dict[str, Any]:
  """
  The checks of one label's results, and their verdict: pass, fail or undecidable.
  `changes`: how our rules differ from the reference's (rules_changes), None when we can't tell.
  `label`: the label as the gate was asked to check it. Rules for other labels are left out.
  """
  names = names_of_label(label, (data.get('commit') or {}).get('batch'))
  checks = [check_rule(rule, data, local_metrics) for rule in gate.rules if rule.applies_to(names)]
  # the project's rules, set by its owners in the web app: checked like ours, whatever ours say
  if gate.project:
    checks += [{**check_rule(rule, data, local_metrics), 'source': 'project'} for rule in gate.project.rules if rule.applies_to(names)]
  expected, only_project = gate.expected_batches(names)
  if expected:
    checks.append({**check_expected_batches(expected, data.get('tests') or []), **({'source': 'project'} if only_project else {})})
  runs = (data.get('commit') or {}).get('runs') or {}
  max_failed_runs, max_failed_runs_source = gate.failed_runs_limit
  if max_failed_runs is not None:
    failed = runs.get('failed', 0)
    checks.append({
      'kind': 'max_failed_runs', 'metric': None, 'limit': max_failed_runs, 'new': failed,
      'ref': ((data.get('reference') or {}).get('runs') or {}).get('failed'),
      'status': 'pass' if failed <= max_failed_runs else 'fail', 'message': '',
      **({'source': max_failed_runs_source} if max_failed_runs_source else {}),
    })
  if gate.on_looser_rules == 'fail':
    # the project doesn't let a commit loosen its own rules: its owners change the reference's
    looser = [change['text'] for change in changes or [] if change.get('looser')]
    check: Dict[str, Any] = {'kind': 'rules', 'metric': None, 'limit': None, 'looser': looser, 'source': 'project', 'message': ''}
    if changes is None:
      check.update(status='unknown', message="QA-Board doesn't have the reference's qaboard.yaml to compare the rules with")
    else:
      check['status'] = 'fail' if looser else 'pass'
    checks.append(check)
  if gate.needs_bit_accuracy:
    counts = data.get('bit_accuracy') or {}
    check = {'kind': 'require_bit_accuracy', 'metric': None, 'limit': None, **counts, 'message': '',
             **({'source': 'project'} if not gate.require_bit_accuracy else {})}
    if counts.get('mismatched'):
      differ = [t for t in data.get('tests') or [] if t.get('bit_accurate') is False]
      check.update(status='fail', differing_tests=[{'test': name_of_test(t, data['tests']), 'files': t.get('bit_accuracy_mismatch')} for t in differ[:10]])
    elif counts.get('unavailable') or not counts:
      check.update(status='unknown', message="some runs have no manifest.outputs.json to compare")
    else:
      check['status'] = 'pass'
    checks.append(check)

  status = data.get('status')
  if status != 'complete':
    verdict = 'undecidable'
  elif any(c['status'] == 'fail' for c in checks):
    verdict = 'fail'
  elif any(c['status'] == 'unknown' for c in checks):
    verdict = 'undecidable'
  else:
    verdict = 'pass'
  return {'verdict': verdict, 'checks': checks}


# How many runs we name when we list them
MAX_LISTED = 10


def reruns_summary(data: Dict[str, Any]) -> Optional[Dict[str, Any]]:
  """
  The runs of the batch that were done again, as the server knows them (older servers don't say). It doesn't change
  the verdict: it's for whoever reads it, e.g. when runs only passed after a failed attempt.
  """
  counts = (data.get('commit') or {}).get('reruns') or {}
  if not counts.get('runs'):
    return None
  tests = data.get('tests') or []
  done_again = [t for t in tests if t.get('attempts')]
  # those that ended well after an attempt that didn't come first
  done_again.sort(key=lambda t: (bool(t.get('is_failed')), 'failed' not in t['attempts'].get('previous', []), 'unfinished' not in t['attempts'].get('previous', [])))
  return {
    'runs': counts['runs'],
    'after_failure': counts.get('after_failure', 0),
    'after_unfinished': counts.get('after_unfinished', 0),
    'tests': [{'test': name_of_test(t, tests), 'is_failed': bool(t.get('is_failed')), **t['attempts']} for t in done_again[:MAX_LISTED]],
  }


def describe_reruns(reruns: Optional[Dict[str, Any]]) -> List[str]:
  """Sentences about the runs that were done again: a headline, then a line per run"""
  if not reruns:
    return []
  runs = reruns['runs']
  parts = []
  if reruns.get('after_failure'):
    parts.append(f"{reruns['after_failure']} passed after a failed attempt")
  if reruns.get('after_unfinished'):
    parts.append(f"{reruns['after_unfinished']} passed after an attempt that didn't finish")
  lines = [f"{runs} run{'s were' if runs > 1 else ' was'} done again" + (f": {', '.join(parts)}" if parts else '') + '.']
  status_text = {'failed': 'failed', 'unfinished': "didn't finish", 'success': 'succeeded'}
  for test in reruns.get('tests') or []:
    previous = ', '.join(status_text.get(status, status) for status in test.get('previous') or [])
    attempt = f"attempt {test['attempt']}" if test.get('attempt', 1) > 1 else 'done again in place'
    lines.append(f"{test['test']}: {attempt}{' (failed)' if test.get('is_failed') else ''}" + (f", earlier: {previous}" if previous else ''))
  if runs > len(reruns.get('tests') or []):
    lines.append(f"and {runs - len(reruns.get('tests') or [])} more")
  return lines


def scope_text(rule: Rule) -> str:
  """Which runs a rule checks, for people"""
  parts = []
  if rule.batch is not None:
    parts.append(f"only {batches_text(rule.batch)}")
  if rule.label is not None:
    parts.append(f"only the label{'s' if len(rule.label) > 1 else ''} {', '.join(rule.label)}")
  return ', '.join(parts) or 'every run'


def scope_marker(batch: Optional[List[str]], *more: str) -> str:
  """` [perf]`, ` [perf, project rule]`: what the tables add to a check's name"""
  parts = [' or '.join(batch)] if batch else []
  parts += [part for part in more if part]
  return f" [{', '.join(parts)}]" if parts else ''


def rule_label(rule: Rule, with_scope: bool = True) -> str:
  if rule.kind == 'per_test_max_regression':
    label = f"{rule.metric}, each test"
  else:
    label = f"{rule.metric}, {rule.aggregate or 'median'}, {rule.kind.replace('_', ' ')}"
  if not with_scope:
    return label
  return label + scope_marker(rule.batch, *([f"label {' or '.join(rule.label)}"] if rule.label else []))


def rule_limit(rule: Rule) -> str:
  return format_percent(rule.limit) if rule.kind in ('max_regression', 'per_test_max_regression') else f"{rule.limit:g}"


def rules_changes(gate: GateConfig, reference_gate: Optional[Dict[str, Any]]) -> List[Dict[str, Any]]:
  """
  How the gate's rules differ from those of the reference's qaboard.yaml: [{'text', 'looser'}].
  Loosening a rule is a legitimate change, and the cheapest way to turn a red gate green: reviewers should see it.
  [] when the server doesn't have the reference's configuration, or can't be read as rules: see reference_rules_known.
  """
  if not reference_rules_known(reference_gate):
    return []
  assert isinstance(reference_gate, dict)
  before = parse_config({'gate': {k: v for k, v in reference_gate.items() if k in GATE_KEYS}})
  # Which runs a rule checks is part of what it is: the same metric and limit for `qa batch perf` is another rule
  old_rules = {r.identity: r for r in before.rules}
  new_rules = {r.identity: r for r in gate.rules}
  removed = [r for key, r in old_rules.items() if key not in new_rules]
  added = [r for key, r in new_rules.items() if key not in old_rules]
  # ...but a rule whose scope changed, and nothing else like it did, reads better as one change
  def unscoped(rule: Rule) -> Tuple[str, str, Optional[str]]:
    return (rule.metric, rule.kind, rule.aggregate)
  rescoped: List[Tuple[Rule, Rule]] = []
  for old in list(removed):
    same_old = [r for r in removed if unscoped(r) == unscoped(old)]
    same_new = [r for r in added if unscoped(r) == unscoped(old)]
    if len(same_old) == 1 and len(same_new) == 1:
      rescoped.append((old, same_new[0]))
      removed.remove(old)
      added.remove(same_new[0])

  def limit_looser(old: Rule, new: Rule) -> bool:
    # a floor is looser when it goes down, the other limits when they go up
    return new.limit < old.limit if new.kind == 'min' else new.limit > old.limit

  changes: List[Dict[str, Any]] = []
  for rule in removed:
    changes.append({'text': f"{rule_label(rule)}: removed (was {rule_limit(rule)})", 'looser': True})
  for identity, rule in new_rules.items():
    same = old_rules.get(identity)
    if same is not None and abs(same.limit - rule.limit) > EPSILON:
      changes.append({'text': f"{rule_label(rule)}: {rule_limit(same)} → {rule_limit(rule)}", 'looser': limit_looser(same, rule)})
  for old, rule in rescoped:
    # checking fewer runs or labels is looser, checking more isn't
    narrower = any(old_scope is None and new_scope is not None or
                   (old_scope is not None and new_scope is not None and not set(old_scope) <= set(new_scope))
                   for old_scope, new_scope in ((old.batch, rule.batch), (old.label, rule.label)))
    limit_changed = abs(old.limit - rule.limit) > EPSILON
    text = f"{rule_label(rule, with_scope=False)}: {scope_text(old)} → {scope_text(rule)}"
    if limit_changed:
      text += f", {rule_limit(old)} → {rule_limit(rule)}"
    changes.append({'text': text, 'looser': narrower or (limit_changed and limit_looser(old, rule))})
  for rule in added:
    changes.append({'text': f"{rule_label(rule)}: new ({rule_limit(rule)})", 'looser': False})
  for label in dict.fromkeys([*before.expect_batches, *gate.expect_batches]):
    old_batches, new_batches = before.expect_batches.get(label, []), gate.expect_batches.get(label, [])
    if old_batches != new_batches:
      where = '' if label == '*' else f" (label {label})"
      show = lambda batches: ', '.join(batches) or 'none'
      changes.append({'text': f"batches the gate waits for{where}: {show(old_batches)} → {show(new_batches)}",
                      'looser': not set(old_batches) <= set(new_batches)})
  if before.max_failed_runs != gate.max_failed_runs:
    show = lambda value: 'any number' if value is None else str(value)
    looser = gate.max_failed_runs is None or (before.max_failed_runs is not None and gate.max_failed_runs > before.max_failed_runs)
    changes.append({'text': f"failed runs allowed: {show(before.max_failed_runs)} → {show(gate.max_failed_runs)}", 'looser': looser})
  if before.require_bit_accuracy != gate.require_bit_accuracy:
    changes.append({'text': f"bit accuracy required: {'yes' if before.require_bit_accuracy else 'no'} → {'yes' if gate.require_bit_accuracy else 'no'}",
                    'looser': not gate.require_bit_accuracy})
  return changes


def reference_rules_known(reference_gate: Optional[Dict[str, Any]]) -> bool:
  """Whether the server gave the gate of the reference's qaboard.yaml, in a form we can read"""
  if not isinstance(reference_gate, dict):
    return False
  try:
    parse_config({'gate': {k: v for k, v in reference_gate.items() if k in GATE_KEYS}})
  except GateConfigError:
    return False
  return True


def describe_rules_changes(changes: List[Dict[str, Any]]) -> List[str]:
  if not changes:
    return []
  looser = any(change['looser'] for change in changes)
  headline = "This commit loosens the gate's rules, compared with the reference's:" if looser else "This commit changes the gate's rules, compared with the reference's:"
  return [headline, *[f"{change['text']}{' (looser)' if change['looser'] else ''}" for change in changes]]


def overall_verdict(verdicts: List[str]) -> str:
  if 'fail' in verdicts:
    return 'fail'
  if 'undecidable' in verdicts or not verdicts:
    return 'undecidable'
  return 'pass'


# ---------------------------------------------------------------------------- talking to the server and forges

def metrics_diff_url(qaboard_url: str, project: str, commit: str, reference: Optional[str], batch: str, reference_batch: str) -> str:
  # without a reference, the web app compares with its default one
  params = {'reference': reference} if reference else {}
  params.update({'batch': batch, 'batch_ref': reference_batch, 'selected_views': 'table-compare'})
  return f"{qaboard_url}/{quote(project, safe='/')}/commit/{commit}?{urlencode(params)}"


def fetch_comparison(api_prefix: str, project: str, commit: str, reference: Optional[str], batch: str, metrics: List[str],
                     bit_accuracy: bool, headers: Dict[str, str], verify: Any, token_source: Optional[str] = None) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
  """GET /api/v1/commit/<sha>/compare. Returns (data, None), or (None, why it failed). `token_source`: see credentials.resolve_token"""
  import requests
  params = {'project': project, 'batch': batch}
  if reference:
    params['reference'] = reference
  if metrics:
    params['metrics'] = ','.join(metrics)
  if bit_accuracy:
    params['bit_accuracy'] = 'true'
  url = f"{api_prefix}/commit/{commit}/compare"
  try:
    r = requests.get(url, params=params, headers=headers, verify=verify, timeout=300)
  except requests.RequestException as e:
    # e.g. requests' InvalidHeader quotes the header, with the token
    return None, redact(f"could not reach QA-Board at {url}: {e}", headers.get('Authorization'))
  if r.status_code == 404:
    # The endpoint says why in JSON. A server from before October 2026 doesn't have it: its 404 is a web page,
    # waiting for results would never end
    try:
      knows_compare = isinstance(r.json(), dict)
    except ValueError:
      knows_compare = False
    if not knows_compare:
      return None, f"QA-Board's server at {api_prefix} doesn't have the comparisons qa gate needs: upgrade it"
    return None, f"QA-Board has no results for {commit[:10]} in {project} yet"
  try:
    r.raise_for_status()
    return r.json(), None
  except Exception:
    from .credentials import auth_error_hint
    from .config import is_ci
    hint = auth_error_hint(r, token_source, ci=bool(is_ci), project=project)
    if hint:
      return None, hint.replace('\n', ' ')
    return None, redact(f"QA-Board answered {r.status_code}: {r.text[:300]}", headers.get('Authorization'))


def undecidable_reasons(batch: Dict[str, Any]) -> List[str]:
  """Why a label's results can't be decided yet: the server's messages, then the checks that can't tell"""
  return [*(batch.get('messages') or []), *[c['message'] for c in batch.get('checks') or [] if c['status'] == 'unknown' and c.get('message')]]


def status_description(result: Dict[str, Any]) -> str:
  """One line for a commit status (GitHub keeps 140 characters)"""
  verdict = result['verdict']
  for batch in result['batches']:
    failed = [c for c in batch['checks'] if c['status'] == 'fail']
    if verdict == 'fail' and failed:
      return f"fail: {describe_check(failed[0])}"[:140]
    if verdict == 'undecidable' and batch['verdict'] == 'undecidable':
      reason = (undecidable_reasons(batch) or ['the reference or the runs are missing'])[0]
      return f"undecidable: {reason}"[:140]
  if result.get('errors'):
    return f"undecidable: {result['errors'][0]}"[:140]
  checks = sum(len(b['checks']) for b in result['batches'])
  return f"pass: {checks} checks vs {result['reference'] or 'the reference'}"[:140]


def forge_token(forge: str) -> Optional[str]:
  """The token for GitHub's or GitLab's API. Without the whitespace secrets often end with: requests would refuse
  the header, and quote it, token included, in its error"""
  from .site_config import site_config
  token = os.environ.get('GITHUB_TOKEN') if forge == 'github' else site_config('GITLAB_ACCESS_TOKEN')
  return str(token).strip() or None if token else None


def redact(text: str, *secrets: Any) -> str:
  """Errors we print can quote what we sent: never the tokens"""
  for secret in secrets:
    if not secret:
      continue
    for value in {str(secret), str(secret).strip(), *str(secret).split()}:
      # not the short words of headers' values, like "Bearer"
      if len(value) >= 8 and value.lower() not in ('bearer', 'private-token'):
        text = text.replace(value, '***')
  return text


def post_commit_status(forge: str, result: Dict[str, Any], context: str, project_root: str) -> Optional[str]:
  """Posts a commit status that links to the Metrics Diff. Returns an error message, or None."""
  import requests
  from .site_config import site_config
  verdict = result['verdict']
  target_url = next((b['url'] for b in result['batches'] if b['verdict'] == verdict and b.get('url')), None)
  if not target_url and result['batches']:
    target_url = result['batches'][0].get('url')
  description = status_description(result)
  sha = result['commit']
  try:
    if forge == 'github':
      token, repository = forge_token('github'), os.environ.get('GITHUB_REPOSITORY')
      if not token or not repository:
        return "--post-status github needs GITHUB_TOKEN and GITHUB_REPOSITORY (set by GitHub Actions)"
      api = os.environ.get('GITHUB_API_URL', 'https://api.github.com').rstrip('/')
      state = {'pass': 'success', 'fail': 'failure', 'undecidable': 'error'}[verdict]
      r = with_retry(lambda: requests.post(
        f"{api}/repos/{repository}/statuses/{sha}",
        json={'state': state, 'target_url': target_url, 'description': description, 'context': context},
        headers={'Authorization': f'Bearer {token}', 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28'},
        timeout=60,
      ))
    else:
      token = forge_token('gitlab')
      if not token:
        return "--post-status gitlab needs a token with the `api` scope in GITLAB_ACCESS_TOKEN"
      api = os.environ.get('CI_API_V4_URL') or f"{site_config('GITLAB_HOST', 'https://gitlab.com').rstrip('/')}/api/v4"
      project_id = os.environ.get('CI_PROJECT_ID') or quote(project_root, safe='')
      state = {'pass': 'success', 'fail': 'failed', 'undecidable': 'failed'}[verdict]
      payload = {'state': state, 'name': context, 'target_url': target_url, 'description': description}
      if os.environ.get('CI_PIPELINE_ID'):
        payload['pipeline_id'] = os.environ['CI_PIPELINE_ID']
      if os.environ.get('CI_COMMIT_REF_NAME'):
        payload['ref'] = os.environ['CI_COMMIT_REF_NAME']
      r = with_retry(lambda: requests.post(f"{api}/projects/{project_id}/statuses/{sha}", json=payload, headers={'PRIVATE-TOKEN': token}, timeout=60))
    r.raise_for_status()
  except Exception as e:
    response = getattr(e, 'response', None)
    details = f" {response.text[:300]}" if response is not None else ''
    return redact(f"could not post the commit status to {forge}: {e}{details}", forge_token(forge))
  return None


# One comment per pull request and gate (a subproject has its own): we find ours by this hidden line, and update it
def comment_marker(context: str) -> str:
  return f"<!-- {context} -->"


# GitHub refuses comments over 65,536 characters, GitLab over 1,000,000
MAX_COMMENT_LENGTH = 60_000
MAX_PULL_REQUESTS = 3
MAX_COMMENT_PAGES = 20


def section_marker(context: str, label: str, verdict: str, commit: str) -> str:
  """
  Where a label's section starts, and what it says: other `qa gate` runs of the commit keep it. Values are
  percent-encoded, with `-` too: HTML comments can't have `--`.
  """
  def encode(value: str) -> str:
    return quote(str(value), safe='').replace('-', '%2D')
  return f"<!-- {context} section label={encode(label)} verdict={encode(verdict)} commit={encode(commit)} -->"


def section_end(context: str) -> str:
  return f"<!-- {context} end -->"


def comment_sections(body: Optional[str], context: str) -> List[Dict[str, str]]:
  """
  The sections of a comment we wrote: [{label, verdict, commit, body}]. Markers are lines of their own: what we
  write inside sections can't start a line with `<!--` (see markdown_text). Comments edited in the forges' web
  pages come back with Windows' line ends.
  """
  from urllib.parse import unquote
  if not body:
    return []
  body = body.replace('\r\n', '\n')
  pattern = re.compile(rf"^<!-- {re.escape(context)} section (?P<attrs>[^>\n]*?) -->\n(?P<body>.*?)^{re.escape(section_end(context))}$", re.S | re.M)
  sections = []
  for match in pattern.finditer(body):
    attrs = dict(part.split('=', 1) for part in match.group('attrs').split() if '=' in part)
    if not {'label', 'verdict', 'commit'} <= set(attrs):
      continue
    section = {key: unquote(attrs[key]) for key in ('label', 'verdict', 'commit')}
    if section['verdict'] not in EXIT_CODES:
      continue
    sections.append({**section, 'body': match.group('body')})
  return sections


def cut_text(text: str, length: int) -> str:
  """At most about `length` characters, cut at a line"""
  if len(text) <= length:
    return text
  return text[:max(length, 0)].rsplit('\n', 1)[0] + '\n\n…the rest is in the Metrics Diff.\n\n'


def comment_body(result: Dict[str, Any], context: str, existing: Optional[str] = None) -> str:
  """
  The Markdown of the comment: a section per label, with the gate's table and what reviewers should know, then the
  rules that changed and which commit it's about. `existing`: the comment as it is now. Its sections for other
  labels of the same commit stay: several jobs share the comment. Sections about an earlier commit are dropped.
  """
  sha = str(result.get('commit') or '')
  project = result.get('project') or ''
  ours = [{'label': section_label(b['batch']), 'verdict': b['verdict'], 'commit': sha, 'batch': b} for b in result['batches']]
  our_labels = {s['label'] for s in ours}
  kept = [s for s in comment_sections(existing, context) if s['commit'] == sha and section_label(s['label']) not in our_labels]
  # the same order whichever job writes: CI first
  sections: List[Dict[str, Any]] = sorted([*kept, *ours], key=lambda s: (s['label'] != 'default', s['label']))
  verdict = overall_verdict([s['verdict'] for s in sections])

  # the marker comes first: it's how we tell our comment from those that quote it (find_comments)
  head = [comment_marker(context), f"### Quality gate: {verdict}", '']
  if len(sections) > 1:
    head += [' · '.join(f"**{markdown_text('CI' if s['label'] == 'default' else s['label'])}**: {s['verdict']}" for s in sections), '']
  tail = [*markdown_rules_changes(result), f"<sub>{EXPERIMENTAL_NOTICE}</sub>", '',
          f"<sub>For commit {markdown_text(sha[:10])}. `qa gate` updates this comment when new results come in.</sub>"]

  def render(details: bool) -> List[str]:
    return [s['body'] if 'body' in s else '\n'.join(markdown_section(s['batch'], project, details=details)) + '\n' for s in sections]
  bodies = render(details=True)
  markers = sum(len(section_marker(context, s['label'], s['verdict'], s['commit'])) + len(section_end(context)) + 2 for s in sections)
  budget = MAX_COMMENT_LENGTH - len('\n'.join(head + tail)) - markers - 100
  if sum(len(b) for b in bodies) > budget:
    # too long: first without the lists of tests, then each section gets its share, so that none disappears
    bodies = render(details=False)
  if sum(len(b) for b in bodies) > budget:
    lengths = sorted(len(b) for b in bodies)
    share, left, count = budget, budget, len(bodies)
    for length in lengths:
      share = left // count
      if length > share:
        break
      left, count = left - length, count - 1
    bodies = [cut_text(b, share) for b in bodies]
  lines = head
  for section, text in zip(sections, bodies):
    lines += [section_marker(context, section['label'], section['verdict'], section['commit']), text.rstrip('\n') + '\n', section_end(context), '']
  return '\n'.join(lines + tail) + '\n'


# Answers worth a second try: rate limits, and the forge being down for a moment
RETRY_DELAY = 5.0
MAX_RETRY_DELAY = 60.0


def is_rate_limited(r: Any) -> bool:
  """The request wasn't done: try again later. GitHub's secondary rate limits answer 403 (or 429) with Retry-After,
  or with no requests left"""
  status = getattr(r, 'status_code', None)
  headers = response_headers(r)
  return status == 429 or (status == 403 and (headers.get('Retry-After') is not None or headers.get('X-RateLimit-Remaining') == '0'))


def should_retry(r: Any) -> bool:
  status = getattr(r, 'status_code', None)
  if not isinstance(status, int):
    return False
  return is_rate_limited(r) or status >= 500


def response_headers(r: Any) -> Mapping[str, Any]:
  headers = getattr(r, 'headers', None)
  return headers if isinstance(headers, Mapping) else {}


def retry_delay(r: Any) -> Optional[float]:
  """How long to wait before trying again, as the forge says. None when it's longer than we wait: a CI job
  shouldn't sleep for the rate limit's hour, and trying sooner would only be refused again."""
  headers = response_headers(r)
  try:
    delay = float(headers['Retry-After'])
  except (KeyError, TypeError, ValueError):
    # Retry-After can also be a date: we don't parse those, we wait our usual delay
    delay = None
  if delay is None and headers.get('X-RateLimit-Remaining') == '0':
    try:
      delay = float(headers['X-RateLimit-Reset']) - time.time()
    except (KeyError, TypeError, ValueError):
      delay = None
  if delay is None:
    return RETRY_DELAY
  delay = max(0.0, delay)
  return delay if delay <= MAX_RETRY_DELAY else None


def with_retry(send: Callable[[], Any], idempotent: bool = True) -> Any:
  """
  Sends a request to GitHub or GitLab, and once more after a rate limit or a server error. Requests that create
  something (a comment) aren't sent again after a server error: it may have been created anyway.
  """
  r = send()
  if should_retry(r) and (idempotent or is_rate_limited(r)):
    delay = retry_delay(r)
    if delay is None:
      return r
    time.sleep(delay)
    r = send()
  return r


class Forge:
  """The comments API of GitHub (issue comments on pull requests) or GitLab (merge requests' notes)"""
  def __init__(self, name: str, session: Any, api: str, repository: str):
    self.name, self.session, self.api, self.repository = name, session, api, repository
    self.prefix = '#' if name == 'github' else '!'
    self.kind = 'pull request' if name == 'github' else 'merge request'

  def request(self, method: str, url: str, **kwargs) -> Any:
    return with_retry(lambda: self.session.request(method, url, timeout=60, **kwargs), idempotent=method != 'POST')

  def pull_requests(self, sha: str) -> List[int]:
    if self.name == 'github':
      return github_pull_requests(self, sha)
    return gitlab_merge_requests(self, sha)

  def comments_url(self, number: int) -> str:
    if self.name == 'github':
      return f"{self.api}/repos/{self.repository}/issues/{number}/comments"
    return f"{self.api}/projects/{self.repository}/merge_requests/{number}/notes"

  def comment_url(self, number: int, comment_id: Any) -> str:
    if self.name == 'github':
      return f"{self.api}/repos/{self.repository}/issues/comments/{comment_id}"
    return f"{self.comments_url(number)}/{comment_id}"

  def comments(self, number: int, marker: str) -> List[Dict[str, Any]]:
    # GitLab lists the newest notes first unless asked: we want the oldest of ours, the one we always update
    params = {'sort': 'asc', 'order_by': 'created_at'} if self.name == 'gitlab' else {}
    return find_comments(self, self.comments_url(number), marker, params)

  def read(self, number: int, comment: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """The comment as it is now. None if it's gone."""
    r = self.request('GET', self.comment_url(number, comment['id']))
    if r.status_code == 404:
      return None
    r.raise_for_status()
    fresh = r.json()
    return fresh if isinstance(fresh, dict) and 'body' in fresh else comment

  def update(self, number: int, comment: Dict[str, Any], body: str) -> Any:
    return self.request('PATCH' if self.name == 'github' else 'PUT', self.comment_url(number, comment['id']), json={'body': body})

  def post(self, number: int, body: str) -> Any:
    return self.request('POST', self.comments_url(number), json={'body': body})


def make_forge(forge: str, project_root: str) -> Tuple[Optional[Forge], Optional[str]]:
  """The forge's API, with the token from the environment. Or why we can't talk to it."""
  import requests
  from .site_config import site_config
  session = requests.Session()
  if forge == 'github':
    token, repository = forge_token('github'), os.environ.get('GITHUB_REPOSITORY')
    if not token or not repository:
      return None, "--post-comment github needs GITHUB_TOKEN and GITHUB_REPOSITORY (set by GitHub Actions)"
    # GitHub Enterprise Server: GitHub Actions sets its API's URL
    api = os.environ.get('GITHUB_API_URL', 'https://api.github.com').rstrip('/')
    session.headers.update({'Authorization': f'Bearer {token}', 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28'})
    return Forge('github', session, api, repository), None
  token = forge_token('gitlab')
  if not token:
    return None, "--post-comment gitlab needs a token with the `api` scope in GITLAB_ACCESS_TOKEN"
  # self-hosted GitLab: its CI sets the API's URL, elsewhere GITLAB_HOST
  api = os.environ.get('CI_API_V4_URL') or f"{site_config('GITLAB_HOST', 'https://gitlab.com').rstrip('/')}/api/v4"
  # A merge request's number is its target project's: a merge request from a fork can run its pipeline in the fork
  merge_request_project = os.environ.get('CI_MERGE_REQUEST_PROJECT_ID') if os.environ.get('CI_MERGE_REQUEST_IID') else None
  project_id = merge_request_project or os.environ.get('CI_PROJECT_ID') or quote(project_root, safe='')
  session.headers.update({'PRIVATE-TOKEN': token})
  return Forge('gitlab', session, api, project_id), None


def github_event_pull_request() -> Optional[Dict[str, Any]]:
  """
  The pull request of the workflow's event: `pull_request`, and `pull_request_target`, whose GITHUB_REF is the base
  branch. Other events (push, merge_group...) have none.
  """
  if not os.environ.get('GITHUB_EVENT_NAME', '').startswith('pull_request') or not os.environ.get('GITHUB_EVENT_PATH'):
    return None
  try:
    with open(os.environ['GITHUB_EVENT_PATH']) as f:
      pull = json.load(f).get('pull_request')
  except (OSError, ValueError, AttributeError):
    return None
  return pull if isinstance(pull, dict) and isinstance(pull.get('number'), int) else None


def github_pull_requests(forge: Forge, sha: str) -> List[int]:
  """The open pull requests the commit belongs to: the one of the workflow's event, else those GitHub knows for the commit"""
  pull = github_event_pull_request()
  if pull is not None:
    # e.g. a workflow that runs when a pull request is closed
    return [pull['number']] if pull.get('state', 'open') == 'open' else []
  match = re.match(r'refs/pull/(\d+)/', os.environ.get('GITHUB_REF', ''))
  if match:
    return [int(match.group(1))]
  # Pushes: GitHub lists the pull requests whose branches have the commit, open or merged (on the default branch,
  # the merged one that brought it). Draft pull requests are open.
  r = forge.request('GET', f"{forge.api}/repos/{forge.repository}/commits/{sha}/pulls", params={'per_page': 100})
  r.raise_for_status()
  return [pull['number'] for pull in r.json() if pull.get('state') == 'open'][:MAX_PULL_REQUESTS]


def gitlab_merge_requests(forge: Forge, sha: str) -> List[int]:
  # merge request pipelines say which one. Branch pipelines don't: GitLab lists those that have the commit
  if os.environ.get('CI_MERGE_REQUEST_IID'):
    return [int(os.environ['CI_MERGE_REQUEST_IID'])]
  r = forge.request('GET', f"{forge.api}/projects/{forge.repository}/repository/commits/{sha}/merge_requests", params={'state': 'opened', 'per_page': 100})
  r.raise_for_status()
  return [mr['iid'] for mr in r.json() if mr.get('state') == 'opened'][:MAX_PULL_REQUESTS]


def is_our_comment(body: Any, marker: str) -> bool:
  return isinstance(body, str) and body.lstrip().startswith(marker)


def find_comments(forge: Forge, url: str, marker: str, params: Optional[Dict[str, Any]] = None) -> List[Dict[str, Any]]:
  """The comments with our marker among those `url` lists, page by page: by the Link header's next page when there is one"""
  found: List[Dict[str, Any]] = []
  next_url: Optional[str] = url
  next_params: Optional[Dict[str, Any]] = {**(params or {}), 'per_page': 100, 'page': 1}
  for page in range(1, MAX_COMMENT_PAGES + 1):
    assert next_url is not None
    r = forge.request('GET', next_url, params=next_params)
    r.raise_for_status()
    comments = r.json()
    # GitLab's notes include those it writes itself ("added 1 commit"). Ours start with the marker: someone who
    # quotes it, or pastes it in a longer comment, keeps their comment (a maintainer's token could edit it)
    found += [c for c in comments if isinstance(c, dict) and not c.get('system') and is_our_comment(c.get('body'), marker)]
    links = getattr(r, 'links', None)
    link = links.get('next', {}).get('url') if isinstance(links, dict) else None
    if link:
      next_url, next_params = link, None
    elif len(comments) < 100:
      break
    else:
      next_url, next_params = url, {**(params or {}), 'per_page': 100, 'page': page + 1}
  return found


def post_comment(forge: str, result: Dict[str, Any], context: str, project_root: str,
                 dryrun: Optional[Callable[[str], None]] = None) -> Tuple[List[str], Optional[str]]:
  """
  Posts the gate's result as a comment on the commit's open pull requests (GitLab: merge requests), or updates the
  comment posted before, keeping the sections of the commit's other labels: reviewers read one comment, about the
  latest results of each `qa gate` run.
  `dryrun`: prints what would be posted, and where, without writing. It still reads, to find the pull requests.
  Returns (the pull requests commented, like "#12", and why it could not, or None).
  """
  sha = result['commit']
  marker = comment_marker(context)
  client, error = make_forge(forge, project_root)
  if client is None:
    if dryrun:
      dryrun(f"Dry run: {error}, so qa gate could not look the {'pull' if forge == 'github' else 'merge'} request up. It would post:\n{comment_body(result, context)}")
    return [], error
  commented: List[str] = []
  try:
    for number in client.pull_requests(sha):
      where = f"{client.prefix}{number}"
      written = False
      for comment in client.comments(number, marker):
        # Another job may have written its section since we listed the comments: what we keep is what's there now
        fresh = client.read(number, comment)
        # gone, or edited into someone's own comment
        if fresh is None or not is_our_comment(fresh.get('body'), marker):
          continue
        body = comment_body(result, context, fresh.get('body'))
        if dryrun:
          dryrun(f"Dry run: would update the comment {comment['id']} on {client.kind} {where} (or post a new one, if the token can't edit it):\n{body}")
          written = True
          break
        r = client.update(number, comment, body)
        # Anyone can write our marker in a comment of their own: we can't edit theirs, and that must not keep the
        # gate's comment away
        if r.status_code in (403, 404):
          continue
        r.raise_for_status()
        written = True
        break
      if not written:
        body = comment_body(result, context)
        if dryrun:
          dryrun(f"Dry run: would post a new comment on {client.kind} {where}:\n{body}")
        else:
          client.post(number, body).raise_for_status()
      commented.append(where)
  except Exception as e:
    response = getattr(e, 'response', None)
    details = f" {response.text[:300]}" if response is not None else ''
    hint = ''
    if response is not None and response.status_code in (401, 403):
      hint = " The workflow needs `pull-requests: write`; pull requests from forks only get a read-only token." if forge == 'github' else " The token needs the `api` scope, and the Reporter role or more."
    return commented, redact(f"could not comment on {forge}: {e}{details}{hint}", forge_token(forge))
  if not commented:
    message = f"no open {client.kind} has the commit {sha[:10]}: nothing to comment"
    if dryrun:
      dryrun(f"Dry run: {message}. On a {client.kind}, qa gate would post:\n{comment_body(result, context)}")
    return [], message
  return commented, None


# ---------------------------------------------------------------------------- output

def format_value(value: Optional[float], check: Dict[str, Any]) -> str:
  if value is None:
    return ''
  if check.get('kind') in ('max_failed_runs', 'require_bit_accuracy'):
    return str(value)
  scaled = value * (check.get('scale') or 1)
  text = f"{scaled:,.0f}" if abs(scaled) >= 10_000 else f"{scaled:.4g}"
  return f"{text}{check.get('suffix') or ''}"


def format_regression(regression: Optional[float]) -> str:
  if regression is None:
    return ''
  if math.isinf(regression):
    return 'worse (reference: 0)' if regression > 0 else 'better (reference: 0)'
  if abs(regression) < 0.0005:
    return 'no change'
  return f"{abs(regression):.1%} {'worse' if regression > 0 else 'better'}"


def format_percent(fraction: float) -> str:
  return f"{fraction * 100:.6g}%"


def check_label(check: Dict[str, Any]) -> str:
  """What a check is about. Those the project's owners set in the web app say so: no commit can change them."""
  kind = check['kind']
  if kind == 'max_failed_runs':
    label = 'failed runs'
  elif kind == 'require_bit_accuracy':
    label = 'bit accuracy'
  elif kind == 'rules':
    label = "the gate's rules"
  elif kind == 'expect_batches':
    label = 'batches with runs'
  elif kind == 'per_test_max_regression':
    worst = check.get('worst')
    label = f"{check['metric']}, each test" + (f" (worst: {worst['test']})" if worst else '')
  else:
    label = f"{check['metric']}, {check.get('aggregate') or 'median'}"
  # Rules for some labels only are in those labels' tables: they don't need saying
  return label + scope_marker(check.get('batch'), 'project rule' if check.get('source') == 'project' else '')


def check_limit(check: Dict[str, Any]) -> str:
  kind = check['kind']
  if kind in ('max_regression', 'per_test_max_regression'):
    return f"{format_percent(check['limit'])} worse"
  if kind == 'min':
    return f"at least {format_value(check['limit'], check)}"
  if kind == 'max':
    return f"at most {format_value(check['limit'], check)}"
  if kind == 'max_failed_runs':
    return f"at most {check['limit']}"
  if kind == 'rules':
    return "not looser than the reference's"
  if kind == 'expect_batches':
    return f"runs from {', '.join(check['limit'])}"
  return 'identical outputs'


def check_new(check: Dict[str, Any]) -> str:
  if check['kind'] == 'rules':
    looser = check.get('looser') or []
    return f"{len(looser)} looser" if looser else ('' if check['status'] == 'unknown' else 'not looser')
  if check['kind'] == 'expect_batches':
    return f"{check['new']} of {len(check['limit'])}" if check.get('new') is not None else ''
  if check['kind'] == 'require_bit_accuracy':
    if check['status'] == 'unknown':
      return f"{check.get('unavailable', '?')} runs not compared"
    return f"{check.get('mismatched', 0)} of {check.get('checked', 0)} runs differ"
  return format_value(check.get('new'), check)


def describe_check(check: Dict[str, Any]) -> str:
  """One line, for statuses and messages"""
  if check.get('message'):
    return check['message']
  change = format_regression(check.get('regression'))
  details = f"{check_new(check)}" + (f" vs {format_value(check.get('ref'), check)}" if check.get('ref') is not None and check['kind'] not in ('max_failed_runs',) else '')
  return f"{check_label(check)}: {change or details} (limit: {check_limit(check)})"


def table_rows(batch: Dict[str, Any]) -> List[List[str]]:
  rows = []
  for check in batch['checks']:
    result = {'pass': 'pass', 'fail': 'FAIL', 'skip': 'skipped', 'unknown': 'unknown'}[check['status']]
    if check.get('message'):
      result = f"{result}: {check['message']}"
    ref = '' if check['kind'] in ('min', 'max', 'require_bit_accuracy', 'rules', 'expect_batches') else format_value(check.get('ref'), check)
    rows.append([check_label(check), check_new(check), ref, format_regression(check.get('regression')), check_limit(check), result])
  return rows


HEADER = ['Check', 'New', 'Reference', 'Change', 'Limit', 'Result']


def batch_title(batch: Dict[str, Any], project: str) -> str:
  commit = batch.get('commit') or {}
  reference = batch.get('reference') or {}
  label = 'CI' if batch['batch'] == 'default' else batch['batch']
  requested = reference.get('requested') or ''
  if reference.get('id'):
    ref = reference['id'][:10] if reference.get('type') == 'commit' else f"{requested} ({reference['id'][:10]})"
  else:
    ref = f"{requested} (not found)"
  runs = commit.get('runs') or {}
  return f"{project} {(commit.get('id') or '')[:10]} vs {ref}, batch {label}: {runs.get('total', 0)} runs, {runs.get('failed', 0)} failed"


def render_text(result: Dict[str, Any]) -> str:
  lines = [f"Quality gate: {result['verdict'].upper()}"]
  for error in result.get('errors') or []:
    lines.append(f"  {error}")
  for batch in result['batches']:
    lines += ['', batch_title(batch, result['project'])]
    lines += [f"  {message}" for message in batch.get('messages') or []]
    rows = table_rows(batch)
    if rows:
      widths = [max(len(r[i]) for r in [HEADER, *rows]) for i in range(len(HEADER))]
      for row in [HEADER, *rows]:
        lines.append('  ' + '  '.join(cell.ljust(width) for cell, width in zip(row, widths)).rstrip())
    for check in batch['checks']:
      for test in check.get('over_limit_tests') or []:
        lines.append(f"    {check['metric']} on {test['test']}: {format_regression(test['regression'])}")
      for test in check.get('differing_tests') or []:
        lines.append(f"    {test['test']}: {', '.join(test['files'] or [])}")
    reruns = describe_reruns(batch.get('reruns'))
    if reruns:
      lines += [f"  {reruns[0]}", *[f"    {line}" for line in reruns[1:]]]
    if batch.get('url'):
      lines.append(f"Metrics Diff: {batch['url']}")
  changes = describe_rules_changes(result.get('rules_changes') or [])
  if changes:
    lines += ['', changes[0], *[f"  {line}" for line in changes[1:]]]
  return '\n'.join(lines)


# Our texts put commands in code spans (`qa batch perf`): kept, inert. Elsewhere, names come from users (tests,
# metrics, labels, batches) or the server (messages): no Markdown or HTML of theirs may render.
CODE_SPAN = re.compile(r'`[^`]+`')
# Outside code spans, what could render as something else than text: HTML (comments that hide what follows, tags),
# entities, emphasis, links and images, the cells' separator, the backslash that would escape ours
MARKDOWN_SPECIAL = re.compile(r'[\\`*~|&<>]|\]\(|\]\[|!\[|(?<![0-9A-Za-z])_|_(?![0-9A-Za-z])')
HTML_ENTITIES = {'&': '&amp;', '<': '&lt;', '>': '&gt;'}


def escape_markdown(text: str) -> str:
  def escape(match: Any) -> str:
    special = match.group(0)
    if special in HTML_ENTITIES:
      return HTML_ENTITIES[special]
    # `](`: escaping the second character is enough to keep it from being a link
    return f"{special[0]}\\{special[1]}" if len(special) == 2 else f"\\{special}"
  # `@name` would notify them: a zero-width space after `@` keeps it from being a mention (an entity for `@`
  # wouldn't, mentions are found in the rendered text)
  return MARKDOWN_SPECIAL.sub(escape, text).replace('@', '@&#8203;')


def markdown_text(text: Any) -> str:
  """
  Text in one line of Markdown, as it is: whatever a test, metric, label name or a server's message has, it can't
  break a table, open an HTML comment that hides what follows, forge our sections' markers, link elsewhere, or
  notify people. Our texts' code spans (`qa batch perf`) stay code: nothing renders in them.
  """
  text = re.sub(r'[\r\n]+', ' ', str(text))
  parts, start = [], 0
  for match in CODE_SPAN.finditer(text):
    parts.append(escape_markdown(text[start:match.start()]))
    # in tables, `|` would still end the cell
    parts.append(match.group(0).replace('|', '\\|'))
    start = match.end()
  parts.append(escape_markdown(text[start:]))
  return ''.join(parts)


def markdown_section(batch: Dict[str, Any], project: str, details: bool = True) -> List[str]:
  """The Markdown of one label's results: its title, the table, then what reviewers should know. `details`: the
  lists of tests, which a long comment leaves out first"""
  title = batch_title(batch, project)
  lines = [f"**{markdown_text(title)}**" + (f" · [Metrics Diff]({batch['url']})" if batch.get('url') else ''), '']
  lines += [f"- {markdown_text(message)}" for message in batch.get('messages') or []]
  if batch.get('messages'):
    lines.append('')
  rows = table_rows(batch)
  if rows:
    lines.append('| ' + ' | '.join(HEADER) + ' |')
    lines.append('|' + '---|' * len(HEADER))
    for row in rows:
      lines.append('| ' + ' | '.join(markdown_text(cell) for cell in row) + ' |')
  lines.append('')
  tests = []
  for check in batch['checks']:
    for test in check.get('over_limit_tests') or []:
      tests.append(f"{check['metric']} on {test['test']}: {format_regression(test['regression'])}")
    for test in check.get('differing_tests') or []:
      tests.append(f"{test['test']}: {', '.join(test['files'] or [])}")
  if tests and details:
    lines += [*[f"- {markdown_text(line)}" for line in tests], '']
  reruns = describe_reruns(batch.get('reruns'))
  if reruns:
    lines += [f"🔁 {markdown_text(reruns[0])}", *([f"- {markdown_text(line)}" for line in reruns[1:]] if details else []), '']
  return lines


def markdown_rules_changes(result: Dict[str, Any]) -> List[str]:
  changes = describe_rules_changes(result.get('rules_changes') or [])
  if not changes:
    return []
  return [f"⚠️ **{markdown_text(changes[0])}**", *[f"- {markdown_text(line)}" for line in changes[1:]], '']


def render_markdown(result: Dict[str, Any]) -> str:
  lines = [f"### Quality gate: {result['verdict']}", '']
  for error in result.get('errors') or []:
    lines.append(f"- {markdown_text(error)}")
  for batch in result['batches']:
    lines += markdown_section(batch, result['project'])
  lines += markdown_rules_changes(result)
  lines.append(f"<sub>{EXPERIMENTAL_NOTICE}</sub>")
  return '\n'.join(lines) + '\n'


def json_safe(value: Any) -> Any:
  """JSON has no Infinity: a regression vs a reference of 0 is null"""
  if isinstance(value, float) and not math.isfinite(value):
    return None
  if isinstance(value, dict):
    return {k: json_safe(v) for k, v in value.items()}
  if isinstance(value, (list, tuple)):
    return [json_safe(v) for v in value]
  return value


def render(result: Dict[str, Any], output_format: str) -> str:
  if output_format == 'json':
    return json.dumps(json_safe(result), indent=2, allow_nan=False)
  if output_format == 'markdown':
    return render_markdown(result)
  return render_text(result)


# ---------------------------------------------------------------------------- the command

def run_gate(gate: GateConfig, project: str, commit: str, fetch: Callable[[str], Tuple[Optional[Dict[str, Any]], Optional[str]]],
             local_metrics: Dict[str, Any], qaboard_url: str) -> Dict[str, Any]:
  """Fetches the comparison of each batch and evaluates the rules. Raises GateConfigError."""
  result: Dict[str, Any] = {
    'verdict': 'undecidable', 'exit_code': 2, 'experimental': True,
    'project': project, 'commit': commit, 'reference': gate.reference, 'rules': [r.to_dict() for r in gate.rules],
    # `batches`: each label's results (its name from before `labels`, that scripts read)
    'labels': list(gate.labels), 'batches': [], 'errors': [], 'rules_changes': [],
  }
  if gate.expect_batches:
    result['expect_batches'] = gate.expect_batches
  # `ci` and `default` are the same results: checked once, else the comment would get two sections for them
  labels: Dict[str, str] = {}
  for label in gate.labels:
    labels.setdefault(section_label(label), label)
  for label in labels.values():
    data, error = fetch(label)
    # The project's rules come with the numbers. When they need more than we asked for (other metrics, the
    # comparison of the runs' files), we ask again: `fetch` reads what the gate needs.
    if data is not None and gate.project is None and apply_project_gate(gate, data.get('project_gate')):
      data, error = fetch(label)
    if data is None:
      result['errors'].append(error)
      result['batches'].append({'batch': label, 'label': label, 'verdict': 'undecidable', 'status': 'missing', 'messages': [error], 'checks': [], 'url': None})
      continue
    reference = data.get('reference') or {}
    changes = rules_changes(gate, reference.get('gate')) if reference_rules_known(reference.get('gate')) else None
    evaluation = evaluate_batch(data, gate, local_metrics, changes, label=label)
    new_label = (data.get('commit') or {}).get('batch') or label
    url = metrics_diff_url(qaboard_url, project, data['commit']['id'], reference.get('id'), new_label, reference.get('batch') or new_label) if data.get('commit') else None
    result['batches'].append({
      'batch': new_label,
      'label': new_label,
      'verdict': evaluation['verdict'],
      'status': data.get('status'),
      'messages': data.get('messages') or [],
      'commit': data.get('commit'),
      'reference': reference,
      'checks': evaluation['checks'],
      'bit_accuracy': data.get('bit_accuracy'),
      'reruns': reruns_summary(data),
      'url': url,
    })
    # the reference is the same for every batch
    if not result['rules_changes']:
      result['rules_changes'] = changes or []
  if gate.project is not None:
    result['project_rules'] = [r.to_dict() for r in gate.project.rules]
    result['on_looser_rules'] = gate.on_looser_rules
    if gate.project.expect_batches:
      result['project_expect_batches'] = gate.project.expect_batches
  result['verdict'] = overall_verdict([b['verdict'] for b in result['batches']])
  result['exit_code'] = EXIT_CODES[result['verdict']]
  return result


@click.command()
@click.option('--reference', help="Compare with this branch, milestone (its name, or #<id> from its link) or commit. Default: gate.reference in qaboard.yaml, else project.reference_branch.")
@click.option('--label', 'labels', multiple=True, help="The label of the results to check, as `qa --label` sets it (repeat for several). Default: gate.labels, else the CI's (default).")
@click.option('--batch', '-b', 'batches', multiple=True, help="Same as --label, its older name.")
@click.option('--commit', 'commit', help="The commit to check. Default: the current commit.")
@click.option('--format', 'output_format', type=click.Choice(['text', 'markdown', 'json']), default='text', show_default=True, help="Output format.")
@click.option('--json', 'as_json', is_flag=True, help="Same as --format json.")
@click.option('--wait', is_flag=True, help="While the verdict is undecidable (e.g. the reference is still running), check again until --timeout.")
@click.option('--timeout', type=float, default=1800, show_default=True, help="With --wait, give up after this many seconds.")
@click.option('--interval', type=float, default=30, show_default=True, help="With --wait, seconds between checks.")
@click.option('--post-status', type=click.Choice(['github', 'gitlab']), help="Post a commit status that links to the Metrics Diff.")
@click.option('--post-comment', 'comment_on', type=click.Choice(['github', 'gitlab']), help="Post the result as a comment on the commit's open pull request (merge request), or update the one posted before.")
@click.option('--server', help="The QA-Board URL, e.g. http://localhost:5151. Default: from QABOARD_URL or your site's settings.")
@click.pass_context
def gate(ctx, reference, labels, batches, commit, output_format, as_json, wait, timeout, interval, post_status, comment_on, server):
  """Fail when quality regresses vs a reference (experimental). Exit codes: 0 pass, 1 fail, 2 undecidable."""
  from .config import config, available_metrics, commit_id, project, project_root, subproject, default_batch_label
  from . import api
  from .credentials import resolve_token
  click.secho(EXPERIMENTAL_NOTICE, fg='yellow', err=True)
  output_format = 'json' if as_json else output_format
  obj = ctx.obj or {}
  dryrun = bool(obj.get('dryrun'))
  # `qa --label nightly gate` checks the results `qa --label nightly batch ...` made
  top_label = obj.get('raw_batch_label')
  labels = [*labels, *batches] or ([top_label] if top_label and top_label != default_batch_label else [])

  try:
    gate_config = parse_config(config)
  except GateConfigError as e:
    click.secho(f"ERROR: {e}", fg='red', bold=True, err=True)
    sys.exit(EXIT_CODES['fail'])
  if reference:
    gate_config.reference = reference
  if not gate_config.reference:
    gate_config.reference = 'master'
  if labels:
    gate_config.labels = list(dict.fromkeys(labels))

  commit = commit or commit_id
  project_name = Path(project).as_posix() if project else None
  if not commit or not project_name or commit.startswith('<local'):
    click.secho("ERROR: qa gate needs a project (qaboard.yaml) and a git commit, or --commit", fg='red', bold=True, err=True)
    sys.exit(EXIT_CODES['undecidable'])

  qaboard_url = server.rstrip('/') if server else api.qaboard_url
  api_prefix = f"{qaboard_url}/api/v1" if server else api.api_prefix
  # the token qa uses for another server, if any
  headers = api.headers_for(qaboard_url) if server else api.headers
  token_source = resolve_token(qaboard_url)[1] if server else api.qa_token_source
  def fetch(label):
    # what the gate needs now: after the first answer, also for the project's rules
    return fetch_comparison(api_prefix, project_name, commit, gate_config.reference, label, gate_config.metrics,
                            gate_config.needs_bit_accuracy, headers, api.api_verify, token_source)

  deadline = time.monotonic() + timeout
  while True:
    try:
      result = run_gate(gate_config, project_name, commit, fetch, available_metrics, qaboard_url)
    except GateConfigError as e:
      click.secho(f"ERROR: {e}", fg='red', bold=True, err=True)
      sys.exit(EXIT_CODES['fail'])
    if result['verdict'] != 'undecidable' or not wait or time.monotonic() + interval > deadline:
      break
    # e.g. a batch the gate expects has no runs yet
    reasons = [m for b in result['batches'] for m in undecidable_reasons(b)] or ['undecidable']
    click.secho(f"Waiting {interval:g}s: {' '.join(reasons)}", dim=True, err=True)
    time.sleep(interval)

  click.echo(render(result, output_format))
  step_summary = os.environ.get('GITHUB_STEP_SUMMARY')
  if step_summary:
    try:
      with open(step_summary, 'a') as f:
        f.write(render_markdown(result))
    except OSError as e:
      click.secho(f"WARNING: could not write the job summary: {e}", fg='yellow', err=True)
  context = 'qaboard/gate' + (f"/{Path(subproject).as_posix()}" if subproject and Path(subproject) != Path('.') else '')
  forge_project = Path(project_root).as_posix() if project_root else project_name
  if post_status and dryrun:
    click.secho(f"Dry run: would post the commit status {context} on {post_status}: {status_description(result)}", err=True)
  elif post_status:
    error = post_commit_status(post_status, result, context, forge_project)
    if error:
      click.secho(f"WARNING: {error}", fg='yellow', err=True)
  if comment_on:
    commented, error = post_comment(comment_on, result, context, forge_project, dryrun=(lambda text: click.echo(text, err=True)) if dryrun else None)
    if commented:
      click.secho(f"{'Would comment' if dryrun else 'Commented'} on {', '.join(commented)}", dim=True, err=True)
    if error and not commented and error.startswith('no open'):
      # a push without a pull request is not a problem
      click.secho(error, dim=True, err=True)
    elif error:
      click.secho(f"WARNING: {error}", fg='yellow', err=True)
  sys.exit(result['exit_code'])
