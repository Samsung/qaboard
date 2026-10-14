import re
import json
import datetime

from gitdb.exc import BadName
import ujson
from flask import request, jsonify, make_response, g

from sqlalchemy.orm import selectinload
from sqlalchemy.orm.exc import NoResultFound
from sqlalchemy.orm.attributes import flag_modified

from backend import app, db_session
from .auth import is_authorized_user, login_required
from ..models import Project, CiCommit, latest_successful_commit, Batch
from ..storage import UnsafePathError
from .. import recreate_artifacts



@app.route("/api/v1/commit", methods=['GET', 'POST'])
@app.route("/api/v1/commit/", methods=['GET', 'POST'])
@app.route("/api/v1/commit/<path:commit_id>", methods=['GET', 'POST'])
def api_ci_commit(commit_id=None):
  if request.method == 'POST':
    # git_commit_sha for backward-compatibility
    hexsha = commit_id or request.json.get('commit_sha') or request.json.get('git_commit_sha')
    try:
      commit = CiCommit.get_or_create(
        session=db_session,
        hexsha=hexsha,
        project_id=request.json['project'],
        data=request.json,
      )
    except Exception as e:
      project = request.json.get('project', 'unknown')
      return f"404 ERROR: {e}\n Project: {project} - There is an issue with your commit id ({hexsha})", 404
    if not commit.data:
      commit.data = {}
    # Clients can store any metadata with each commit.
    # We've been using it to store code quality metrics per subproject in our monorepo,
    # Then we use other tools (e.g. metabase) to create dashboards.
    commit_data = request.json.get('data', {})
    if not isinstance(commit_data, dict):
      commit_data = {}
    # QA-Board's own bookkeeping, clients can't change it
    commit_data = {k: v for k, v in commit_data.items() if k not in ('artifacts_recreation', 'artifacts_deleted')}
    commit.data = {**commit.data, **commit_data}
    flag_modified(commit, "data")
    # `qa save-artifacts` calls us when it's done. It may have saved only some artifacts,
    # so we check they are really usable before saying they are back.
    recreation = commit.data.get('artifacts_recreation')
    recreation = recreation if isinstance(recreation, dict) else {}
    if commit.deleted or recreation.get('status') == 'triggered':
      try:
        commit.deleted = False
        artifacts_ok = commit.artifacts_status()["ok"]
      except Exception as e:
        print(f"WARNING: could not check the artifacts of {commit}: {e}")
        artifacts_ok = False
      commit.deleted = not artifacts_ok
      if artifacts_ok and recreation:
        commit.data['artifacts_recreation'] = {**recreation, 'status': 'done', 'done_at': datetime.datetime.now(datetime.timezone.utc).isoformat()}
    db_session.add(commit)
    db_session.commit()
    return jsonify({"status": "OK"})


  project_id = request.args['project']

  if not is_authorized_user(None, project_id):
    return f"Forbidden: You don't have permission to access this project", 403

  if not commit_id:
    commit_id = request.args.get('commit', None)
    try:
      project = Project.query.filter(Project.id==project_id).one()
      default_branch = project.data['qatools_config']['project']['reference_branch']
    except:
      default_branch = None
    branch = request.args.get('branch', default_branch)
    ci_commit = latest_successful_commit(db_session, project_id=project_id, branch=branch, batch_label=request.args.get('batch'))
    if not ci_commit:
      return jsonify({'error': f'Sorry, we cant find any commit with results for the {project_id} on {branch}.'}), 404
  else:
    try:
      ci_commit = (db_session
                   .query(CiCommit)
                   .options(
                     selectinload(CiCommit.batches).
                     selectinload(Batch.outputs)
                    )
                   .filter(
                     CiCommit.project_id==project_id,
                     CiCommit.hexsha.startswith(commit_id),
                   )
                   .first()
                  )
      assert ci_commit
      # fixme: some commits appear twice, one with a short hash...
    except (NoResultFound, AssertionError):
      try:
      # Check if the user provided a branch name instead of a commit ID
        ci_commit = (db_session
                    .query(CiCommit)
                    .options(
                      selectinload(CiCommit.batches).
                      selectinload(Batch.outputs)
                      )
                    .filter(
                      CiCommit.project_id==project_id,
                      CiCommit.branch==commit_id,
                    )
                    .order_by(CiCommit.authored_datetime.desc())
                    .first()
                    )
        assert ci_commit
      except Exception:
        # if the user provided what looks like a commit ID, we want to fail fast
        # otherwise the code below is super slow
        if re.match(r'^[0-9a-fA-F]{40}$', commit_id):
          return jsonify({'error': f'Sorry, we could not find any data on commit ID {commit_id} in project {project_id}.'}), 404

        try:
          # TODO: This is a valid use case for having read-rights to the repo,
          #       we can identify a commit by the tag/branch
          #       To replace this without read rights, we should listen for push events and build a database
          project = Project.query.filter(Project.id==project_id).one()
          try:
            commit = project.repo.commit(commit_id)
          except:
            try:
              commit = project.repo.refs[commit_id].commit
            except:
              commit = project.repo.tags[commit_id].commit
          if not commit:
            return jsonify({'error': f'Sorry, we could not find any data on commit {commit_id} in project {project_id}.'}), 404
          ci_commit = CiCommit(commit, project=project)
          db_session.add(ci_commit)
          db_session.commit()
        except:
          return jsonify({'error': f'Sorry, we could not find any data on commit {commit_id} in project {project_id}.'}), 404
    except BadName:
      return jsonify({'error': f'Sorry, we could not understand the commit ID {commit_id} for project {project_id}.'}), 404

  batch = request.args.get('batch', None)
  with_batches = [batch] if batch else None # by default we show all batches
  with_aggregation = json.loads(request.args.get('metrics', '{}'))
  commit_dict = ci_commit.to_dict(db_session, with_aggregation, with_batches=with_batches, with_outputs=True)
  commit_dict['artifacts'] = commit_artifacts_info(ci_commit)
  response = make_response(ujson.dumps(commit_dict))
  response.headers['Content-Type'] = 'application/json'
  return response


