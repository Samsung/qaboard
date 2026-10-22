"""
Marks as failed the runs that have been pending (waiting or running) for too long, e.g. a week: their job died
without saying so (LSF killed it, its machine rebooted...). They're out of the way: users don't see them as
running anymore, "Activity" stops counting them, and redoing them works.

Their jobs aren't stopped: if one still runs, it saves its results when it ends, like any run.
Runs from before QA-Board saved when runs start count from when they were created.
"""
import datetime

from .. import run_activity
from ..durations import parse_time
from . import params as p
from .common import matching_projects
from .report import Reporter, utcnow


PARAMS = ('projects', 'exclude_projects', 'older_than', 'only_running', 'dry_run')
DEFAULT_OLDER_THAN = '1week'


def validate(params: dict) -> dict:
  p.known_keys(params, PARAMS)
  return {
    "projects": p.globs(params.get('projects'), 'projects', default=['*']),
    "exclude_projects": p.globs(params.get('exclude_projects'), 'exclude_projects'),
    "older_than": p.duration(params.get('older_than'), 'older_than') or DEFAULT_OLDER_THAN,
    "only_running": p.boolean(params.get('only_running'), 'only_running'),
    "dry_run": p.boolean(params.get('dry_run'), 'dry_run'),
  }


def describe(params: dict) -> str:
  which = 'running' if params.get('only_running') else 'waiting or running'
  projects = ', '.join(params['projects'])
  excluded = f" except {', '.join(params['exclude_projects'])}" if params['exclude_projects'] else ''
  return f"Mark as failed the runs of {projects}{excluded} {which} for over {params['older_than']}"


def reason(params: dict, now: datetime.datetime) -> str:
  return f"Still {'running' if params.get('only_running') else 'pending'} after {params['older_than']}: marked as failed on {now.strftime('%Y-%m-%d')} UTC. Its job was not stopped."


def run(params: dict, report: Reporter):
  everything = params['projects'] == ['*'] and not params['exclude_projects']
  projects = None if everything else matching_projects(params)
  if projects == []:
    report.log("No project matches.", 'warning')
    return
  now = utcnow()
  before = now - parse_time(params['older_than'])
  filters = run_activity.Filters(projects=projects, status='running' if params['only_running'] else 'active', now=now)
  answer = run_activity.fail_runs(filters, reason(params, now), before=before, dry_run=params['dry_run'])
  verb = 'to mark as failed' if params['dry_run'] else 'marked as failed'
  for project_id, count in sorted(answer['projects'].items(), key=lambda kv: -kv[1]):
    report.log(f"{project_id}: {count} run{'s' if count != 1 else ''} {verb}")
  report.set(runs_failed=answer['runs'], batches=answer['batches'], projects=len(answer['projects']))
  if not answer['runs']:
    report.log(f"No run has been pending since before {before.strftime('%Y-%m-%d %H:%M')} UTC.")
