"""
Milestones: results saved to compare with later. See models/Milestone.py, and backend/milestones.py for the rules.

GET    /api/v1/milestones?project=     the milestones the user sees: shared ones, and their own
POST   /api/v1/milestones              save a milestone
GET    /api/v1/milestones/<id>         one milestone, e.g. to open its link
POST   /api/v1/milestones/<id>         edit it (its owner)
DELETE /api/v1/milestones/<id>         delete it (its owner)
PUT    /api/v1/milestones/<id>/favorite, DELETE: add to / remove from the user's favorites
POST   /api/v1/milestones/groups/favorite  the same for a group: {project, section: mine|shared, group, is_favorite}
POST   /api/v1/milestones/import       move the milestones older versions saved in browsers to the user's account
"""
from flask import request, jsonify
from sqlalchemy import or_

from backend import app, db_session
from backend.models import Project, Milestone, MilestoneFavorite, MilestoneGroupFavorite, CiCommit, Batch, Output, TestInput
from backend.milestones import summarize_runs, normalize_group, clean_fields, from_legacy, same_results, can_edit, serialize
from .auth import get_current_user, require_project_access, is_authorized_user, login_required, forbidden_project


def current_user_info():
  """The user's info, and their id if they are logged in"""
  user_info = get_current_user(to_jsonify=False)
  user_id = user_info.get('user_id') if user_info.get('is_authenticated') else None
  return user_info, user_id


def answer(milestone, user_info, favorites=None):
  user_id = user_info.get('user_id') if user_info.get('is_authenticated') else None
  if favorites is None:
    favorites = favorite_ids(user_id, [milestone.id])
  return serialize(milestone, user_id, favorites, user_info.get('user_name'))


def login_error():
  return jsonify({"error": "Sign in to save milestones: they are saved in your account.", "reason": "sign_in_required"}), 401


def favorite_ids(user_id, milestone_ids=None):
  if not user_id:
    return set()
  query = db_session.query(MilestoneFavorite.milestone_id).filter(MilestoneFavorite.user_id == user_id)
  if milestone_ids is not None:
    query = query.filter(MilestoneFavorite.milestone_id.in_(milestone_ids))
  return {milestone_id for milestone_id, in query}


def get_milestone(milestone_id):
  """The milestone, or an error response. Anyone who can see its project can see it: links work."""
  user_info, user_id = current_user_info()
  milestone = Milestone.query.filter(Milestone.id == milestone_id).one_or_none()
  if milestone is None:
    return None, user_info, (jsonify({"error": "This milestone doesn't exist anymore: it was deleted."}), 404)
  if not is_authorized_user(user_info, milestone.project_id):
    return None, user_info, forbidden_project(milestone.project_id)
  return milestone, user_info, None


def compute_runs(milestone):
  """Saves in the milestone what its runs used (datasets, qa batches, platforms), see summarize_runs"""
  # shown to whoever sees the milestone's project: only from results the current user can see too
  if not is_authorized_user(None, milestone.results_project_id):
    return
  hexsha = milestone.commit_hexsha
  commit_filter = CiCommit.hexsha == hexsha if len(hexsha) >= 40 else CiCommit.hexsha.startswith(hexsha)
  rows = (db_session
          .query(Output.output_type, Output.platform, Output.configurations, Output.extra_parameters, Output.data,
                 Output.is_failed, Output.is_pending, TestInput.path, TestInput.database, TestInput.data)
          .join(Batch, Output.batch_id == Batch.id)
          .join(CiCommit, Batch.ci_commit_id == CiCommit.id)
          .outerjoin(TestInput, Output.test_input_id == TestInput.id)
          .filter(CiCommit.project_id == milestone.results_project_id, commit_filter, Batch.label == (milestone.batch or 'default'))
          .filter(or_(Output.deleted == False, Output.deleted == None))
          .all())
  runs = [{
    'output_type': output_type, 'platform': platform, 'configurations': configurations, 'extra_parameters': extra_parameters,
    'batch': (data or {}).get('batch'), 'is_failed': is_failed, 'is_pending': is_pending,
    'path': path, 'database': database, 'metadata': (input_data or {}).get('metadata') or {},
  } for output_type, platform, configurations, extra_parameters, data, is_failed, is_pending, path, database, input_data in rows]
  milestone.data = {**(milestone.data or {}), 'runs': summarize_runs(runs, milestone.filter)}


def try_compute_runs(milestone):
  # milestones are saved even if we can't describe their runs
  try:
    compute_runs(milestone)
  except Exception as e:
    print(f"WARNING: could not describe the runs of {milestone}: {e}")


# milestones from before we described their runs get described when they're listed, a few at a time
BACKFILL_PER_REQUEST = 10


def set_commit_info(milestone, commit_info):
  if commit_info:
    milestone.data = {**(milestone.data or {}), **commit_info}


