import json
import datetime

from flask import request, jsonify, redirect
from sqlalchemy.orm.attributes import flag_modified

from qaboard.conventions import deserialize_config

from backend import app, db_session
from ..models import TestInput, CiCommit, Output


@app.route("/api/v1/output/<output_id>", methods=['GET', 'DELETE'])
@app.route("/api/v1/output/<output_id>/", methods=['GET', 'DELETE'])
def crud_output(output_id):
  output = Output.query.filter(Output.id==output_id).one()
  if request.method == 'GET':
    return jsonify(output.to_dict())
  if request.method == 'DELETE':
    if output.is_pending:
      return {"error": "Please wait for the Output to finish running before deleting it"}, 500
    output.delete(soft=False)
    db_session.delete(output)
    db_session.commit()
    return {"status": "OK"}





@app.route("/api/v1/output/<output_id>/manifest", methods=['GET'])
@app.route("/api/v1/output/<output_id>/manifest/", methods=['GET'])
def get_output_manifest(output_id):
  output = Output.query.filter(Output.id==output_id).one()
  if output.is_running or request.args.get('refresh'):
    manifest = output.update_manifest(compute_hashes=False)
    return jsonify(manifest)
  else:
    return redirect(f"{output.output_dir_url}/manifest.outputs.json", code=302)
    




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
  if not ci_commit.commit_dir_override.startswith('/'): # or "some-protocol://" 
    ci_commit.commit_dir_override = None # just ignore...
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

