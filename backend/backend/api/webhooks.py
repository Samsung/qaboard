"""
Here is the "write" part of the API, to signal more data is ready.
It includes the actual webhooks sent e.g. by Gitlab, as well as
API calls to update batches and outputs.
"""
import sys
import json
import yaml
import datetime
import traceback
import subprocess
from pathlib import Path

from flask import request, jsonify
from sqlalchemy.orm.exc import NoResultFound
from sqlalchemy.orm.attributes import flag_modified

from backend import app, repos, db_session
from ..models import Project, CiCommit, Batch, Output, TestInput
from ..models.Project import update_project


@app.route('/api/v1/commit', methods=['POST'])
@app.route('/api/v1/commit/', methods=['POST'])
def update_commit():
  try:
    commit = CiCommit.get_or_create(
      session=db_session,
      hexsha=request.json['git_commit_sha'],
      project_id=request.json['project'],
    )
  except:
    return f"404 ERROR:\n ({request.json['project']}): There is an issue with your commit id ({request.json['git_commit_sha']})", 404
  if not commit.data:
    commit.data = {}
  commit_data = request.json.get('data', {})
  commit.data = {**commit.data, **commit_data}
  flag_modified(commit, "data")
  if commit.deleted:
    commit.deleted = False
  db_session.add(commit)
  db_session.commit()
  return jsonify({"status": "OK"})


@app.route('/api/v1/batch', methods=['POST'])
@app.route('/api/v1/batch/', methods=['POST'])
def update_batch():
  data = request.get_json()
  try:
    ci_commit = CiCommit.get_or_create(
      session=db_session,
      hexsha=request.json['git_commit_sha'],
      project_id=request.json['project'],
    )
  except:
    return f"404 ERROR:\n ({request.json['project']}): There is an issue with your commit id ({request.json['git_commit_sha']})", 404

  batch = ci_commit.get_or_create_batch(data['batch_label'])
  if not batch.data:
    batch.data = {}
  batch_data = request.json.get('data', {})
  batch.data = {**batch.data, **batch_data}

  command = request.json.get('command')
  if command:
    batch.data["commands"] = {**batch.data.get('commands', {}), **command}
    flag_modified(batch, "data")

  is_best = 'best_iter' in batch_data and batch_data['best_iter'] != batch.data.get('best_iter')
  if is_best:
    # remove all non-optim_iteration results from the batch
    batch.outputs = [o for o in batch.outputs if o.output_type=='optim_iteration']
    db_session.add(batch)
    db_session.commit()
    # make copy of all outputs in the best batch
    best_batch = ci_commit.get_or_create_batch(f"{data['batch_label']}|iter{batch_data.get('best_iter')}")
    for o in best_batch.outputs:
      o_copy = o.copy()
      o_copy.output_dir_override = str(o.output_dir)
      o_copy.batch = batch
      db_session.add(o_copy)

  db_session.add(batch)
  db_session.commit()
  return jsonify({"status": "OK"})



@app.route('/api/v1/batch/stop', methods=['POST'])
@app.route('/api/v1/batch/stop/', methods=['POST'])
def stop_batch():
  data = request.get_json()
  try:
    batch = Batch.query.filter(Batch.id == data['id']).one()
  except:
    return f"404 ERROR:\n Not found", 404
  status = batch.stop()
  return jsonify(status), 200 if not "error" in status else 500

@app.route('/api/v1/batch/redo', methods=['POST'])
@app.route('/api/v1/batch/redo/', methods=['POST'])
def redo_batch():
  data = request.get_json()
  try:
    batch = Batch.query.filter(Batch.id == data['id']).one()
  except:
    return f"404 ERROR:\n Not found", 404
  status = batch.redo(only_deleted=data.get('only_deleted', False))
  return '{"status": "OK"}'


@app.route('/api/v1/batch/<batch_id>', methods=['DELETE'])
@app.route('/api/v1/batch/<batch_id>/', methods=['DELETE'])
def delete_batch(batch_id):
  try:
    batch = Batch.query.filter(Batch.id == batch_id).one()
  except:
    return f"404 ERROR:\nNot found", 404
  stop_status = batch.stop()
  if "error" in stop_status:
    return jsonify(stop_status), 500
  batch.delete(session=db_session, only_failed=request.args.get('only_failed', False))
  return {"status": "OK"}



@app.route('/api/v1/output', methods=['POST'])
@app.route('/api/v1/output/', methods=['POST'])
def new_output_webhook():
  """Updates the database when we get new results."""
  data = request.get_json()

  # We get a handle on the Commit object related to our new output
  try:
    ci_commit = CiCommit.get_or_create(
      session=db_session,
      hexsha=data['git_commit_sha'],
      project_id=data['project'],
    )
  except:
    return jsonify({"error": f"Could not find your commit ({data['git_commit_sha']})."}), 404

  ci_commit.project.latest_output_datetime = datetime.datetime.utcnow()
  ci_commit.latest_output_datetime = datetime.datetime.utcnow()

  # We make sure the Test on which we ran exists in the database 
  test_input_path = data.get('input_path')
  if not test_input_path:
    return jsonify({"error": "the input path was not provided"}, 400)
  test_input = TestInput.get_or_create(
    db_session,
    path=test_input_path,
    database=data.get('database', ci_commit.project.database),
  )

  # We save the basic information about our result
  batch = ci_commit.get_or_create_batch(data['batch_label'])
  if not batch.data:
    batch.data = {}
  batch.data.update({"type": data['job_type']})
  if data.get('input_metadata'):
    test_input.data['metadata'] = data['input_metadata']
    flag_modified(test_input, "data")

  output = Output.get_or_create(db_session,
                                         batch=batch,
                                         platform=data['platform'],
                                         configuration=data['configuration'],
                                         extra_parameters=data['extra_parameters'],
                                         test_input=test_input,
                                        )
  output.output_type = data.get('input_type', '')

  # we can only trust CI outputs to run on the exact code from the commit
  output.data = data.get('data', {"ci": data['job_type'] == 'ci'})
  if output.deleted:
    output.deleted = False

  # We allow users to save their data in custom locations
  # at the commit and output levels
  if Path(data.get('commit_ci_dir', ci_commit.commit_dir)) != ci_commit.commit_dir:
    ci_commit.commit_dir_override = data.get('commit_ci_dir')
  if Path(data.get('output_directory', output.output_dir)) != output.output_dir:
    output.output_dir_override = data.get('output_directory')

  # We update the output's status
  output.is_running = data.get('is_running', False)
  if output.is_running:
    output.is_pending = True
  else:
    output.is_pending = data.get('is_pending', False)

  # We save the output's metrics
  if not output.is_pending:
    metrics = data.get('metrics', {})
    output.metrics = metrics
    output.is_failed = data.get('is_failed', False) or metrics.get('is_failed')

  db_session.add(output)
  db_session.commit()
  return jsonify(output.to_dict())



@app.route('/webhook/gitlab', methods=['GET', 'POST'])
def gitlab_webhook():
  """Gitlab calls this endpoint every push, it garantees we stay synced."""
  # https://docs.gitlab.com/ce/user/project/integrations/webhooks.html
  data = json.loads(request.data)
  print(data, file=sys.stderr)
  update_project(data, db_session)
  return "{status:'OK'}"

