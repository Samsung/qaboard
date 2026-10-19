"""
The email users get when a batch they started ends: what we say (summarize) and how (render).
Pure functions, tested in tests/test_notifications.py. backend/notifications/batches.py gathers the data.

The HTML must look good in Outlook 2016/2019 (Word's HTML engine): tables for layout, inline styles,
bgcolor attributes, no flexbox, grid, CSS variables, background images or web fonts. Buttons use VML for Outlook.
"""
import math
import json
import statistics
from pathlib import Path
from urllib.parse import quote, urlencode

from jinja2 import Environment, FileSystemLoader, select_autoescape


MAX_FAILED_RUNS = 8
MAX_COMBINATIONS = 5
MAX_METRICS = 6

# Blueprint's palette, like the web app
colors = {
  'success': {'accent': '#238551', 'background': '#E8F4EE', 'text': '#1C6E42'},
  'warning': {'accent': '#C87619', 'background': '#FBF0E2', 'text': '#935610'},
  'danger': {'accent': '#CD4246', 'background': '#FAE9E9', 'text': '#AC2F33'},
}


def median(values):
  values = [v for v in values if isinstance(v, (int, float)) and not isinstance(v, bool) and math.isfinite(v)]
  return statistics.median(values) if values else None


def format_number(x) -> str:
  if x is None:
    return '–'
  if x == 0:
    return '0'
  a = abs(x)
  if a >= 1000:
    return f"{x:,.0f}"
  if a < 0.001:
    return f"{x:.2e}"
  decimals = 0 if a >= 100 else 1 if a >= 10 else 2 if a >= 1 else 3
  text = f"{x:.{decimals}f}"
  return text.rstrip('0').rstrip('.') if '.' in text else text


def format_metric(value, info) -> str:
  if value is None:
    return '–'
  scale = info.get('scale', 1)
  scale = scale if isinstance(scale, (int, float)) and not isinstance(scale, bool) else 1
  return f"{format_number(value * scale)}{info.get('suffix', '')}"


def smaller_is_better(info) -> bool:
  value = info.get('smaller_is_better', True)
  if isinstance(value, str):
    return value.lower() != 'false'
  return bool(value)


def meets_target(value, info):
  """True/False, or None without target"""
  target = info.get('target')
  if value is None or not isinstance(target, (int, float)) or isinstance(target, bool):
    return None
  return value <= target if smaller_is_better(info) else value >= target


def format_duration(seconds) -> str:
  if seconds is None or seconds < 0:
    return '–'
  seconds = int(round(seconds))
  if seconds < 60:
    return f"{seconds} s"
  minutes = seconds // 60
  if minutes < 60:
    return f"{minutes} min"
  hours, minutes = divmod(minutes, 60)
  if hours < 48:
    return f"{hours} h {minutes:02d} min" if minutes else f"{hours} h"
  days, hours = divmod(hours, 24)
  return f"{days} d {hours} h" if hours else f"{days} d"


def format_value(value) -> str:
  if isinstance(value, str):
    return value
  return json.dumps(value, separators=(',', ':'))


def format_params(params, max_length=140) -> str:
  if not params:
    return 'default parameters'
  text = ', '.join(f"{key}={format_value(value)}" for key, value in sorted(params.items()))
  return text if len(text) <= max_length else text[:max_length - 1] + '…'


def tuning_params(extra_parameters) -> dict:
  """The tuning parameters of a run, without the arguments forwarded to `qa run`"""
  return {k: v for k, v in (extra_parameters or {}).items() if k != 'forwarded_args'}


