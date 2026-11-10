"""
`qa gate`: fails the CI when quality regresses against a reference. Experimental: may change without notice.

The rules are in the `gate:` section of qaboard.yaml. The numbers come from the server
(GET /api/v1/commit/<sha>/compare), and are the ones the web app's Summary and Metrics Diff show.

Exit codes: 0 pass, 1 fail (a rule failed, or the gate's configuration has an error),
2 undecidable (the reference or the runs are missing or still running, the server can't be reached).
"""
import os
import sys
import json
import math
import statistics
import time
from pathlib import Path
from dataclasses import dataclass, field
from typing import Any, Callable, Dict, List, Optional, Tuple
from urllib.parse import quote, urlencode

import click


EXIT_CODES = {'pass': 0, 'fail': 1, 'undecidable': 2}
EXPERIMENTAL_NOTICE = "qa gate is experimental: its configuration and output may change without notice."

GATE_KEYS = {'reference', 'batches', 'rules', 'max_failed_runs', 'require_bit_accuracy'}
RULE_KINDS = ('max_regression', 'per_test_max_regression', 'min', 'max')
# How the rules on all the runs (min, max, max_regression) aggregate them. The server gives medians, the others are
# computed from each test's values: e.g. `max` for 0/1 metrics that no test may have.
AGGREGATES = ('median', 'mean', 'min', 'max')

# Floating point noise should not decide a verdict: a 10.0000000001% regression is a 10% regression
EPSILON = 1e-9


class GateConfigError(ValueError):
  pass


@dataclass
class Rule:
  metric: str
  kind: str  # one of RULE_KINDS
  limit: float
  aggregate: Optional[str] = None  # one of AGGREGATES, None for per_test_max_regression

  def to_dict(self) -> Dict[str, Any]:
    rule: Dict[str, Any] = {'metric': self.metric, 'kind': self.kind, 'limit': self.limit}
    if self.aggregate is not None:
      rule['aggregate'] = self.aggregate
    return rule


@dataclass
class GateConfig:
  reference: Optional[str] = None
  batches: List[str] = field(default_factory=lambda: ['default'])
  rules: List[Rule] = field(default_factory=list)
  max_failed_runs: Optional[int] = 0
  require_bit_accuracy: bool = False
  # What the project's owners set in the web app (docs/rfcs/project-admin.md), learned from the server with the
  # numbers: rules checked on top of ours, that no commit can change. None until we know, or if they set none.
  project: Optional['GateConfig'] = None
  # When our rules are looser than the reference's: 'warn' says so, 'fail' fails the gate. The project decides.
  on_looser_rules: str = 'warn'

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


