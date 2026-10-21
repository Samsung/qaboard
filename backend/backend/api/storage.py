"""
"Storage usage", for users: how much storage their runs use, by project, batch, commit, branch and folder, and
deleting the files of many runs at once. A thin layer over backend/storage_usage.py, and jobs (backend/jobs/) for
the deletions.

Users delete only their own runs (Output.data.user), admins anyone's. Milestones and running runs are kept.
"""
import os
from collections import defaultdict

from flask import request, jsonify, g

from backend import app, db_session
from ..models import Job, JobError, Project
from ..audit import audit
from .. import storage_usage as usage
from ..jobs import queue
from ..jobs.params import ParamsError
from .auth import login_required, is_login_restricted, is_authorized_user


# Big deletions need users to type a confirmation
CONFIRM_BYTES = 200 * 1000 ** 3
CONFIRM_BATCHES = 100
CONFIRM_RUNS = 5_000


def me() -> str:
  return g.user['user_name']


def is_admin() -> bool:
  actor = g.get('actor')
  return bool(actor is not None and actor.is_admin)


def allowed_projects():
  """None if users can see every project"""
  if not is_login_restricted:
    return None
  return [p for (p,) in db_session.query(Project.id) if is_authorized_user(g.user, p)]


def int_or_none(value, name):
  if value in (None, ''):
    return None
  try:
    return max(0, int(value))
  except (TypeError, ValueError):
    raise ParamsError(f"`{name}` must be a number")


def whose(source) -> dict:
  """`scope`: "me" (default), "all", or "user" with `user`: whose runs we look at"""
  scope = source.get('scope') or 'me'
  if scope == 'me':
    return {"scope": 'me', "user": me()}
  if scope == 'all':
    return {"scope": 'all', "user": None}
  if scope == 'user':
    user = (source.get('user') or '').strip()
    if not user:
      raise ParamsError("`user` is required with scope=user")
    return {"scope": 'user', "user": user}
  raise ParamsError("`scope` must be me, all or user")


def filters_from(source: dict, user) -> usage.Filters:
  projects = source.get('project')
  if isinstance(projects, str):
    projects = [p.strip() for p in projects.split(',') if p.strip()]
  try:
    return usage.Filters(
      user=user,
      projects=projects or [],
      allowed_projects=allowed_projects(),
      folder=source.get('folder') or None,
      branch=source.get('branch') or None,
      older_than_days=int_or_none(source.get('older_than_days'), 'older_than_days'),
      search=source.get('search') or None,
    )
  except ValueError as e:
    raise ParamsError(str(e))


def status() -> dict:
  """When the numbers were updated, and whether they're being computed"""
  building = Job.query.filter(Job.kind == 'storage_usage', Job.status.in_(queue.ACTIVE)).first()
  return {
    "updated_at": usage.iso(usage.updated_at()),
    "building": queue.serialize_job(building) if building else None,
    "quota_url_template": os.environ.get('QABOARD_QUOTA_URL_TEMPLATE'),
    "can_delete_others": is_admin(),
  }


@app.route('/api/v1/storage/overview', methods=['GET'])
@app.route('/api/v1/storage/overview/', methods=['GET'])
@login_required
def storage_overview():
  who = whose(request.args)
  filters = filters_from(request.args, who['user'])
  answer = {
    **status(),
    **who,
    "me": me(),
    "totals": usage.totals(filters),
    "projects": usage.by_project(filters),
  }
  if who['user'] is not None:
    answer["top_folders"] = usage.top_folders(filters)
  if who['scope'] == 'all' or filters.projects:
    answer["users"] = usage.by_user(filters)
  return jsonify(answer)


def milestone_flags(items: list, group: str) -> None:
  """Marks the batches that are milestones (or the commits with milestones): their runs are kept"""
  by_project = defaultdict(list)
  for item in items:
    by_project[item['project_id']].append(item)
  for project_id, project_items in by_project.items():
    project = db_session.get(Project, project_id)
    batches = project.milestone_batches if project else None
    for item in project_items:
      labels = batches.of_commit(project_id, item['hexsha']) if batches and item.get('hexsha') else set()
      if group == 'batch':
        item['milestone'] = item['batch_label'] in labels
      elif group == 'commit':
        item['milestones'] = sorted(labels)