def summarize(runs, metrics_config=None) -> dict:
  """
  runs: [{id, input, platform, batch, params, is_failed, metrics}], the runs of the command.
  metrics_config: the project's metrics.yaml ({available_metrics, main_metrics})
  """
  metrics_config = metrics_config if isinstance(metrics_config, dict) else {}
  available = metrics_config.get('available_metrics') or {}
  available = available if isinstance(available, dict) else {}
  main_metrics = metrics_config.get('main_metrics') or []
  main_metrics = [m for m in main_metrics if isinstance(m, str)] if isinstance(main_metrics, list) else []

  failed = [r for r in runs if r.get('is_failed')]
  succeeded = [r for r in runs if not r.get('is_failed')]

  # the main metrics, or else those all runs have in common
  def values(name, of=succeeded):
    return [r['metrics'].get(name) for r in of if isinstance(r.get('metrics'), dict)]
  shown_metrics = [m for m in main_metrics if median(values(m)) is not None][:MAX_METRICS]
  metrics = []
  for name in shown_metrics:
    info = available.get(name) if isinstance(available.get(name), dict) else {}
    value = median(values(name))
    target = info.get('target')
    metrics.append({
      'name': name,
      'label': info.get('short_label') or info.get('label') or name,
      'value': format_metric(value, info),
      'target': format_metric(target, info) if isinstance(target, (int, float)) and not isinstance(target, bool) else None,
      'meets_target': meets_target(value, info),
    })

  # Tuning: which parameters did best, on the first main metric
  combinations = {}
  for run in runs:
    key = json.dumps(run.get('params') or {}, sort_keys=True)
    combinations.setdefault(key, []).append(run)
  ranking = None
  if len(combinations) > 1 and shown_metrics:
    name = shown_metrics[0]
    info = available.get(name) if isinstance(available.get(name), dict) else {}
    rows = []
    for key, combination_runs in combinations.items():
      ok = [r for r in combination_runs if not r.get('is_failed')]
      value = median(values(name, ok))
      if value is None:
        continue
      rows.append({
        'params': format_params(json.loads(key)),
        'raw_value': value,
        'value': format_metric(value, info),
        'runs': len(combination_runs),
        'failed': len(combination_runs) - len(ok),
      })
    rows.sort(key=lambda row: row['raw_value'], reverse=not smaller_is_better(info))
    for index, row in enumerate(rows):
      row['rank'] = index + 1
      del row['raw_value']
    if rows:
      ranking = {
        'metric': info.get('short_label') or info.get('label') or name,
        'direction': 'lower is better' if smaller_is_better(info) else 'higher is better',
        'rows': rows[:MAX_COMBINATIONS],
        'more': max(0, len(rows) - MAX_COMBINATIONS),
      }

  failed_sorted = sorted(failed, key=lambda r: (str(r.get('batch') or ''), str(r.get('input') or '')))
  return {
    'total': len(runs),
    'failed': len(failed),
    'succeeded': len(succeeded),
    'batches': sorted({r.get('batch') for r in runs if r.get('batch')}),
    'combinations': len(combinations),
    'metrics': metrics,
    'ranking': ranking,
    'failed_runs': [{
      'id': r.get('id'),
      'input': r.get('input') or '?',
      'details': ' · '.join(x for x in (r.get('platform'), format_params(r.get('params'), 80) if r.get('params') else None) if x),
      'batch': r.get('batch'),
    } for r in failed_sorted[:MAX_FAILED_RUNS]],
    'more_failed': max(0, len(failed) - MAX_FAILED_RUNS),
  }


def commit_url(qaboard_url, project_id, hexsha, **params) -> str:
  url = f"{qaboard_url.rstrip('/')}/{quote(project_id, safe='/')}/commit/{quote(hexsha)}"
  # the default batch is shown without ?batch=
  params = {k: v for k, v in params.items() if v is not None and not (k == 'batch' and v == 'default')}
  return f"{url}?{urlencode(params)}" if params else url


def status_of(summary) -> str:
  if summary['total'] and summary['failed'] == summary['total']:
    return 'danger'
  return 'warning' if summary['failed'] else 'success'


def plural(n, word, words=None) -> str:
  return f"{n:,} {word if n == 1 else (words or word + 's')}"


