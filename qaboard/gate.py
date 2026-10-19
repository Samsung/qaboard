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

# Floating point noise should not decide a verdict: a 10.0000000001% regression is a 10% regression
EPSILON = 1e-9


class GateConfigError(ValueError):
  pass


@dataclass
class Rule:
  metric: str
  kind: str  # one of RULE_KINDS
  limit: float

  def to_dict(self) -> Dict[str, Any]:
    return {'metric': self.metric, 'kind': self.kind, 'limit': self.limit}


@dataclass
class GateConfig:
  reference: Optional[str] = None
  batches: List[str] = field(default_factory=lambda: ['default'])
  rules: List[Rule] = field(default_factory=list)
  max_failed_runs: Optional[int] = 0
  require_bit_accuracy: bool = False

  @property
  def metrics(self) -> List[str]:
    return list(dict.fromkeys(rule.metric for rule in self.rules))


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
    unknown = set(rule) - {'metric', *RULE_KINDS}
    if unknown:
      raise GateConfigError(f"{where}: unknown keys {', '.join(sorted(unknown))}. Use: metric, {', '.join(RULE_KINDS)}")
    kinds = [k for k in RULE_KINDS if k in rule]
    if not kinds:
      raise GateConfigError(f"{where}: give a limit for {rule['metric']}: {', '.join(RULE_KINDS)}")
    for kind in kinds:
      if kind in ('min', 'max'):
        limit = parse_number(rule[kind], f"{where}.{kind}")
      else:
        limit = parse_fraction(rule[kind], f"{where}.{kind}")
      rules.append(Rule(metric=str(rule['metric']), kind=kind, limit=limit))

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
  check['new'] = info['new']['median']
  check['ref'] = info['ref']['median']

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
    if not info['ref']['count']:
      return {**check, 'status': 'skip', 'message': f"the reference has no values of {rule.metric}"}
    check['change'] = info.get('delta_relative')
    check['regression'] = regression_of(info.get('delta_relative'), info.get('delta'), is_smaller_better)
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


def evaluate_batch(data: Dict[str, Any], gate: GateConfig, local_metrics: Dict[str, Any]) -> Dict[str, Any]:
  """The checks of one batch, and its verdict: pass, fail or undecidable"""
  checks = [check_rule(rule, data, local_metrics) for rule in gate.rules]
  runs = (data.get('commit') or {}).get('runs') or {}
  if gate.max_failed_runs is not None:
    failed = runs.get('failed', 0)
    checks.append({
      'kind': 'max_failed_runs', 'metric': None, 'limit': gate.max_failed_runs, 'new': failed,
      'ref': ((data.get('reference') or {}).get('runs') or {}).get('failed'),
      'status': 'pass' if failed <= gate.max_failed_runs else 'fail', 'message': '',
    })
  if gate.require_bit_accuracy:
    counts = data.get('bit_accuracy') or {}
    check = {'kind': 'require_bit_accuracy', 'metric': None, 'limit': None, **counts, 'message': ''}
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
                     bit_accuracy: bool, headers: Dict[str, str], verify: Any) -> Tuple[Optional[Dict[str, Any]], Optional[str]]:
  """GET /api/v1/commit/<sha>/compare. Returns (data, None), or (None, why it failed)"""
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
  kind = check['kind']
  if kind == 'max_failed_runs':
    return 'failed runs'
  if kind == 'require_bit_accuracy':
    return 'bit accuracy'
  if kind == 'per_test_max_regression':
    worst = check.get('worst')
    return f"{check['metric']}, each test" + (f" (worst: {worst['test']})" if worst else '')
  return f"{check['metric']}, median"


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
  return 'identical outputs'


def check_new(check: Dict[str, Any]) -> str:
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
    ref = '' if check['kind'] in ('min', 'max', 'require_bit_accuracy') else format_value(check.get('ref'), check)
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
    if batch.get('url'):
      lines.append(f"Metrics Diff: {batch['url']}")
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
    'batches': [], 'errors': [],
  }
  for label in gate.batches:
    data, error = fetch(label)
    if data is None:
      result['errors'].append(error)
      result['batches'].append({'batch': label, 'verdict': 'undecidable', 'status': 'missing', 'messages': [error], 'checks': [], 'url': None})
      continue
    evaluation = evaluate_batch(data, gate, local_metrics)
    reference = data.get('reference') or {}
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
      'url': url,
    })
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
@click.option('--server', help="The QA-Board URL, e.g. http://localhost:5151. Default: from QABOARD_URL or your site's settings.")
@click.pass_context
def gate(ctx, reference, batches, commit, output_format, as_json, wait, timeout, interval, post_status, server):
  """Fail when quality regresses vs a reference (experimental). Exit codes: 0 pass, 1 fail, 2 undecidable."""
  from .config import config, available_metrics, commit_id, project, project_root, subproject
  from . import api
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
  def fetch(label):
    return fetch_comparison(api_prefix, project_name, commit, gate_config.reference, label, gate_config.metrics,
                            gate_config.require_bit_accuracy, api.headers, api.api_verify)

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
  if post_status:
    context = 'qaboard/gate' + (f"/{Path(subproject).as_posix()}" if subproject and Path(subproject) != Path('.') else '')
    error = post_commit_status(post_status, result, context, Path(project_root).as_posix() if project_root else project_name)
    if error:
      click.secho(f"WARNING: {error}", fg='yellow', err=True)
  sys.exit(result['exit_code'])