def commit_artifacts_info(ci_commit):
  """What the web app needs to warn users about missing artifacts, before they try to run anything."""
  try:
    # the page is loaded often, and the storage is often a slow network filesystem: we check fewer files than before running
    status = ci_commit.artifacts_status(max_checked_files=50)
  except Exception as e:
    status = {"ok": False, "problems": [f"Could not check the artifacts: {e}"]}
  dict_or_none = lambda value: value if isinstance(value, dict) else None
  info = {
    **status,
    "recreate": None,
    "recreate_errors": [],
    "recreation": dict_or_none(ci_commit.data.get('artifacts_recreation')),
    # after a while, redo/tuning ask the CI again
    "recreating": recreate_artifacts.in_progress(ci_commit.data.get('artifacts_recreation')),
    "deletion": dict_or_none(ci_commit.data.get('artifacts_deleted')),
  }
  # the configuration comes from unauthenticated API calls: it must never break the commit page
  try:
    settings = ci_commit.recreate_artifacts_settings
    if settings:
      info["recreate_errors"] = recreate_artifacts.validate(settings, recreate_artifacts.template_variables(ci_commit))
      info["recreate"] = recreate_artifacts.describe(settings)
  except Exception as e:
    info["recreate_errors"] = [f"Could not read `recreate_artifacts`: {e}"]
  return info


@app.route("/api/v1/commit/save-artifacts/", methods=['POST'])
@app.route("/api/v1/commit/save-artifacts", methods=['POST'])
@login_required
def commit_save_artifacts():
  """
  Brings back a commit's artifacts: with `recreate_artifacts` from qaboard.yaml if defined,
  otherwise from the source code. Returns {status: restored|recreating|failed, message}
  """
  data = request.get_json()
  hexsha = data.get('hexsha')
  project_id = data.get('project')
  if not hexsha or not project_id:
    return jsonify({"error": "Missing hexsha or project"}), 400
  ci_commit = (db_session
               .query(CiCommit)
               .filter(CiCommit.project_id == project_id, CiCommit.hexsha.startswith(hexsha))
               .first())
  if not ci_commit:
    return jsonify({"error": f"Cannot find commit {hexsha} in {project_id}"}), 404
  print(f"[save-artifacts] {ci_commit}")
  try:
    result = ci_commit.restore_artifacts(user=g.user['user_name'], force=True)
  except UnsafePathError as e:
    return jsonify({"error": f"{e}"}), 400
  db_session.add(ci_commit)
  db_session.commit()
  if result["status"] == "failed":
    return jsonify({"error": result["message"], **result}), 500
  return jsonify(result)