def email_content(summary, info) -> dict:
  """
  The texts and links of the email. info: {qaboard_url, project_id, project_name, hexsha, branch, commit_message,
  committer, label, selected_group, platform, source, user_name, duration_s, started_at, docs_url}
  """
  status = status_of(summary)
  label = info['label']
  total, failed = summary['total'], summary['failed']
  if status == 'success':
    headline = f"{label} is done"
    verdict = f"All {plural(total, 'run')} succeeded" if total > 1 else "The run succeeded"
    subject = f"{label}: {'all ' if total > 1 else ''}{plural(total, 'run')} succeeded"
  elif status == 'danger':
    headline = f"{label} failed"
    verdict = f"All {plural(total, 'run')} failed" if total > 1 else "The run failed"
    subject = f"{label}: {'all ' if total > 1 else ''}{plural(total, 'run')} failed"
  else:
    headline = f"{label} is done, with failures"
    verdict = f"{failed:,} of {plural(total, 'run')} failed"
    subject = f"{label}: {failed:,} of {plural(total, 'run')} failed"
  subject = f"{subject} · {info['project_name']}"

  links = {
    'results': commit_url(info['qaboard_url'], info['project_id'], info['hexsha'], batch=label),
    'failed': commit_url(info['qaboard_url'], info['project_id'], info['hexsha'], batch=label, filter='fail', selected_views='logs') if failed else None,
    'tuning': commit_url(info['qaboard_url'], info['project_id'], info['hexsha'], batch=label, selected_views='tuning') if summary['combinations'] > 1 else None,
    'commit': commit_url(info['qaboard_url'], info['project_id'], info['hexsha']),
  }
  for run in summary['failed_runs']:
    run['url'] = commit_url(info['qaboard_url'], info['project_id'], info['hexsha'], batch=run.get('batch') or label, filter=f"id:{run['id']}", selected_views='logs')

  duration = format_duration(info.get('duration_s'))
  preheader = [verdict, f"in {duration}" if duration != '–' else None]
  best = summary['ranking']['rows'][0] if summary['ranking'] else None
  if best:
    preheader.append(f"· best {summary['ranking']['metric']}: {best['value']} with {best['params']}")
  elif summary['metrics']:
    preheader.append('· ' + ', '.join(f"{m['label']} {m['value']}" for m in summary['metrics'][:3]))

  source = 'the web app' if info.get('source') == 'webapp' else 'the terminal'
  details = [
    ('Project', info['project_name'], None),
    ('Commit', ' · '.join(x for x in (info['hexsha'][:8], info.get('branch'), info.get('commit_message')) if x), links['commit']),
    ('Batch', label, links['results']),
  ]
  if info.get('selected_group'):
    details.append(('Inputs', info['selected_group'], None))
  if len(summary['batches']) > 1:
    details.append(('Batches', ', '.join(summary['batches']), None))
  if info.get('platform'):
    details.append(('Platform', info['platform'], None))
  if summary['combinations'] > 1:
    details.append(('Tuning', f"{plural(summary['combinations'], 'combination')} of parameters", links['tuning']))
  details.append(('Started', ' · '.join(x for x in (info.get('started_at'), f"from {source}", f"as {info['user_name']}" if info.get('user_name') else None) if x), None))

  if info.get('source') == 'webapp':
    reason = "You get this email because you chose “Email me when it ends” when you started this batch in QA-Board."
  else:
    reason = "You get this email because you ran qa batch with QA_NOTIFY=email."
  return {
    'status': status,
    'color': colors[status],
    'subject': subject,
    'preheader': ' '.join(x for x in preheader if x),
    'headline': headline,
    'verdict': verdict,
    'duration': duration,
    'links': links,
    'details': details,
    'reason': reason,
    'docs_url': info.get('docs_url'),
    'project_name': info['project_name'],
  }


_environment = Environment(
  loader=FileSystemLoader(Path(__file__).parent / 'templates'),
  autoescape=select_autoescape(['html']),
  trim_blocks=True,
  lstrip_blocks=True,
)


def render_batch_email(summary, info):
  """Returns (subject, html, text)"""
  content = email_content(summary, info)
  context = {**content, 'summary': summary}
  html = _environment.get_template('batch_ended.html').render(**context)
  text = _environment.get_template('batch_ended.txt').render(**context)
  return content['subject'], html, text