@app.route("/api/v1/milestones", methods=['GET'])
@app.route("/api/v1/milestones/", methods=['GET'])
def list_milestones():
  project_id = request.args.get('project')
  if not project_id:
    return jsonify({"error": "Missing ?project="}), 400
  user_info, user_id = current_user_info()
  if not is_authorized_user(user_info, project_id):
    return forbidden_project(project_id)
  # shared milestones, and the user's own. Personal milestones are only listed for their owner,
  # even after their owner is deleted (user_id becomes NULL): their links still work.
  visible = [Milestone.shared == True]
  if user_id:
    visible.append(Milestone.user_id == user_id)
  milestones = (Milestone.query
                .filter(Milestone.project_id == project_id)
                .filter(or_(*visible))
                .order_by(Milestone.updated_at.desc())
                .all())
  favorites = favorite_ids(user_id)
  # Favorites can be other users' personal milestones, opened from their link
  missing_runs = [m for m in milestones if 'runs' not in (m.data or {})][:BACKFILL_PER_REQUEST]
  if missing_runs:
    for m in missing_runs:
      try_compute_runs(m)
      db_session.add(m)
    db_session.commit()
  listed = {m.id for m in milestones}
  others = [i for i in favorites if i not in listed]
  if others:
    milestones += Milestone.query.filter(Milestone.project_id == project_id).filter(Milestone.id.in_(others)).all()
  favorite_groups = [] if not user_id else [
    {"section": f.section, "group": f.group}
    for f in MilestoneGroupFavorite.query.filter_by(user_id=user_id, project_id=project_id).order_by(MilestoneGroupFavorite.created_at)
  ]
  return jsonify({"milestones": [answer(m, user_info, favorites) for m in milestones], "favorite_groups": favorite_groups})


@app.route("/api/v1/milestones", methods=['POST'])
@app.route("/api/v1/milestones/", methods=['POST'])
@login_required
def create_milestone():
  user_info, user_id = current_user_info()
  if not user_id:
    return login_error()
  body = request.get_json(silent=True) or {}
  project_id = body.get('project')
  if not project_id or not Project.query.filter(Project.id == project_id).one_or_none():
    return jsonify({"error": "Project not found"}), 404
  if forbidden := require_project_access(user_info, project_id, 'milestones.write'):
    return forbidden
  fields, error = clean_fields(body)
  if error:
    return jsonify({"error": error}), 400
  # milestones protect their batch from deletion: only in projects the user can see
  if fields['commit_project_id'] and (forbidden := require_project_access(user_info, fields['commit_project_id'], 'project.read')):
    return forbidden
  commit_info = fields.pop('commit_info', None)
  milestone = Milestone(project_id=project_id, user_id=user_id, data={}, **fields)
  set_commit_info(milestone, commit_info)
  try_compute_runs(milestone)
  db_session.add(milestone)
  db_session.commit()
  return jsonify(answer(milestone, user_info, set())), 201


@app.route("/api/v1/milestones/<int:milestone_id>", methods=['GET'])
@app.route("/api/v1/milestones/<int:milestone_id>/", methods=['GET'])
def read_milestone(milestone_id):
  milestone, user_info, error = get_milestone(milestone_id)
  if error:
    return error
  return jsonify(answer(milestone, user_info))


# Edits use POST: some proxies drop the body of other methods
@app.route("/api/v1/milestones/<int:milestone_id>", methods=['POST', 'DELETE'])
@app.route("/api/v1/milestones/<int:milestone_id>/", methods=['POST', 'DELETE'])
@login_required
def edit_milestone(milestone_id):
  milestone, user_info, error = get_milestone(milestone_id)
  if error:
    return error
  user_id = user_info.get('user_id') if user_info.get('is_authenticated') else None
  if not user_id:
    return login_error()
  if not can_edit(milestone.user_id, user_id, milestone.data, user_info.get('user_name')):
    owner = milestone.user.full_name or milestone.user.user_name if milestone.user else None
    return jsonify({"error": f"Only {owner or 'its owner'} can edit or delete this milestone. Add it to your favorites, or save your own."}), 403
  # shared milestones without an owner: whoever can save milestones in the project
  if milestone.user_id != user_id and (forbidden := require_project_access(user_info, milestone.project_id, 'milestones.write')):
    return forbidden

  if request.method == 'DELETE':
    db_session.delete(milestone)
    db_session.commit()
    return jsonify({"status": "OK", "id": milestone_id})

  fields, error = clean_fields(request.get_json(silent=True) or {}, partial=True)
  if error:
    return jsonify({"error": error}), 400
  if fields.get('commit_project_id') and (forbidden := require_project_access(user_info, fields['commit_project_id'], 'project.read')):
    return forbidden
  set_commit_info(milestone, fields.pop('commit_info', None))
  for name, value in fields.items():
    setattr(milestone, name, value)
  # other results, or asked to look again (e.g. runs finished since it was saved)
  if {'commit_hexsha', 'batch', 'filter', 'commit_project_id'} & set(fields) or (request.get_json(silent=True) or {}).get('refresh_runs'):
    try_compute_runs(milestone)
  # Whoever edits a milestone without owner becomes its owner
  if milestone.user_id is None:
    milestone.user_id = user_id
  db_session.add(milestone)
  db_session.commit()
  return jsonify(answer(milestone, user_info))