@app.route('/api/v1/storage/items', methods=['GET'])
@app.route('/api/v1/storage/items/', methods=['GET'])
@login_required
def storage_items():
  who = whose(request.args)
  filters = filters_from(request.args, who['user'])
  group = request.args.get('group') or 'batch'
  if group not in usage.GROUPS:
    raise ParamsError(f"`group` must be one of {', '.join(usage.GROUPS)}")
  limit = min(int_or_none(request.args.get('limit'), 'limit') or 50, 500)
  offset = int_or_none(request.args.get('offset'), 'offset') or 0
  answer = usage.items(filters, group=group, sort=request.args.get('sort') or 'size', limit=limit, offset=offset)
  milestone_flags(answer['items'], group)
  return jsonify({**answer, "totals": usage.totals(filters), "group": group})


@app.route('/api/v1/storage/folders', methods=['GET'])
@app.route('/api/v1/storage/folders/', methods=['GET'])
@login_required
def storage_folders():
  who = whose(request.args)
  filters = filters_from({**request.args, "folder": None}, who['user'])
  try:
    return jsonify(usage.folders(filters, request.args.get('path')))
  except ValueError as e:
    raise ParamsError(str(e))


def human(size: int) -> str:
  for unit in ('B', 'KB', 'MB', 'GB', 'TB'):
    if size < 1000 or unit == 'TB':
      return f"{size:.0f} {unit}" if unit == 'B' else f"{size:.1f} {unit}"
    size /= 1000


def preview(body: dict) -> dict:
  """What deleting a selection would delete, and what it keeps: milestones, and other users' runs"""
  who = whose(body)
  filters = filters_from(body.get('filters') or {}, who['user'])
  group = body.get('group') or 'batch'
  if group not in usage.GROUPS:
    raise ParamsError(f"`group` must be one of {', '.join(usage.GROUPS)}")
  keys = body.get('keys')
  if keys is not None and (not isinstance(keys, list) or not keys):
    raise ParamsError("Select what to delete (`keys`), or everything that matches the filters (no `keys`)")
  if keys is None and not (filters.user or filters.projects or filters.folder or filters.branch or filters.search or filters.older_than_days):
    raise ParamsError("Choose a project, a folder or other filters before deleting everything that matches")
  # users delete their own runs, admins anyone's
  owner = me() if not is_admin() else who['user']
  rows = usage.selected_rows(filters, group, keys)
  milestone_rows = []
  by_project = defaultdict(list)
  for row in rows:
    by_project[row['project_id']].append(row)
  milestones = set()
  for project_id, project_rows in by_project.items():
    project = db_session.get(Project, project_id)
    if project is None:
      continue
    batches = project.milestone_batches
    for row in project_rows:
      if row['batch_label'] in batches.of_commit(project_id, row['hexsha']):
        milestones.add(row['batch_id'])
  kept = {"milestones": {"runs": 0, "bytes": 0, "batches": set()}, "others": {"runs": 0, "bytes": 0, "batches": set(), "users": set()}}
  deleted = {"runs": 0, "bytes": 0, "batches": set(), "commits": set(), "projects": defaultdict(int)}
  partial = 0
  for row in rows:
    if owner is not None and row['user_name'] != owner:
      k = kept['others']
      k['users'].add(row['user_name'] or 'unknown')
    elif row['batch_id'] in milestones:
      k = kept['milestones']
      milestone_rows.append(row)
    else:
      k = deleted
      deleted['commits'].add(row['ci_commit_id'])
      deleted['projects'][row['project_id']] += row['bytes']
      if filters.folder and filters.folder != '/' and not (row['folder'] or '').startswith(filters.folder.rstrip('/') + '/') and row['folder'] != filters.folder:
        partial += 1
    k['runs'] += row['nb_runs']
    k['bytes'] += row['bytes']
    k['batches'].add(row['batch_id'])
  needs_confirmation = deleted['bytes'] >= CONFIRM_BYTES or len(deleted['batches']) >= CONFIRM_BATCHES or deleted['runs'] >= CONFIRM_RUNS
  return {
    "owner": owner,
    "folder": filters.folder,
    "runs": deleted['runs'],
    "bytes": deleted['bytes'],
    "batches": len(deleted['batches']),
    "commits": len(deleted['commits']),
    "projects": [{"project_id": p, "bytes": b} for p, b in sorted(deleted['projects'].items(), key=lambda kv: -kv[1])],
    # batches only partly in the folder: only their runs in it are deleted, the numbers are a maximum
    "partial_batches": partial,
    "kept": {
      "milestones": {"runs": kept['milestones']['runs'], "bytes": kept['milestones']['bytes'], "batches": len(kept['milestones']['batches'])},
      "others": {"runs": kept['others']['runs'], "bytes": kept['others']['bytes'], "batches": len(kept['others']['batches']), "users": sorted(kept['others']['users'])[:10]},
    },
    "confirm_phrase": f"delete {len(deleted['batches'])} batches" if needs_confirmation else None,
    "_batch_ids": sorted(deleted['batches']),
  }


