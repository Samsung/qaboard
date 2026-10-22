"""
"Activity", for users and admins: the runs that wait and run now, those that ended recently, and the batches that
will start soon, grouped as users like. A thin layer over backend/run_activity.py.

Users see the projects they can read (like Storage usage), and mark their own runs as failed; admins anyone's.
"""
import datetime

from flask import request, jsonify

from backend import app, db_session
from ..models import JobSchedule
from ..audit import audit
from .. import run_activity as activity
from ..jobs.params import ParamsError
from ..jobs.cron import describe as describe_cron
from .auth import login_required
from .storage import me, is_admin, allowed_projects, whose, int_or_none
from ..access import can


# Pending for longer: admins may want a schedule to mark them as failed (jobs/fail_stuck_runs.py)
STUCK_AFTER = datetime.timedelta(weeks=1)


def filters_from(source: dict, user, **overrides) -> activity.Filters:
  projects = source.get('project')
  if isinstance(projects, str):
    projects = [p.strip() for p in projects.split(',') if p.strip()]
  try:
    return activity.Filters(**{
      "user": user,
      "projects": projects or [],
      "allowed_projects": allowed_projects(),
      "window": source.get('window') or activity.DEFAULT_WINDOW,
      "status": source.get('status') or 'all',
      "search": source.get('search') or None,
      "option": source.get('option') or None,
      **overrides,
    })
  except ValueError as e:
    raise ParamsError(str(e))


def stuck_schedule():
  """The schedule that marks stuck runs as failed, if admins set one up"""
  schedule = (JobSchedule.query.filter(JobSchedule.kind == 'fail_stuck_runs', JobSchedule.enabled.is_(True))
              .order_by(JobSchedule.id).first())
  if schedule is None:
    return None
  return {"id": schedule.id, "name": schedule.name, "when": describe_cron(schedule.cron, schedule.timezone),
          "older_than": (schedule.params or {}).get('older_than'), "dry_run": bool((schedule.params or {}).get('dry_run'))}


@app.route('/api/v1/activity/overview', methods=['GET'])
@app.route('/api/v1/activity/overview/', methods=['GET'])
@login_required
def activity_overview():
  who = whose(request.args)
  filters = filters_from(request.args, who['user'])
  answer = {
    **who,
    "me": me(),
    "is_admin": is_admin(),
    "now": activity.iso(filters.now),
    "window": filters.window,
    "since": activity.iso(filters.since),
    "totals": activity.totals(filters),
    "timeline": activity.timeline(filters),
    "starting_soon": activity.starting_soon(filters),
    "projects": activity.breakdown(filters, 'project'),
    "queues": activity.breakdown(filters, 'queue'),
    "stuck": {"older_than": '1week', "runs": activity.active_before(filters, filters.now - STUCK_AFTER)},
  }
  if who['user'] is None:
    answer["users"] = activity.breakdown(filters, 'user')
  if is_admin():
    answer["stuck"]["schedule"] = stuck_schedule()
  return jsonify(answer)


def group_and_key(source):
  group = source.get('group') or None
  if group is not None and group not in activity.GROUPS:
    raise ParamsError(f"`group` must be one of {', '.join(activity.GROUPS)}")
  key = source.get('key')
  return group, (None if key is None or group is None else key)


@app.route('/api/v1/activity/items', methods=['GET'])
@app.route('/api/v1/activity/items/', methods=['GET'])
@login_required
def activity_items():
  """The runs grouped by project, commit, batch, user, `qa batch` command, runner, queue, platform, job option or status"""
  who = whose(request.args)
  group = request.args.get('group') or 'batch'
  if group not in activity.GROUPS:
    raise ParamsError(f"`group` must be one of {', '.join(activity.GROUPS)}")
  filters = filters_from(request.args, who['user'])
  if group == 'option' and not filters.option:
    raise ParamsError("Which job option? `option`, e.g. queue or project")
  limit = min(int_or_none(request.args.get('limit'), 'limit') or 50, 500)
  offset = int_or_none(request.args.get('offset'), 'offset') or 0
  return jsonify(activity.items(filters, group=group, sort=request.args.get('sort') or 'active', limit=limit, offset=offset))


@app.route('/api/v1/activity/runs', methods=['GET'])
@app.route('/api/v1/activity/runs/', methods=['GET'])
@login_required
def activity_runs():
  """The runs themselves, maybe only one group's (`group` and `key`)"""
  who = whose(request.args)
  group, key = group_and_key(request.args)
  filters = filters_from(request.args, who['user'], group=group, key=key)
  limit = min(int_or_none(request.args.get('limit'), 'limit') or 50, 500)
  offset = int_or_none(request.args.get('offset'), 'offset') or 0
  return jsonify(activity.runs(filters, limit=limit, offset=offset))


@app.route('/api/v1/activity/fail', methods=['POST'])
@app.route('/api/v1/activity/fail/', methods=['POST'])
@login_required
def activity_fail():
  """
  Marks pending runs as failed, e.g. those whose job died without saying so. Users mark their own runs, admins
  anyone's. With `dry_run`, says how many it would. Jobs aren't stopped: to stop them, stop their batch.
  """
  body = request.get_json(silent=True) or {}
  who = whose(body)
  # users mark their own runs as failed, admins anyone's
  owner = me() if not is_admin() else who['user']
  group, key = group_and_key(body)
  filters = filters_from(body.get('filters') or {}, owner, group=group, key=key)
  ids = body.get('ids')
  if ids is not None and (not isinstance(ids, list) or not ids or not all(isinstance(i, int) for i in ids)):
    raise ParamsError("`ids` must be a list of run ids")
  if group is None and ids is None and not filters.projects:
    raise ParamsError("Choose a group of runs, runs or a project")
  preview = activity.fail_runs(filters, '', ids=ids, dry_run=True)
  refused = sorted(p for p in preview['projects'] if not can('runs.act', p))
  if refused:
    return jsonify({"error": f"You can't change the runs of {refused[0]}.", "reason": "forbidden_project"}), 403
  answer = {k: preview[k] for k in ('runs', 'batches', 'projects')}
  if body.get('dry_run') or not preview['runs']:
    return jsonify({**answer, "dry_run": bool(body.get('dry_run'))})
  reason = f"Marked as failed by {me()} on {filters.now.strftime('%Y-%m-%d %H:%M')} UTC. Its job was not stopped."
  done = activity.fail_runs(filters, reason, ids=preview['ids'])
  audit('runs.fail', 'runs', None, f"{done['runs']} run{'s' if done['runs'] != 1 else ''}",
        project_id=next(iter(done['projects'])) if len(done['projects']) == 1 else None,
        meta={"runs": done['runs'], "batches": done['batches'], "projects": done['projects'], "group": group, "key": key, "owner": owner})
  db_session.commit()
  return jsonify({**{k: done[k] for k in ('runs', 'batches', 'projects')}, "dry_run": False})
