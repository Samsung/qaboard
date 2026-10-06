import json
import datetime

from flask import request, jsonify, redirect, make_response, g
from sqlalchemy.orm.attributes import flag_modified
from sqlalchemy.orm.exc import NoResultFound

from qaboard.conventions import deserialize_config
from qaboard.api import dir_to_url

from backend import app, db_session
from ..models import TestInput, CiCommit, Output
from ..storage import check_storage_path, UnsafePathError
from .auth import login_required


@app.route("/api/v1/output/<output_id>", methods=['GET'])
@app.route("/api/v1/output/<output_id>/", methods=['GET'])
def get_output(output_id):
  try:
    output = Output.query.filter(Output.id==output_id).one()
  except NoResultFound:
    return jsonify({"error": f"Cannot find output {output_id}"}), 400
  return jsonify(output.to_dict())


# Only the web app changes or deletes outputs, the CLI uses POST /api/v1/output/
# Deleting removes the output's folder, which comes from unauthenticated API calls
@app.route("/api/v1/output/<output_id>", methods=['PUT', 'DELETE'])
@app.route("/api/v1/output/<output_id>/", methods=['PUT', 'DELETE'])
@login_required
def update_output(output_id):
  try:
    output = Output.query.filter(Output.id==output_id).one()
  except NoResultFound:
    if request.method == 'DELETE':
      return {"status": "OK"}
    return jsonify({"error": f"Cannot find output {output_id}"}), 400

  if request.method == 'PUT':
    data = request.get_json()
    if 'is_pending' in data:
      output.is_pending = data['is_pending']
    if 'is_running' in data:
      output.is_running = data['is_running']
    if 'is_failed' in data:
      output.is_failed = data['is_failed']
    if 'data' in data:
      if not output.data:
        output.data = {}
      output.data.update(data['data'])
      flag_modified(output, "data")
    if data.get('batch'):
      output.data["batch"] = data["batch"]
      flag_modified(output, "data")
    if 'metrics' in data:
      output.metrics = {**output.metrics,  **data['metrics']}
      flag_modified(output, "metrics")
    db_session.add(output)
    db_session.commit()
    return jsonify(output.to_dict())

  if request.method == 'DELETE':
    if output.is_pending:
      return {"error": "Please wait for the Output to finish running before deleting it"}, 500
    soft = request.args.get('soft') == 'true'
    try:
      output.delete(soft=soft)
    except UnsafePathError as e:
      return jsonify({"error": f"{e}"}), 400
    if not soft:
      db_session.delete(output)
      db_session.commit()
    return {"status": "OK"}


@app.route('/api/v1/output/redo/<output_id>', methods=['POST'])
@app.route('/api/v1/output/redo/<output_id>/', methods=['POST'])
@login_required
def output_redo(output_id):
  try:
    output = Output.query.filter(Output.id==output_id).one()
  except NoResultFound:
    return jsonify({"error": f"Cannot find output {output_id}"}), 400
  try:
    success = output.redo(user=g.user['user_name'])
  except Exception as e:
    return jsonify({"error": f"{e}"}), 500
  if success:
    return '{"status": "OK"}'
  else:
    return jsonify({"error": "The run failed to start. Check the 'redo.log' files in the output directories to know more."}), 500


@app.route("/api/v1/output/<output_id>/manifest", methods=['GET'])
@app.route("/api/v1/output/<output_id>/manifest/", methods=['GET'])
def get_output_manifest(output_id):
  try:
    output = Output.query.filter(Output.id==output_id).one()
  except NoResultFound:
    return jsonify({"error": f"Cannot find output {output_id}"}), 400
  manifest_path = output.output_dir / "manifest.outputs.json"
  if output.is_running or request.args.get('refresh') or not manifest_path.exists():
    try:
      manifest = output.update_manifest(compute_hashes=False)
    except UnsafePathError as e:
      return jsonify({"error": f"{e}"}), 400
    return jsonify(manifest)
  else:
    # FIXME: in dev it will return http://backend/ and break the frontend who cannot connect
    #        in 2021 it seems the spec allow returning relative urls...
    #        Maybe we should return the manifest content instead...
    # return redirect(dir_to_url(manifest_path), code=302)
    response = make_response(manifest_path.read_text())
    response.headers['Content-Type'] = 'application/json'
    return response








@app.route('/api/v1/output', methods=['POST'])
@app.route('/api/v1/output/', methods=['POST'])
def new_output_webhook():
  """Updates the database when we get new results."""
  data = request.get_json()
  hexsha = data.get('commit_sha', data['git_commit_sha'])

  # The server will write, delete and run code in those folders
  output_directory = data.get('output_directory')
  # prefix_output_dir for backward-compatibility
  artifacts_commit = data.get('artifacts_commit', data.get('commit_ci_dir'))
  if not artifacts_commit or not artifacts_commit.startswith('/'): # or "some-protocol://"
    artifacts_commit = None # just ignore...
  try:
    if output_directory:
      check_storage_path(output_directory)
    if artifacts_commit:
      check_storage_path(artifacts_commit)
  except UnsafePathError as e:
    return jsonify({"error": f"{e}"}), 400

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

  # update the last_output times, with a crude debouncing to avoid
  # keeping locks on the tables too long
  now = datetime.datetime.utcnow()
  threshold = datetime.timedelta(seconds=5)
  # the column may be read back as timezone-aware (e.g. on fresh databases
  # created from the model's DateTime(timezone=True), unlike legacy
  # alembic-migrated databases), while `now` is naive: normalize before
  # subtracting to avoid TypeError
  def _naive(dt):
    return dt.replace(tzinfo=None) if dt is not None else dt
  if not ci_commit.project.latest_output_datetime or now - _naive(ci_commit.project.latest_output_datetime) > threshold:
      ci_commit.project.latest_output_datetime = now
  if not ci_commit.latest_output_datetime or now - _naive(ci_commit.latest_output_datetime) > threshold:
      ci_commit.latest_output_datetime = now

  # We make sure the Test on which we ran exists in the database 
  test_input_path = data.get('rel_input_path', data.get('input_path'))
  if not test_input_path:
    return jsonify({"error": "the input path was not provided"}), 400
  test_input = TestInput.get_or_create(
    db_session,
    path=test_input_path,
    database=data['database'],
    autocommit=True,
  )
  if data.get('input_metadata'):
    test_input.data['metadata'] = data['input_metadata']
    flag_modified(test_input, "data")

  # We save the basic information about our result
  batch = ci_commit.get_or_create_batch(data['batch_label'])
  if not batch.data:
    batch.data = {}
  batch.data.update({"type": data['job_type']})

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

  if not output.data:
    output.data = {}
  if "data" in data: # e.g. storage, job_options, batch name
    if not output.data:
      output.data = {}
    output.data.update(data['data'])
    flag_modified(output, "data")
  output.data["user"] = data['user']
  # we can only trust CI outputs to run on the exact code from the commit
  output.data["ci"] = data['job_type'] == 'ci'
  if data.get('batch'):
    output.data["batch"] = data["batch"]
  if output.deleted:
    output.deleted = False

  ci_commit.commit_dir_override = artifacts_commit
  output.output_dir_override = output_directory

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