def apply_project_gate(gate: GateConfig, project_gate: Any) -> bool:
  """
  Adds the project's settings, as the server gives them, to the gate. Returns whether we must ask the server again:
  the project's rules need metrics we didn't ask for, or the comparison of the runs' files.
  Raises GateConfigError if we can't read them: a newer server's settings must not be half-applied.
  """
  if not isinstance(project_gate, dict):
    return False
  asked_metrics, asked_bit_accuracy = set(gate.metrics), gate.needs_bit_accuracy
  unknown = set(project_gate) - {'rules', 'max_failed_runs', 'require_bit_accuracy', 'on_looser_rules'}
  if unknown:
    raise GateConfigError(f"the project's gate settings have keys this version of qa doesn't know ({', '.join(sorted(unknown))}): upgrade qaboard")
  try:
    project = parse_config({'gate': {
      'rules': project_gate.get('rules') or [],
      'max_failed_runs': project_gate.get('max_failed_runs'),
      'require_bit_accuracy': bool(project_gate.get('require_bit_accuracy')),
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
  batches = gate.get('batches', ['default'])
  if isinstance(batches, str):
    batches = [batches]
  if not isinstance(batches, list) or not batches or not all(isinstance(b, (str, int)) for b in batches):
    raise GateConfigError("gate.batches: expected a list of batch labels, e.g. [default]")

  rules = []
  rules_config = gate.get('rules') or []
  if not isinstance(rules_config, list):
    raise GateConfigError("gate.rules: expected a list, e.g. [{metric: psnr, max_regression: 1%}]")
  for index, rule in enumerate(rules_config):
    where = f"gate.rules[{index}]"
    if not isinstance(rule, dict) or not rule.get('metric'):
      raise GateConfigError(f"{where}: expected a mapping with a `metric`, e.g. {{metric: psnr, max_regression: 1%}}")
    unknown = set(rule) - {'metric', 'aggregate', *RULE_KINDS}
    if unknown:
      raise GateConfigError(f"{where}: unknown keys {', '.join(sorted(unknown))}. Use: metric, {', '.join(RULE_KINDS)}, aggregate")
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
      rules.append(Rule(metric=str(rule['metric']), kind=kind, limit=limit, aggregate=rule_aggregate))

  max_failed_runs = gate.get('max_failed_runs', 0)
  if max_failed_runs is not None and (isinstance(max_failed_runs, bool) or not isinstance(max_failed_runs, int) or max_failed_runs < 0):
    raise GateConfigError(f"gate.max_failed_runs: expected a number of runs, got {max_failed_runs!r}")
  require_bit_accuracy = gate.get('require_bit_accuracy', False)
  if not isinstance(require_bit_accuracy, bool):
    raise GateConfigError(f"gate.require_bit_accuracy: expected true or false, got {require_bit_accuracy!r}")
  return GateConfig(
    reference=str(reference) if reference is not None else None,
    batches=[str(b) for b in batches],
    rules=rules,
    max_failed_runs=max_failed_runs,
    require_bit_accuracy=require_bit_accuracy,
  )


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
  check: Dict[str, Any] = {**rule.to_dict(), 'status': 'pass', 'message': ''}
  if info:
    check.update(label=info.get('label') or rule.metric, scale=info.get('scale') or 1, suffix=info.get('suffix') or '')
  if not info or not info['new']['count']:
    return {**check, 'status': 'fail', 'message': f"no values of {rule.metric} in the new runs"}
  # medians are the server's numbers, those of the Summary. Other aggregates come from each test's values
  aggregate = rule.aggregate or 'median'
  if aggregate == 'median':
    check['new'] = info['new']['median']
    check['ref'] = info['ref']['median']
  else:
    new_values, ref_values = tests_values(data.get('tests') or [], rule.metric)
    if not new_values:
      return {**check, 'status': 'fail', 'message': f"no values of {rule.metric} in the new runs"}
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
    if not info['ref']['count'] or check['ref'] is None:
      return {**check, 'status': 'skip', 'message': f"the reference has no values of {rule.metric}"}
    if aggregate == 'median':
      change, delta = info.get('delta_relative'), info.get('delta')
    else:
      change, delta = relative_change(check['new'], check['ref']), check['new'] - check['ref']
    check['change'] = change
    check['regression'] = regression_of(change, delta, is_smaller_better)
    ok = check['regression'] is not None and check['regression'] <= rule.limit + EPSILON
    return {**check, 'status': 'pass' if ok else 'fail'}

  # per_test_max_regression
  tests = data.get('tests') or []
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
    new=cell['new'], ref=cell['ref'], change=cell.get('delta_relative'), regression=worst_regression,
    worst={'id': worst.get('id'), 'reference_id': worst.get('reference_id'), 'test': name_of_test(worst, tests)},
    tests_compared=len(regressions), over_limit=len(over),
    over_limit_tests=[{'test': name_of_test(t, tests), 'regression': r} for r, t, _ in over[:10]],
  )
  return {**check, 'status': 'fail' if over else 'pass'}


def evaluate_batch(data: Dict[str, Any], gate: GateConfig, local_metrics: Dict[str, Any], changes: Optional[List[Dict[str, Any]]] = None) -> Dict[str, Any]:
  """
  The checks of one batch, and its verdict: pass, fail or undecidable.
  `changes`: how our rules differ from the reference's (rules_changes), None when we can't tell.
  """
  checks = [check_rule(rule, data, local_metrics) for rule in gate.rules]
  # the project's rules, set by its owners in the web app: checked like ours, whatever ours say
  if gate.project:
    checks += [{**check_rule(rule, data, local_metrics), 'source': 'project'} for rule in gate.project.rules]
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


def rule_label(rule: Rule) -> str:
  if rule.kind == 'per_test_max_regression':
    return f"{rule.metric}, each test"
  return f"{rule.metric}, {rule.aggregate or 'median'}, {rule.kind.replace('_', ' ')}"


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
  def by_key(rules: List[Rule]) -> Dict[Tuple[str, str, Optional[str]], Rule]:
    return {(r.metric, r.kind, r.aggregate): r for r in rules}
  old_rules, new_rules = by_key(before.rules), by_key(gate.rules)
  changes: List[Dict[str, Any]] = []
  for key, rule in old_rules.items():
    if key not in new_rules:
      changes.append({'text': f"{rule_label(rule)}: removed (was {rule_limit(rule)})", 'looser': True})
  for key, rule in new_rules.items():
    old = old_rules.get(key)
    if old is None:
      changes.append({'text': f"{rule_label(rule)}: new ({rule_limit(rule)})", 'looser': False})
    elif abs(old.limit - rule.limit) > EPSILON:
      # a floor is looser when it goes down, the other limits when they go up
      looser = rule.limit < old.limit if rule.kind == 'min' else rule.limit > old.limit
      changes.append({'text': f"{rule_label(rule)}: {rule_limit(old)} → {rule_limit(rule)}", 'looser': looser})
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
    return None, f"could not reach QA-Board at {url}: {e}"
  if r.status_code == 404:
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
    return None, f"QA-Board answered {r.status_code}: {r.text[:300]}"


def status_description(result: Dict[str, Any]) -> str:
  """One line for a commit status (GitHub keeps 140 characters)"""
  verdict = result['verdict']
  for batch in result['batches']:
    failed = [c for c in batch['checks'] if c['status'] == 'fail']
    if verdict == 'fail' and failed:
      return f"fail: {describe_check(failed[0])}"[:140]
    if verdict == 'undecidable' and batch['verdict'] == 'undecidable':
      reason = (batch.get('messages') or ['the reference or the runs are missing'])[0]
      return f"undecidable: {reason}"[:140]
  if result.get('errors'):
    return f"undecidable: {result['errors'][0]}"[:140]
  checks = sum(len(b['checks']) for b in result['batches'])
  return f"pass: {checks} checks vs {result['reference'] or 'the reference'}"[:140]


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
      token, repository = os.environ.get('GITHUB_TOKEN'), os.environ.get('GITHUB_REPOSITORY')
      if not token or not repository:
        return "--post-status github needs GITHUB_TOKEN and GITHUB_REPOSITORY (set by GitHub Actions)"
      api = os.environ.get('GITHUB_API_URL', 'https://api.github.com').rstrip('/')
      state = {'pass': 'success', 'fail': 'failure', 'undecidable': 'error'}[verdict]
      r = requests.post(
        f"{api}/repos/{repository}/statuses/{sha}",
        json={'state': state, 'target_url': target_url, 'description': description, 'context': context},
        headers={'Authorization': f'Bearer {token}', 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28'},
        timeout=60,
      )
    else:
      token = site_config('GITLAB_ACCESS_TOKEN')
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
      r = requests.post(f"{api}/projects/{project_id}/statuses/{sha}", json=payload, headers={'PRIVATE-TOKEN': token}, timeout=60)
    r.raise_for_status()
  except Exception as e:
    response = getattr(e, 'response', None)
    details = f" {response.text[:300]}" if response is not None else ''
    return f"could not post the commit status to {forge}: {e}{details}"
  return None


# One comment per pull request and gate (a subproject has its own): we find ours by this hidden line, and update it
def comment_marker(context: str) -> str:
  return f"<!-- {context} -->"


# GitHub refuses comments over 65,536 characters, GitLab over 1,000,000
MAX_COMMENT_LENGTH = 60_000
MAX_PULL_REQUESTS = 3
MAX_COMMENT_PAGES = 20


def comment_body(result: Dict[str, Any], context: str) -> str:
  """The Markdown of the comment: the gate's tables, what reviewers should know, and which commit it's about."""
  body = render_markdown(result)
  if len(body) > MAX_COMMENT_LENGTH:
    body = body[:MAX_COMMENT_LENGTH].rsplit('\n', 1)[0] + '\n\n…the rest is in the Metrics Diff.\n'
  commit = str(result.get('commit') or '')[:10]
  return f"{comment_marker(context)}\n{body}\n<sub>For commit {commit}. `qa gate` updates this comment when new results come in.</sub>\n"


def github_pull_requests(session, api: str, repository: str, sha: str) -> List[int]:
  """The open pull requests the commit belongs to: the one of the workflow's event, else those GitHub knows for the commit"""
  import re
  match = re.match(r'refs/pull/(\d+)/', os.environ.get('GITHUB_REF', ''))
  if match:
    return [int(match.group(1))]
  r = session.get(f"{api}/repos/{repository}/commits/{sha}/pulls", params={'per_page': 100}, timeout=60)
  r.raise_for_status()
  return [pull['number'] for pull in r.json() if pull.get('state') == 'open'][:MAX_PULL_REQUESTS]


def gitlab_merge_requests(session, api: str, project_id: str, sha: str) -> List[int]:
  if os.environ.get('CI_MERGE_REQUEST_IID'):
    return [int(os.environ['CI_MERGE_REQUEST_IID'])]
  r = session.get(f"{api}/projects/{project_id}/repository/commits/{sha}/merge_requests", timeout=60)
  r.raise_for_status()
  return [mr['iid'] for mr in r.json() if mr.get('state') == 'opened'][:MAX_PULL_REQUESTS]


def find_comments(session, url: str, marker: str) -> List[Dict[str, Any]]:
  """The comments with our marker among those `url` lists, page by page"""
  found = []
  for page in range(1, MAX_COMMENT_PAGES + 1):
    r = session.get(url, params={'per_page': 100, 'page': page}, timeout=60)
    r.raise_for_status()
    comments = r.json()
    found += [comment for comment in comments if marker in (comment.get('body') or '')]
    if len(comments) < 100:
      break
  return found


def update_or_post(comments: List[Dict[str, Any]], update: Callable[[Dict[str, Any]], Any], post: Callable[[], Any]) -> None:
  """
  Updates the first comment we're allowed to edit, else posts a new one. Anyone can write our marker in a comment
  of their own: we can't edit theirs (403, or 404), and that must not keep the gate's comment away.
  """
  for comment in comments:
    r = update(comment)
    if r.status_code in (403, 404):
      continue
    r.raise_for_status()
    return
  post().raise_for_status()


def post_comment(forge: str, result: Dict[str, Any], context: str, project_root: str) -> Tuple[List[str], Optional[str]]:
  """
  Posts the gate's result as a comment on the commit's open pull requests (GitLab: merge requests), or updates the
  comment it posted before: reviewers read one comment, about the latest results.
  Returns (the pull requests commented, like "#12", and why it could not, or None).
  """
  import requests
  from .site_config import site_config
  sha = result['commit']
  body, marker = comment_body(result, context), comment_marker(context)
  session = requests.Session()
  commented: List[str] = []
  try:
    if forge == 'github':
      token, repository = os.environ.get('GITHUB_TOKEN'), os.environ.get('GITHUB_REPOSITORY')
      if not token or not repository:
        return [], "--post-comment github needs GITHUB_TOKEN and GITHUB_REPOSITORY (set by GitHub Actions)"
      api = os.environ.get('GITHUB_API_URL', 'https://api.github.com').rstrip('/')
      session.headers.update({'Authorization': f'Bearer {token}', 'Accept': 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28'})
      for number in github_pull_requests(session, api, repository, sha):
        comments_url = f"{api}/repos/{repository}/issues/{number}/comments"
        update_or_post(
          find_comments(session, comments_url, marker),
          lambda comment: session.patch(f"{api}/repos/{repository}/issues/comments/{comment['id']}", json={'body': body}, timeout=60),
          lambda: session.post(comments_url, json={'body': body}, timeout=60),
        )
        commented.append(f"#{number}")
    else:
      token = site_config('GITLAB_ACCESS_TOKEN')
      if not token:
        return [], "--post-comment gitlab needs a token with the `api` scope in GITLAB_ACCESS_TOKEN"
      api = os.environ.get('CI_API_V4_URL') or f"{site_config('GITLAB_HOST', 'https://gitlab.com').rstrip('/')}/api/v4"
      project_id = os.environ.get('CI_PROJECT_ID') or quote(project_root, safe='')
      session.headers.update({'PRIVATE-TOKEN': token})
      for iid in gitlab_merge_requests(session, api, project_id, sha):
        notes_url = f"{api}/projects/{project_id}/merge_requests/{iid}/notes"
        update_or_post(
          find_comments(session, notes_url, marker),
          lambda note: session.put(f"{notes_url}/{note['id']}", json={'body': body}, timeout=60),
          lambda: session.post(notes_url, json={'body': body}, timeout=60),
        )
        commented.append(f"!{iid}")
  except Exception as e:
    response = getattr(e, 'response', None)
    details = f" {response.text[:300]}" if response is not None else ''
    hint = ''
    if response is not None and response.status_code in (401, 403):
      hint = " The workflow needs `pull-requests: write`; pull requests from forks only get a read-only token." if forge == 'github' else " The token needs the `api` scope, and the Reporter role or more."
    return commented, f"could not comment on {forge}: {e}{details}{hint}"
  if not commented:
    return [], f"no open {'pull' if forge == 'github' else 'merge'} request has the commit {sha[:10]}: nothing to comment"
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
  elif kind == 'per_test_max_regression':
    worst = check.get('worst')
    label = f"{check['metric']}, each test" + (f" (worst: {worst['test']})" if worst else '')
  else:
    label = f"{check['metric']}, {check.get('aggregate') or 'median'}"
  return f"{label} [project rule]" if check.get('source') == 'project' else label


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
  return 'identical outputs'


def check_new(check: Dict[str, Any]) -> str:
  if check['kind'] == 'rules':
    looser = check.get('looser') or []
    return f"{len(looser)} looser" if looser else ('' if check['status'] == 'unknown' else 'not looser')
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
    ref = '' if check['kind'] in ('min', 'max', 'require_bit_accuracy', 'rules') else format_value(check.get('ref'), check)
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


def markdown_cell(text: str) -> str:
  return text.replace('|', '\\|').replace('\n', ' ')


def render_markdown(result: Dict[str, Any]) -> str:
  lines = [f"### Quality gate: {result['verdict']}", '']
  for error in result.get('errors') or []:
    lines.append(f"- {markdown_cell(error)}")
  for batch in result['batches']:
    title = batch_title(batch, result['project'])
    lines += [f"**{markdown_cell(title)}**" + (f" · [Metrics Diff]({batch['url']})" if batch.get('url') else ''), '']
    lines += [f"- {markdown_cell(message)}" for message in batch.get('messages') or []]
    rows = table_rows(batch)
    if rows:
      lines.append('| ' + ' | '.join(HEADER) + ' |')
      lines.append('|' + '---|' * len(HEADER))
      for row in rows:
        lines.append('| ' + ' | '.join(markdown_cell(cell) for cell in row) + ' |')
    lines.append('')
    details = []
    for check in batch['checks']:
      for test in check.get('over_limit_tests') or []:
        details.append(f"{check['metric']} on {test['test']}: {format_regression(test['regression'])}")
      for test in check.get('differing_tests') or []:
        details.append(f"{test['test']}: {', '.join(test['files'] or [])}")
    if details:
      lines += [*[f"- {markdown_cell(line)}" for line in details], '']
    reruns = describe_reruns(batch.get('reruns'))
    if reruns:
      lines += [f"🔁 {markdown_cell(reruns[0])}", *[f"- {markdown_cell(line)}" for line in reruns[1:]], '']
  changes = describe_rules_changes(result.get('rules_changes') or [])
  if changes:
    lines += [f"⚠️ **{markdown_cell(changes[0])}**", *[f"- {markdown_cell(line)}" for line in changes[1:]], '']
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
    'batches': [], 'errors': [], 'rules_changes': [],
  }
  for label in gate.batches:
    data, error = fetch(label)
    # The project's rules come with the numbers. When they need more than we asked for (other metrics, the
    # comparison of the runs' files), we ask again: `fetch` reads what the gate needs.
    if data is not None and gate.project is None and apply_project_gate(gate, data.get('project_gate')):
      data, error = fetch(label)
    if data is None:
      result['errors'].append(error)
      result['batches'].append({'batch': label, 'verdict': 'undecidable', 'status': 'missing', 'messages': [error], 'checks': [], 'url': None})
      continue
    reference = data.get('reference') or {}
    changes = rules_changes(gate, reference.get('gate')) if reference_rules_known(reference.get('gate')) else None
    evaluation = evaluate_batch(data, gate, local_metrics, changes)
    new_label = (data.get('commit') or {}).get('batch') or label
    url = metrics_diff_url(qaboard_url, project, data['commit']['id'], reference.get('id'), new_label, reference.get('batch') or new_label) if data.get('commit') else None
    result['batches'].append({
      'batch': new_label,
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
  result['verdict'] = overall_verdict([b['verdict'] for b in result['batches']])
  result['exit_code'] = EXIT_CODES[result['verdict']]
  return result


@click.command()
@click.option('--reference', help="Compare with this branch, milestone (its name, or #<id> from its link) or commit. Default: gate.reference in qaboard.yaml, else project.reference_branch.")
@click.option('--batch', '-b', 'batches', multiple=True, help="The label of a batch to check (repeat for several). Default: gate.batches, else the CI batch (default).")
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
def gate(ctx, reference, batches, commit, output_format, as_json, wait, timeout, interval, post_status, comment_on, server):
  """Fail when quality regresses vs a reference (experimental). Exit codes: 0 pass, 1 fail, 2 undecidable."""
  from .config import config, available_metrics, commit_id, project, project_root, subproject
  from . import api
  from .credentials import resolve_token
  click.secho(EXPERIMENTAL_NOTICE, fg='yellow', err=True)
  output_format = 'json' if as_json else output_format

  try:
    gate_config = parse_config(config)
  except GateConfigError as e:
    click.secho(f"ERROR: {e}", fg='red', bold=True, err=True)
    sys.exit(EXIT_CODES['fail'])
  if reference:
    gate_config.reference = reference
  if not gate_config.reference:
    gate_config.reference = 'master'
  if batches:
    gate_config.batches = list(batches)

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
    reasons = [m for b in result['batches'] for m in b.get('messages') or []] or ['undecidable']
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
  if post_status:
    error = post_commit_status(post_status, result, context, forge_project)
    if error:
      click.secho(f"WARNING: {error}", fg='yellow', err=True)
  if comment_on:
    commented, error = post_comment(comment_on, result, context, forge_project)
    if commented:
      click.secho(f"Commented on {', '.join(commented)}", dim=True, err=True)
    if error and not commented and error.startswith('no open'):
      # a push without a pull request is not a problem
      click.secho(error, dim=True, err=True)
    elif error:
      click.secho(f"WARNING: {error}", fg='yellow', err=True)
  sys.exit(result['exit_code'])