@app.route("/api/v1/milestones/<int:milestone_id>/favorite", methods=['PUT', 'DELETE'])
@app.route("/api/v1/milestones/<int:milestone_id>/favorite/", methods=['PUT', 'DELETE'])
@login_required
def favorite_milestone(milestone_id):
  milestone, user_info, error = get_milestone(milestone_id)
  if error:
    return error
  user_id = user_info.get('user_id') if user_info.get('is_authenticated') else None
  if not user_id:
    return jsonify({"error": "Log in to add milestones to your favorites."}), 401
  favorite = MilestoneFavorite.query.filter_by(user_id=user_id, milestone_id=milestone_id).one_or_none()
  if request.method == 'PUT' and favorite is None:
    db_session.add(MilestoneFavorite(user_id=user_id, milestone_id=milestone_id))
  if request.method == 'DELETE' and favorite is not None:
    db_session.delete(favorite)
  db_session.commit()
  return jsonify({"id": milestone_id, "is_favorite": request.method == 'PUT'})


# POST: some proxies drop the body of DELETE requests
@app.route("/api/v1/milestones/groups/favorite", methods=['POST'])
@app.route("/api/v1/milestones/groups/favorite/", methods=['POST'])
@login_required
def favorite_group():
  user_info, user_id = current_user_info()
  if not user_id:
    return jsonify({"error": "Log in to add groups of milestones to your favorites."}), 401
  body = request.get_json(silent=True) or {}
  project_id, section = body.get('project'), body.get('section')
  group = normalize_group(body.get('group') or '') if isinstance(body.get('group'), str) else ''
  if not project_id or section not in ('mine', 'shared') or not group or len(group) > 200:
    return jsonify({"error": "Expected {project, section: mine|shared, group}"}), 400
  if not Project.query.filter(Project.id == project_id).one_or_none():
    return jsonify({"error": "Project not found"}), 404
  # favorites are personal: seeing the project is enough
  if forbidden := require_project_access(user_info, project_id, 'project.read'):
    return forbidden
  is_favorite = body.get('is_favorite', True) in (True, 'true')
  key = dict(user_id=user_id, project_id=project_id, section=section, group=group)
  favorite = MilestoneGroupFavorite.query.filter_by(**key).one_or_none()
  if is_favorite and favorite is None:
    db_session.add(MilestoneGroupFavorite(**key))
  if not is_favorite and favorite is not None:
    db_session.delete(favorite)
  db_session.commit()
  return jsonify({"section": section, "group": group, "is_favorite": is_favorite})


@app.route("/api/v1/milestones/import", methods=['POST'])
@app.route("/api/v1/milestones/import/", methods=['POST'])
@login_required
def import_milestones():
  """
  Until October 2026, "private" milestones were saved in browsers. When their users log in, the web app moves them
  to their account, as personal milestones. Importing twice doesn't create duplicates.
  Body: {"milestones": {project: {key: milestone}}}, like they were saved.
  Answers which projects are done (the browser can forget their milestones), and what was skipped.
  """
  user_info, user_id = current_user_info()
  if not user_id:
    return login_error()
  body = request.get_json(silent=True) or {}
  by_project = body.get('milestones')
  if not isinstance(by_project, dict):
    return jsonify({"error": "Expected {\"milestones\": {project: {key: milestone}}}"}), 400

  imported, done, skipped = 0, [], []
  for project_id, milestones in by_project.items():
    if not isinstance(milestones, dict):
      done.append(project_id)
      continue
    if not Project.query.filter(Project.id == project_id).one_or_none():
      # e.g. a project that was deleted or renamed: nothing to keep
      skipped.append({"project": project_id, "reason": "The project doesn't exist"})
      done.append(project_id)
      continue
    if require_project_access(user_info, project_id, 'milestones.write'):
      skipped.append({"project": project_id, "reason": "You can't save milestones in this project"})
      continue
    existing = [
      {'project_id': m.project_id, 'commit_hexsha': m.commit_hexsha, 'commit_project_id': m.commit_project_id, 'batch': m.batch, 'filter': m.filter, 'label': m.label}
      for m in Milestone.query.filter(Milestone.project_id == project_id).filter(Milestone.user_id == user_id)
    ]
    kept = False
    for key, legacy in milestones.items():
      fields = from_legacy(key, legacy, project_id)
      if fields is None:
        skipped.append({"project": project_id, "key": key, "reason": "Not a milestone"})
        continue
      # like when saving one: milestones protect their results from deletion, and describe them
      if fields['commit_project_id'] and not is_authorized_user(user_info, fields['commit_project_id']):
        skipped.append({"project": project_id, "key": key, "reason": f"You don't have access to {fields['commit_project_id']}"})
        kept = True # the browser keeps it, e.g. until they get access
        continue
      if any(same_results(fields, e) for e in existing):
        continue
      existing.append(fields)
      db_session.add(Milestone(user_id=user_id, shared=False, **fields))
      imported += 1
    if not kept:
      done.append(project_id)
  db_session.commit()
  return jsonify({"imported": imported, "done": done, "skipped": skipped})
