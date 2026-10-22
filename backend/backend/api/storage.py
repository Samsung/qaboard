"""
"Storage usage", for users: how much storage their runs use, by project, batch, commit, branch and folder, and
deleting the files of many runs at once. A thin layer over backend/storage_usage.py, and jobs (backend/jobs/) for
the deletions.

Users delete only their own runs (Output.data.user), admins anyone's. Milestones and running runs are kept.
"""
from collections import defaultdict

from flask import request, jsonify, g

from backend import app, db_session
from ..models import Job, JobError, Project
from ..audit import audit
from .. import storage_usage as usage
from ..jobs import queue
from ..jobs.params import ParamsError
from .auth import login_required
from ..access import can, visibility_rules, yaml_key, role_of
from ..access.policy import allows
from ..settings import setting
from .. import accounts


# What users start from Storage usage
USER_KINDS = ('delete_runs', 'delete_exports', 'delete_paths')
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
  """None if users can see every project. Signed in, they see public and internal ones: only private ones are hidden."""
  if is_admin():
    return None
  projects = [p for (p,) in db_session.query(Project.id)]
  token = getattr(g.get('actor'), 'token', None)
  maybe_hidden = (setting('projects.default_visibility') == 'private' or 'private' in visibility_rules().values()
                  or (token is not None and token.projects))
  if not maybe_hidden and not any(yaml_key(p) is not None for p in projects):
    return None
  return [p for p in projects if can('project.read', p)]


# How users got a role that makes them a project's member, rather than any signed-in user (access.role_of)
MEMBER_VIAS = ('grant', 'group', 'yaml')


def others_projects():
  """
  None if the user sees everyone's usage, else the projects where they see other people's: admins see everything,
  developers and owners (members, not every signed-in user) their projects. `storage.others_visible_to` opens it to all.
  """
  if is_admin():
    return None
  if 'storage_others_projects' in g:
    return g.storage_others_projects
  allowed = allowed_projects()
  if setting('storage.others_visible_to') == 'signed_in':
    answer = allowed
  else:
    user = g.actor.user
    projects = allowed if allowed is not None else [p for (p,) in db_session.query(Project.id)]
    answer = [p for p in projects if (lambda role, via: via in MEMBER_VIAS and allows(role, 'runs.act'))(*role_of(user, p))]
  g.storage_others_projects = answer
  return answer


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
  if scope == 'me' or (scope == 'user' and (source.get('user') or '').strip() == me()):
    return {"scope": 'me', "user": me()}
  if scope == 'all':
    return {"scope": 'all', "user": None}
  if scope == 'user':
    user = (source.get('user') or '').strip()
    if not user:
      raise ParamsError("`user` is required with scope=user")
    return {"scope": 'user', "user": user}
  raise ParamsError("`scope` must be me, all or user")