@app.route('/api/v1/storage/preview', methods=['POST'])
@app.route('/api/v1/storage/preview/', methods=['POST'])
@login_required
def storage_preview():
  answer = preview(request.get_json(silent=True) or {})
  answer.pop('_batch_ids')
  return jsonify(answer)


@app.route('/api/v1/storage/delete', methods=['POST'])
@app.route('/api/v1/storage/delete/', methods=['POST'])
@login_required
def storage_delete():
  """Deletes the files of the selection's runs, in the background: answers with the job"""
  body = request.get_json(silent=True) or {}
  answer = preview(body)
  batch_ids = answer.pop('_batch_ids')
  if not batch_ids:
    return jsonify({"error": "Nothing to delete: the selection only has runs that are kept (milestones, other users' runs).", "preview": answer}), 400
  if answer['confirm_phrase'] and (body.get('confirm') or '').strip().lower() != answer['confirm_phrase']:
    return jsonify({"error": f"Type \"{answer['confirm_phrase']}\" to confirm.", "reason": "confirmation_required", "preview": answer}), 400
  description = body.get('description') or f"{answer['batches']} batch{'es' if answer['batches'] != 1 else ''} ({human(answer['bytes'])})"
  job = queue.create('delete_runs', {
    "batch_ids": batch_ids, "owner": answer['owner'], "folder": answer['folder'], "description": str(description)[:300],
  }, user=g.actor.user)
  audit('storage.delete', 'job', job.id, job.params['description'], meta={
    "batches": len(batch_ids), "runs": answer['runs'], "bytes": answer['bytes'], "owner": answer['owner'], "folder": answer['folder'],
    "projects": [p['project_id'] for p in answer['projects'][:20]],
  })
  db_session.commit()
  return jsonify({"job": queue.serialize_job(job, with_log=True), "preview": answer}), 201


def get_own_job(job_id):
  job = db_session.get(Job, job_id)
  if job is None or job.kind != 'delete_runs' or (job.created_by_id != g.actor.user.id and not is_admin()):
    return None, (jsonify({"error": "This deletion doesn't exist."}), 404)
  return job, None


@app.route('/api/v1/storage/jobs', methods=['GET'])
@app.route('/api/v1/storage/jobs/', methods=['GET'])
@login_required
def storage_jobs():
  """The user's deletions, the latest first"""
  jobs = (Job.query.filter(Job.kind == 'delete_runs', Job.created_by_id == g.actor.user.id)
          .order_by(Job.id.desc()).limit(20).all())
  return jsonify({"jobs": [queue.serialize_job(j) for j in jobs]})


@app.route('/api/v1/storage/jobs/<int:job_id>', methods=['GET'])
@app.route('/api/v1/storage/jobs/<int:job_id>/', methods=['GET'])
@login_required
def storage_job(job_id):
  job, error = get_own_job(job_id)
  if error:
    return error
  return jsonify(queue.serialize_job(job, with_log=True))


@app.route('/api/v1/storage/jobs/<int:job_id>/cancel', methods=['POST'])
@app.route('/api/v1/storage/jobs/<int:job_id>/cancel/', methods=['POST'])
@login_required
def storage_cancel_job(job_id):
  job, error = get_own_job(job_id)
  if error:
    return error
  if job.status not in queue.ACTIVE:
    return jsonify({"error": f"This deletion is {job.status}: it can't be cancelled."}), 400
  queue.cancel(job)
  db_session.commit()
  return jsonify(queue.serialize_job(job, with_log=True))


@app.route('/api/v1/storage/jobs/<int:job_id>/errors', methods=['GET'])
@app.route('/api/v1/storage/jobs/<int:job_id>/errors/', methods=['GET'])
@login_required
def storage_job_errors(job_id):
  job, error = get_own_job(job_id)
  if error:
    return error
  from sqlalchemy import func
  query = JobError.query.filter(JobError.job_id == job.id)
  if request.args.get('kind'):
    query = query.filter(JobError.kind == request.args['kind'])
  by_kind = query.with_entities(JobError.kind, func.count(JobError.id)).group_by(JobError.kind).all()
  offset = int_or_none(request.args.get('offset'), 'offset') or 0
  return jsonify({
    "errors": [queue.serialize_error(e) for e in query.order_by(JobError.id).offset(offset).limit(100)],
    "total": query.count(),
    "by_kind": [{"value": k, "count": c} for k, c in by_kind],
    "by_owner": [], "by_project": [], "not_saved": (job.progress or {}).get('errors_not_saved', 0),
  })
