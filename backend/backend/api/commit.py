import re
import datetime

import ujson
from flask import request, jsonify, make_response, g

from sqlalchemy.orm import selectinload
from sqlalchemy.orm.attributes import flag_modified

from backend import app, db_session
from ..access import invalid_project
from .auth import is_authorized_user, login_required, require_project_access, ingest_access, forbidden_project
from ..models import Project, CiCommit, latest_successful_commit, Batch
from ..storage import UnsafePathError
from .. import recreate_artifacts
from ..metrics_aggregation import parse_metrics_arg



@app.route("/api/v1/commit", methods=['GET', 'POST'])
@app.route("/api/v1/commit/", methods=['GET', 'POST'])
@app.route("/api/v1/commit/<path:commit_id>", methods=['GET', 'POST'])
def api_ci_commit(commit_id=None):
  if request.method == 'POST':
    if error := invalid_project(request.json.get('project')):
      return error
    submitted_by, error = ingest_access(request.json.get('project'))
    if error:
      return error
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
      # usually a commit we don't know, and whose git repository we can't read
      db_session.rollback()
      project = request.json.get('project', 'unknown')
      return jsonify({"error": f"{e}\n Project: {project} - There is an issue with your commit id ({hexsha})"}), 404
    if not commit.data:
      commit.data = {}
    # Clients can store any metadata with each commit.
    # We've been using it to store code quality metrics per subproject in our monorepo,
    # Then we use other tools (e.g. metabase) to create dashboards.
    commit_data = request.json.get('data', {})
    if not isinstance(commit_data, dict):
      commit_data = {}
    # QA-Board's own bookkeeping, clients can't change it
    commit_data = {k: v for k, v in commit_data.items() if k not in ('artifacts_recreation', 'artifacts_deleted', 'submitted_by')}
    commit.data = {**commit.data, **commit_data}
    if submitted_by:
      commit.data['submitted_by'] = submitted_by
    else:
      commit.data.pop('submitted_by', None)
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
    return forbidden_project(project_id)

  # ?with_outputs=false: only the commit and its batches' counts and metrics, e.g. for the references users
  # stacked but don't look at (a commit can have thousands of outputs)
  with_outputs = request.args.get('with_outputs', 'true') != 'false'
  batches_loader = selectinload(CiCommit.batches)
  if with_outputs:
    batches_loader = batches_loader.selectinload(Batch.outputs)

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
      return jsonify({'error': f'No commit with results yet for {project_id} on {branch}.'}), 404
  else:
    def find(*conditions):
      return (db_session
              .query(CiCommit)
              .options(batches_loader)
              .filter(CiCommit.project_id==project_id, *conditions)
              .order_by(CiCommit.authored_datetime.desc())
              .first())
    # fixme: some commits appear twice, one with a short hash...
    ci_commit = find(CiCommit.hexsha.startswith(commit_id))
    if not ci_commit:
      # Check if the user provided a branch name instead of a commit ID
      ci_commit = find(CiCommit.branch==commit_id)
    if not ci_commit:
      # if the user provided what looks like a commit ID, we want to fail fast
      # otherwise the code below is super slow
      if re.match(r'^[0-9a-fA-F]{40}$', commit_id):
        return jsonify({'error': f'Sorry, we could not find any data on commit ID {commit_id} in project {project_id}.'}), 404
      # A tag, or a branch whose latest results we saw on another branch: git knows its commit.
      # It's a GET: we only look for that commit's results, we don't create it.
      hexsha = git_ref_hexsha(project_id, commit_id)
      ci_commit = find(CiCommit.hexsha==hexsha) if hexsha else None
      if not ci_commit:
        return jsonify({'error': f'Sorry, we could not find any data on commit {commit_id} in project {project_id}.'}), 404

  batch = request.args.get('batch', None)
  with_batches = [batch] if batch else None # by default we show all batches
  try:
    with_aggregation = parse_metrics_arg(request.args.get('metrics'))
  except ValueError as e:
    return jsonify({"error": f"{e}"}), 400
  commit_dict = ci_commit.to_dict(db_session, with_aggregation, with_batches=with_batches, with_outputs=with_outputs)
  # checking the artifacts reads the storage, often a slow network filesystem
  if with_outputs:
    commit_dict['artifacts'] = commit_artifacts_info(ci_commit)
  response = make_response(ujson.dumps(commit_dict))
  response.headers['Content-Type'] = 'application/json'
  return response


def git_ref_hexsha(project_id, ref):
  """The commit of a git commit, branch or tag of the project, or None if git doesn't know it (or we can't read the repository)"""
  project = Project.query.filter(Project.id==project_id).one_or_none()
  repo = project.repo if project else None
  if not repo:
    return None
  # TODO: This is a valid use case for having read-rights to the repo,
  #       To replace this without read rights, we should listen for push events and build a database
  for resolve in (lambda: repo.commit(ref), lambda: repo.refs[ref].commit, lambda: repo.tags[ref].commit):
    try:
      return resolve().hexsha
    except Exception: # e.g. gitdb's BadName, IndexError
      continue
  return None


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
  if forbidden := require_project_access(g.user, ci_commit.project_id):
    return forbidden
  print(f"[save-artifacts] {ci_commit}")
  try:
    result = ci_commit.restore_artifacts(user=g.user, force=True)
  except UnsafePathError as e:
    return jsonify({"error": f"{e}"}), 400
  db_session.add(ci_commit)
  db_session.commit()
  if result["status"] == "failed":
    return jsonify({"error": result["message"], **result}), 500
  return jsonify(result)
