"""
Milestones: results saved to compare with later. See models/Milestone.py, and backend/milestones.py for the rules.

GET    /api/v1/milestones?project=     the milestones the user sees: shared ones, and their own
POST   /api/v1/milestones              save a milestone
GET    /api/v1/milestones/<id>         one milestone, e.g. to open its link
POST   /api/v1/milestones/<id>         edit it (its owner)
DELETE /api/v1/milestones/<id>         delete it (its owner)
PUT    /api/v1/milestones/<id>/favorite, DELETE: add to / remove from the user's favorites
POST   /api/v1/milestones/import       move the milestones older versions saved in browsers to the user's account
"""
from flask import request, jsonify
from sqlalchemy import or_

from backend import app, db_session
from backend.models import Project, Milestone, MilestoneFavorite
from backend.milestones import clean_fields, from_legacy, same_results, can_edit, serialize
from .auth import get_current_user, require_project_access, is_authorized_user, login_required


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
  return jsonify({"error": "Log in to save milestones: they are saved in your account."}), 401


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
    return None, user_info, (jsonify({"error": "Forbidden: You don't have permission to access this project"}), 403)
  return milestone, user_info, None


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
    return jsonify({"error": "Forbidden: You don't have permission to access this project"}), 403
  visible = [Milestone.shared == True, Milestone.user_id == None]
  if user_id:
    visible.append(Milestone.user_id == user_id)
  milestones = (Milestone.query
                .filter(Milestone.project_id == project_id)
                .filter(or_(*visible))
                .order_by(Milestone.updated_at.desc())
                .all())
  favorites = favorite_ids(user_id)
  # Favorites can be other users' personal milestones, opened from their link
  others = [i for i in favorites if i not in {m.id for m in milestones}]
  if others:
    milestones += Milestone.query.filter(Milestone.project_id == project_id).filter(Milestone.id.in_(others)).all()
  return jsonify({"milestones": [answer(m, user_info, favorites) for m in milestones]})


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
  if forbidden := require_project_access(user_info, project_id):
    return forbidden
  fields, error = clean_fields(body)
  if error:
    return jsonify({"error": error}), 400
  commit_info = fields.pop('commit_info', None)
  milestone = Milestone(project_id=project_id, user_id=user_id, data={}, **fields)
  set_commit_info(milestone, commit_info)
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

  if request.method == 'DELETE':
    db_session.delete(milestone)
    db_session.commit()
    return jsonify({"status": "OK", "id": milestone_id})

  fields, error = clean_fields(request.get_json(silent=True) or {}, partial=True)
  if error:
    return jsonify({"error": error}), 400
  set_commit_info(milestone, fields.pop('commit_info', None))
  for name, value in fields.items():
    setattr(milestone, name, value)
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
    if not is_authorized_user(user_info, project_id):
      skipped.append({"project": project_id, "reason": "You don't have access to this project"})
      continue
    existing = [
      {'project_id': m.project_id, 'commit_hexsha': m.commit_hexsha, 'commit_project_id': m.commit_project_id, 'batch': m.batch, 'filter': m.filter, 'label': m.label}
      for m in Milestone.query.filter(Milestone.project_id == project_id).filter(Milestone.user_id == user_id)
    ]
    for key, legacy in milestones.items():
      fields = from_legacy(key, legacy, project_id)
      if fields is None:
        skipped.append({"project": project_id, "key": key, "reason": "Not a milestone"})
        continue
      if any(same_results(fields, e) for e in existing):
        continue
      existing.append(fields)
      db_session.add(Milestone(user_id=user_id, shared=False, **fields))
      imported += 1
    done.append(project_id)
  db_session.commit()
  return jsonify({"imported": imported, "done": done, "skipped": skipped})
