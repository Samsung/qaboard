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

from qaboard.conventions import deserialize_config


@app.route('/api/v1/batch', methods=['POST'])
@app.route('/api/v1/batch/', methods=['POST'])
def update_batch():
  data = request.get_json()
  try:
    ci_commit = CiCommit.get_or_create(
      session=db_session,
      hexsha=request.json['git_commit_sha'],
      project_id=request.json['project'],
      data=data,
    )
  except:
    return f"404 ERROR:\n ({request.json['project']}): There is an issue with your commit id ({request.json['git_commit_sha']})", 404

  batch = ci_commit.get_or_create_batch(data['batch_label'])
  # prefix_output_dir for backward-compatibility
  batch.batch_dir_override = data.get("batch_dir", data.get("prefix_output_dir"))

  # Clients can store any metadata in each batch.
  # Currently it's used by `qa optimize` to store info on iterations
  if not batch.data:
    batch.data = {}
  batch_data = request.json.get('data', {})
  # And each batch can have changes vs its commit's config and metrics.
  # The use case is usually working locally with `qa --share` and
  # seeing updated visualizations and metrics.
  if "qaboard_config" in data and data["qaboard_config"] != ci_commit.data["qatools_config"]:
    batch.data["config"] = data["qaboard_config"]
  if "qaboard_metrics" in data and data["qaboard_metrics"] != ci_commit.data["qatools_metrics"]:
    batch.data["qatools_metrics"] = data["qaboard_metrics"]
  batch.data = {**batch.data, **batch_data}

  # Save info on each "qa batch" command in the batch, mainly to list them in logs
  command = request.json.get('command')
  if command:
    batch.data["commands"] = {**batch.data.get('commands', {}), **command}
    flag_modified(batch, "data")

  # It's a `qa optimzize` experiment
  if batch_data.get('optimization'):
    if 'best_iter' in batch_data:
      # we will save the outputs from the best iteration in the batch,
      # so first we need to remove any previous best results
      for o in batch.outputs:
        if o.output_type != 'optim_iteration':
          o.delete(soft=False)
      db_session.add(batch)
      db_session.commit()
      # Move results from the best iteration in this batch
      batch_batch_label = batch_data['last_iteration_label']
      best_batch = ci_commit.get_or_create_batch(batch_batch_label)
      for o in best_batch.outputs:
        o.output_dir_override = str(o.output_dir)
        o.batch = batch
        db_session.add(o)
      db_session.commit()

      # Deleting old iterations
      for b in ci_commit.batches:
        if b.label.startswith(f"{data['batch_label']}|iter") and b.label != batch_data['last_iteration_label']:
          print(f'Deleting {b.label}')
          if b.label != batch_data['last_iteration_label']:
            b.delete(db_session)

  db_session.add(batch)
  db_session.commit()
  return jsonify({"status": "OK", "id": batch.id})



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

@app.route('/api/v1/batch/rename', methods=['POST'])
@app.route('/api/v1/batch/rename/', methods=['POST'])
def rename_batch():
  data = request.get_json()
  try:
    batch = Batch.query.filter(Batch.id == data['id']).one()
  except:
    return f"404 ERROR:\n Not found", 404
  status = batch.rename(label=data['label'], db_session=db_session)
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
  hexsha = data.get('commit_sha', data['git_commit_sha'])
  # We get a handle on the Commit object related to our new output
  try:
    ci_commit = CiCommit.get_or_create(
      session=db_session,
      hexsha=hexsha,
      project_id=data['project'],
      data=data,
    )
  except Exception as e:
    return jsonify({"error": f"Could not find your commit ({data['git_commit_sha']}). {e}"}), 404

  ci_commit.project.latest_output_datetime = datetime.datetime.utcnow()
  ci_commit.latest_output_datetime = datetime.datetime.utcnow()

  # We make sure the Test on which we ran exists in the database 
  test_input_path = data.get('rel_input_path', data.get('input_path'))
  if not test_input_path:
    return jsonify({"error": "the input path was not provided"}), 400
  test_input = TestInput.get_or_create(
    db_session,
    path=test_input_path,
    database=data['database'],
  )

  # We save the basic information about our result
  batch = ci_commit.get_or_create_batch(data['batch_label'])
  if not batch.data:
    batch.data = {}
  batch.data.update({"type": data['job_type']})
  if data.get('input_metadata'):
    test_input.data['metadata'] = data['input_metadata']
    flag_modified(test_input, "data")

  platform = data['platform']
  # for backward-compat with old clients
  if platform == 'lsf':
    platform = 'linux'

  configurations = deserialize_config(data['configuration']) if 'configuration' in data else data['configurations']
  output = Output.get_or_create(db_session,
                                         batch=batch,
                                         platform=platform,
                                         configurations=configurations,
                                         extra_parameters=data['extra_parameters'],
                                         test_input=test_input,
                                        )
  output.output_type = data.get('input_type', '')

  output.data = data.get('data', {})
  # we can only trust CI outputs to run on the exact code from the commit
  output.data["ci"] = data['job_type'] == 'ci'
  if output.deleted:
    output.deleted = False

  # prefix_output_dir for backward-compatibility
  ci_commit.commit_dir_override = data.get('artifacts_commit', data.get('commit_ci_dir'))
  output.output_dir_override = data['output_directory']

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

  db_session.add(ci_commit)
  db_session.add(output)
  db_session.commit()
  return jsonify(output.to_dict())



@app.route('/webhook/gitlab', methods=['GET', 'POST'])
def gitlab_webhook():
  """If Gitlab calls this endpoint every push, we get avatars and update our local copy of the repo."""
  # https://docs.gitlab.com/ce/user/project/integrations/webhooks.html
  data = json.loads(request.data)
  print(data, file=sys.stderr)
  update_project(data, db_session)
  return "{status:'OK'}"