def filters_from(source: dict, user, own_projects=False) -> usage.Filters:
  """
  Other people's runs (`user` isn't the user's): only in the projects where they may see them.
  `own_projects`: every project the user sees, e.g. to delete their own runs among everyone's.
  """
  projects = source.get('project')
  if isinstance(projects, str):
    projects = [p.strip() for p in projects.split(',') if p.strip()]
  try:
    return usage.Filters(
      user=user,
      projects=projects or [],
      allowed_projects=allowed_projects() if user == me() or own_projects else others_projects(),
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
  others = others_projects()
  return {
    "updated_at": usage.iso(usage.updated_at()),
    "building": queue.serialize_job(building) if building else None,
    "can_delete_others": is_admin(),
    # whose usage the user sees: "all", "some" projects' (where they're a developer or owner), or "none"
    "can_see_others": "all" if others is None else "some" if others else "none",
    "others_visible_to": setting('storage.others_visible_to'),
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
  if who['scope'] != 'me' and answer['can_see_others'] != 'none':
    answer["users"] = usage.by_user(filters_from(request.args, None))
  answer["exports"] = export_totals(who['user'], filters.projects)
  return jsonify(answer)


@app.route('/api/v1/storage/users', methods=['GET'])
@app.route('/api/v1/storage/users/', methods=['GET'])
@login_required
def storage_users():
  """Who uses the most storage, with the filters (but everyone's runs): a leaderboard, to then look at someone's runs"""
  filters = filters_from(request.args, None)
  limit = min(int_or_none(request.args.get('limit'), 'limit') or 100, 500)
  return jsonify({
    **status(),
    "users": usage.by_user(filters, limit=limit),
    "total": usage.nb_users(filters),
    "totals": usage.totals(filters),
    "me": me(),
  })


# --- deletion rules ---

@app.route('/api/v1/storage/rules', methods=['GET'])
@app.route('/api/v1/storage/rules/', methods=['GET'])
@login_required
def storage_rules():
  """What deletes results, when, and what it keeps: the schedules admins set up, with the project's qaboard.yaml"""
  from .. import storage_rules as rules
  project = request.args.get('project') or None
  if project and not can('project.read', project):
    return jsonify({"rules": [], "settings": {}, "project": project})
  return jsonify({"rules": rules.rules(project), "settings": rules.project_settings(project) if project else {}, "project": project})


# --- exports ---

def exports_query(user, projects=None):
  from ..models import Export
  from sqlalchemy import or_
  query = Export.query.filter(Export.deleted_at.is_(None))
  if user is not None:
    query = query.filter(or_(Export.created_by == user, Export.owner.in_(accounts.aliases(user))))
  if projects:
    query = query.filter(Export.project_id.in_(projects))
  if user == me():
    allowed = allowed_projects()
    if allowed is not None:
      query = query.filter(or_(Export.project_id.is_(None), Export.project_id.in_(allowed)))
  else:
    # other people's exports: not those without a project, unless admin
    allowed = others_projects()
    if allowed is not None:
      query = query.filter(Export.project_id.in_(allowed))
  return query


def export_totals(user, projects=None) -> dict:
  from ..models import Export
  from sqlalchemy import func
  row = exports_query(user, projects).with_entities(func.count(Export.id), func.coalesce(func.sum(Export.bytes), 0), func.coalesce(func.sum(Export.linked_bytes), 0)).one()
  return {"count": row[0], "bytes": int(row[1]), "linked_bytes": int(row[2])}


@app.route('/api/v1/storage/exports', methods=['GET'])
@app.route('/api/v1/storage/exports/', methods=['GET'])
@login_required
def storage_exports():
  from ..models import Export
  from ..exports import serialize
  who = whose(request.args)
  projects = [p for p in (request.args.get('project') or '').split(',') if p]
  query = exports_query(who['user'], projects)
  sort = {'oldest': Export.updated_at.asc(), 'newest': Export.updated_at.desc()}.get(request.args.get('sort'), Export.bytes.desc().nullslast())
  return jsonify({
    "exports": [serialize(e) for e in query.order_by(sort).limit(500)],
    "totals": export_totals(who['user'], projects),
  })


def can_delete_export(export) -> bool:
  return is_admin() or me() in (export.created_by, accounts.resolve(export.owner))


@app.route('/api/v1/storage/exports/delete', methods=['POST'])
@app.route('/api/v1/storage/exports/delete/', methods=['POST'])
@login_required
def storage_delete_exports():
  from ..models import Export
  ids = (request.get_json(silent=True) or {}).get('ids')
  if not isinstance(ids, list) or not ids or not all(isinstance(i, int) for i in ids):
    raise ParamsError("Select the exports to delete: `ids`")
  exports = Export.query.filter(Export.id.in_(ids), Export.deleted_at.is_(None)).all()
  refused = [e.path for e in exports if not can_delete_export(e)]
  if refused:
    return jsonify({"error": f"You can only delete your exports: {refused[0]} isn't yours."}), 403
  if not exports:
    return jsonify({"error": "These exports were already deleted."}), 400
  size = sum(e.bytes or 0 for e in exports)
  job = queue.create('delete_exports', {
    "export_ids": [e.id for e in exports], "requested_by": me(),
    "description": f"{len(exports)} export{'s' if len(exports) > 1 else ''} ({human(size)})",
  }, user=g.actor.user)
  audit('storage.delete_exports', 'job', job.id, job.params['description'], meta={"paths": [e.path for e in exports][:50], "bytes": size})
  db_session.commit()
  return jsonify({"job": queue.serialize_job(job)}), 201


@app.route('/api/v1/storage/exports/<int:export_id>/measure', methods=['POST'])
@app.route('/api/v1/storage/exports/<int:export_id>/measure/', methods=['POST'])
@login_required
def storage_measure_export(export_id):
  """Measures an export again, e.g. after deleting some of its files"""
  from ..models import Export
  from ..exports import measure_export, serialize
  export = db_session.get(Export, export_id)
  if export is None or not can_delete_export(export):
    return jsonify({"error": "This export doesn't exist."}), 404
  measure_export(export)
  db_session.commit()
  return jsonify(serialize(export))


# --- untracked files, from the latest storage scan ---

def latest_scan():
  from ..models import StorageScan
  return StorageScan.query.filter(StorageScan.status == 'done').order_by(StorageScan.finished_at.desc()).first()


@app.route('/api/v1/storage/untracked', methods=['GET'])
@app.route('/api/v1/storage/untracked/', methods=['GET'])
@login_required
def storage_untracked():
  """
  What the latest scan found on disk that QA-Board doesn't track, owned by the user: exports, runs it doesn't know,
  what deleted runs left... The biggest first.
  """
  from ..models import StorageScanEntry
  from ..jobs.scan import UNTRACKED
  from .admin_storage import serialize_entry
  scan = latest_scan()
  if scan is None:
    return jsonify({"scan": None, "totals": {}, "entries": []})
  user = request.args.get('user') if is_admin() and request.args.get('user') else me()
  kinds = sorted(UNTRACKED | {'folder', 'file'})
  entries = (StorageScanEntry.query
             .filter(StorageScanEntry.scan_id == scan.id, StorageScanEntry.owner.in_(accounts.aliases(user)), StorageScanEntry.kind.in_(kinds), StorageScanEntry.action.is_(None))
             .order_by(StorageScanEntry.bytes.desc()).limit(300).all())
  # the biggest untracked things, not the folders that contain them
  answer = []
  for entry in entries:
    item = serialize_entry(entry)
    untracked = sum(size for kind, size in (entry.kinds or {}).items() if kind in UNTRACKED)
    owners = set(accounts.resolve_keys(entry.owners))
    if entry.kind in ('folder', 'file') and (not untracked or owners - {user}):
      continue
    item['untracked_bytes'] = untracked or entry.bytes
    item['only_yours'] = owners <= {user}
    answer.append(item)
  # folders whose untracked files are all listed inside them come after: keep the leaves first
  answer.sort(key=lambda e: (e['kind'] == 'folder', -e['untracked_bytes']))
  by_owner = accounts.resolve_keys((scan.totals or {}).get('by_owner')).get(user) or {}
  return jsonify({
    "scan": {"id": scan.id, "finished_at": usage.iso(scan.finished_at), "roots": scan.roots},
    "totals": {"by_kind": {k: v for k, v in by_owner.items() if k in UNTRACKED}, "bytes": sum(v for k, v in by_owner.items() if k in UNTRACKED)},
    "entries": answer[:100],
    "user": user,
  })


@app.route('/api/v1/storage/untracked/delete', methods=['POST'])
@app.route('/api/v1/storage/untracked/delete/', methods=['POST'])
@login_required
def storage_delete_untracked():
  """Users delete untracked files the latest scan found, if they own everything in them"""
  from ..models import StorageScanEntry
  from ..jobs.storage_actions import deletable
  scan = latest_scan()
  paths = (request.get_json(silent=True) or {}).get('paths')
  if scan is None or not isinstance(paths, list) or not paths:
    raise ParamsError("Select what to delete: `paths`")
  entries = StorageScanEntry.query.filter(StorageScanEntry.scan_id == scan.id, StorageScanEntry.path.in_(paths)).all()
  if len(entries) != len(set(paths)):
    raise ParamsError("Some paths aren't in the latest scan")
  for entry in entries:
    if not deletable(entry):
      return jsonify({"error": f"QA-Board uses files in {entry.path}: delete its runs from QA-Board instead."}), 400
    others = set(accounts.resolve_keys(entry.owners)) - {me()}
    if not is_admin() and others:
      return jsonify({"error": f"{entry.path} has files of other people ({', '.join(sorted(others))}): ask them, or an admin."}), 403
  size = sum(e.bytes or 0 for e in entries)
  job = queue.create('delete_paths', {
    "scan_id": scan.id, "paths": [e.path for e in entries], "requested_by": me(),
    "description": f"{len(entries)} untracked folder{'s' if len(entries) > 1 else ''} ({human(size)})",
  }, user=g.actor.user)
  audit('storage.delete_paths', 'job', job.id, job.params['description'], meta={"scan_id": scan.id, "paths": [e.path for e in entries][:50], "bytes": size})
  db_session.commit()
  return jsonify({"job": queue.serialize_job(job)}), 201


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
  # users delete their own runs in every project they see, even among "Everyone's"
  filters = filters_from(body.get('filters') or {}, who['user'], own_projects=True)
  others = others_projects()
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
      # their names, only where the user may see other people's runs
      if others is None or row['project_id'] in others:
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
  if job is None or job.kind not in USER_KINDS or (job.created_by_id != g.actor.user.id and not is_admin()):
    return None, (jsonify({"error": "This deletion doesn't exist."}), 404)
  return job, None


@app.route('/api/v1/storage/jobs', methods=['GET'])
@app.route('/api/v1/storage/jobs/', methods=['GET'])
@login_required
def storage_jobs():
  """The user's deletions, the latest first"""
  jobs = (Job.query.filter(Job.kind.in_(USER_KINDS), Job.created_by_id == g.actor.user.id)
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
