"""
Here is the "write" part of the API, to signal more data is ready.
It includes the actual webhooks sent e.g. by Gitlab, as well as
API calls to update batches and outputs.
"""
import sys
import json

from flask import request, jsonify
from sqlalchemy.orm.attributes import flag_modified

from backend import app, db_session
from ..models import CiCommit, Output
from ..models.Project import update_project


@app.route('/api/v1/commit/<path:project_id>/<commit_id>/batches', methods=['DELETE'])
@app.route('/api/v1/commit/<path:project_id>/<commit_id>/batches/', methods=['DELETE'])
@app.route('/api/v1/commit/<commit_id>/batches', methods=['DELETE'])
@app.route('/api/v1/commit/<commit_id>/batches/', methods=['DELETE'])
def delete_commit(commit_id, project_id=None):
  try:
    ci_commits = CiCommit.query.filter(CiCommit.hexsha == commit_id)
    if project_id:
      ci_commits = ci_commits.filter(CiCommit.project_id == project_id)
    ci_commits = ci_commits.all()
  except Exception as e:
    return f"404 ERROR {e}: {commit_id} in {project_id}", 404
  for ci_commit in ci_commits:
    print("DELETING", ci_commit)
    if ci_commit.hexsha in ci_commit.project.milestone_commits:
      return f"403 ERROR: Cannot delete milestones", 403
    for batch in ci_commit.batches:
      print(f" > {batch}")
      stop_status = batch.stop()
      if "error" in stop_status:
        return jsonify(stop_status), 500
      batch.delete(session=db_session)
    return {"status": "OK"}
  return f"404 ERROR: Cannot find commit", 404




@app.route('/webhook/gitlab', methods=['GET', 'POST'])
def gitlab_webhook():
  """If Gitlab calls this endpoint every push, we get avatars and update our local copy of the repo."""
  # https://docs.gitlab.com/ce/user/project/integrations/webhooks.html
  data = json.loads(request.data)
  print(data, file=sys.stderr)
  update_project(data, db_session)
  return "{status:'OK'}"

