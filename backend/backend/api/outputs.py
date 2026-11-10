import datetime
import math

from typing import Optional

from flask import request, jsonify, make_response, g
from sqlalchemy.orm.attributes import flag_modified
from sqlalchemy.orm.exc import NoResultFound

from qaboard.conventions import deserialize_config

from backend import app, db_session
from ..models import TestInput, CiCommit, Output
from ..origins import run_origin, run_user, claim_batch
from ..storage import check_storage_path, UnsafePathError
from ..metrics_definitions import MAX_KEY_LENGTH, FORBIDDEN_KEYS
from ..redo import redo_response
from ..metrics_definitions import save_metrics_definitions
from ..notifications.batches import on_run_ended
from ..attempts import record_attempt
from ..access import invalid_project
from .auth import login_required, is_authorized_user, ingest_access, forbidden_project, require_project_access

# Keys of a run's data that only the server sets
# - optimization_best allows `qa optimize` to replace this run (see api/batch.py)
# - submitted_by is who really sent it (api/auth.py:ingest_access)
# - added_metrics records the metrics scripts added after the run (add_output_metrics)
# - attempt and previous_attempts say how many times the run was done (backend/attempts.py)
SERVER_KEYS = {'optimization_best', 'submitted_by', 'added_metrics', 'attempt', 'previous_attempts'}
# Metrics that only the run itself sets
RUN_ONLY_METRICS = {'is_failed', 'compute_time'}
# What scripts can say about themselves when they add metrics
SOURCE_KEYS = ('script', 'script_sha256', 'qaboard_version', 'note')
# At most that many metrics added per request, and their text values' length: they're parsed by every view of the batch
MAX_ADDED_METRICS = 500
MAX_ADDED_TEXT = 500


def added_metrics_of(data) -> dict:
  data = data if isinstance(data, dict) else {}
  added = data.get('added_metrics')
  return added if isinstance(added, dict) else {}


def with_added_metrics(output, metrics: dict, data: dict) -> dict:
  """
  The metrics a run sent, plus those scripts added to it before (`run.log()`), unless the run now returns them itself:
  then the run's value wins and the addition is forgotten. `data` is the run's data as the database has it now, read
  under a lock: a script may have added metrics while the run ran. Updates output.data.
  """
  added = added_metrics_of(data)
  kept = {k: v for k, v in added.items() if k not in metrics and isinstance(v, dict) and 'value' in v}
  if kept != added_metrics_of(output.data):
    if not output.data:
      output.data = {}
    output.data['added_metrics'] = kept
    flag_modified(output, "data")
  return {**{k: v['value'] for k, v in kept.items()}, **metrics}


def current_data(output) -> dict:
  """The run's data as the database has it now, locked until the transaction ends. The in-memory copy may be stale."""
  if getattr(output, 'id', None) is None:
    return output.data if isinstance(output.data, dict) else {}
  try:
    data = db_session.query(Output.data).filter(Output.id == output.id).with_for_update().scalar()
  except Exception:
    data = None
  return data if isinstance(data, dict) else (output.data if isinstance(output.data, dict) else {})


def invalid_added_metrics(metrics) -> Optional[str]:
  """Why scripts can't add these metrics: values must be finite numbers, booleans, short texts or null, with sane keys."""
  if not isinstance(metrics, dict) or not metrics:
    return '`metrics` must be an object with at least one metric: {"metrics": {"sharpness": 0.4}}'
  if len(metrics) > MAX_ADDED_METRICS:
    return f"at most {MAX_ADDED_METRICS} metrics per request"
  for key, value in metrics.items():
    if not isinstance(key, str) or not key or len(key) > MAX_KEY_LENGTH or key in FORBIDDEN_KEYS:
      return f"invalid metric name: {str(key)[:50]!r}"
    if key in RUN_ONLY_METRICS:
      return f"only the run itself sets {key}"
    if isinstance(value, bool) or value is None:
      continue
    if isinstance(value, (int, float)):
      if isinstance(value, float) and not math.isfinite(value):
        return f"{key} is not a finite number: NaN and infinity can't be saved"
      continue
    if isinstance(value, str):
      if len(value) > MAX_ADDED_TEXT:
        return f"{key}: texts are limited to {MAX_ADDED_TEXT} characters"
      continue
    return f"{key}: metrics added to runs are numbers, booleans, texts or null, not {type(value).__name__}"
  return None


@app.route("/api/v1/output/<output_id>", methods=['GET'])
@app.route("/api/v1/output/<output_id>/", methods=['GET'])
def get_output(output_id):
  try:
    output = Output.query.filter(Output.id==output_id).one()
  except NoResultFound:
    return jsonify({"error": f"Cannot find output {output_id}"}), 404
  if not is_authorized_user(None, output.batch.ci_commit.project_id):
    return forbidden_project(output.batch.ci_commit.project_id)
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
    return jsonify({"error": f"Cannot find output {output_id}"}), 404
  if forbidden := require_project_access(g.user, output.batch.ci_commit.project_id):
    return forbidden

  if request.method == 'PUT':
    data = request.get_json()
    if 'is_pending' in data or 'is_running' in data:
      is_pending = data.get('is_pending', output.is_pending)
      output.set_status(is_pending, data.get('is_running', output.is_running if is_pending else False))
    if 'is_failed' in data:
      output.is_failed = data['is_failed']
    if 'data' in data:
      if not isinstance(data['data'], dict):
        return jsonify({"error": "`data` must be an object"}), 400
      if not output.data:
        output.data = {}
      output.data.update({k: v for k, v in data['data'].items() if k not in SERVER_KEYS})
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
      return {"error": "Please wait for the Output to finish running before deleting it"}, 409
    soft = request.args.get('soft') == 'true'
    batch_id = output.batch_id
    try:
      output.delete(soft=soft)
    except UnsafePathError as e:
      return jsonify({"error": f"{e}"}), 400
    if not soft:
      db_session.delete(output)
    # soft deletes mark the run as deleted
    db_session.commit()
    from ..storage_usage import refresh_soon
    refresh_soon([batch_id])
    return {"status": "OK"}


@app.route("/api/v1/output/<output_id>/metrics", methods=['PATCH'])
@app.route("/api/v1/output/<output_id>/metrics/", methods=['PATCH'])
def add_output_metrics(output_id):
  """
  Adds metrics to a finished run, from a script (`run.log()` in the Python SDK): they are merged into the run's metrics,
  and QA-Board remembers who added each one, when and with which script (output.data.added_metrics). The run's own
  metrics.json is not changed, and nothing is written to the storage. Needs a token with the ingest scope and the
  developer role, whatever ingest.auth says: unlike `qa`'s results, this has no legacy anonymous clients.
  """
  project_id = None
  try:
    output = Output.query.filter(Output.id==output_id).with_for_update().one()
    project_id = output.batch.ci_commit.project_id
  except NoResultFound:
    pass
  # who can't see the project doesn't learn whether the run exists
  if project_id is None or not is_authorized_user(None, project_id):
    if project_id is not None:
      return forbidden_project(project_id)
    return jsonify({"error": f"Cannot find output {output_id}"}), 404
  submitted_by, error = ingest_access(project_id, require_token=True)
  if error:
    return error
  assert submitted_by
  data = request.get_json(silent=True) or {}
  metrics = data.get('metrics')
  if problem := invalid_added_metrics(metrics):
    return jsonify({"error": problem}), 400
  if output.is_pending:
    return jsonify({"error": "The run hasn't finished: wait for it before adding metrics"}), 409
  if output.deleted:
    return jsonify({"error": "The run's files were deleted: nothing to add metrics to"}), 409
  previous_metrics = output.metrics or {}
  previously_added = added_metrics_of(output.data)
  # the run's own values are not replaced silently
  owned = sorted(k for k in metrics if k in previous_metrics and k not in previously_added)
  if owned and not data.get('overwrite'):
    return jsonify({"error": f"The run itself returned {', '.join(owned)}: pass overwrite=True to replace its values", "reason": "metrics_exist", "metrics": owned}), 409

  source = data.get('source') if isinstance(data.get('source'), dict) else {}
  source = {k: str(source[k])[:500] for k in SOURCE_KEYS if source.get(k) is not None}
  # who: the token's user, never what the script claims
  source['user'] = submitted_by.get('user_name')
  if submitted_by.get('token_name'):
    source['token'] = submitted_by['token_name']
  now = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds')
  added = {}
  for key, value in metrics.items():
    entry = {'value': value, 'at': now, **source}
    if key in previous_metrics:
      entry['replaced'] = previously_added[key]['value'] if key in previously_added and isinstance(previously_added[key], dict) and 'value' in previously_added[key] else previous_metrics[key]
    if key in previously_added and isinstance(previously_added[key], dict) and 'replaced' in previously_added[key]:
      entry['replaced'] = previously_added[key]['replaced']  # the run's own value, before any script
    added[key] = entry

  if not output.data:
    output.data = {}
  output.data['added_metrics'] = {**previously_added, **added}
  flag_modified(output, "data")
  output.metrics = {**previous_metrics, **metrics}
  flag_modified(output, "metrics")
  db_session.add(output)
  db_session.commit()

  ci_commit = output.batch.ci_commit
  definitions = data.get('metrics_definitions')
  if isinstance(definitions, dict) and definitions:
    # only for the metrics added: not a way to redefine the others
    definitions = {k: v for k, v in definitions.items() if k in metrics}
    project_config = (ci_commit.project.data or {}).get('qatools_config') if isinstance(getattr(ci_commit.project, 'data', None), dict) else None
    try:
      save_metrics_definitions(db_session, ci_commit, {'metrics_definitions': definitions, 'commit_branch': ci_commit.branch, 'qaboard_config': project_config})
    except Exception as e:
      db_session.rollback()
      print(f"WARNING: could not save the metrics definitions added to output {output_id}: {e}")
  return jsonify({**output.to_dict(), "added": added})


@app.route('/api/v1/output/redo/<output_id>', methods=['POST'])
@app.route('/api/v1/output/redo/<output_id>/', methods=['POST'])
@login_required
def output_redo(output_id):
  try:
    output = Output.query.filter(Output.id==output_id).one()
  except NoResultFound:
    return jsonify({"error": f"Cannot find output {output_id}"}), 404
  if forbidden := require_project_access(g.user, output.batch.ci_commit.project_id):
    return forbidden
  return redo_response(output.batch, [output], g.user)


@app.route("/api/v1/output/<output_id>/manifest", methods=['GET'])
@app.route("/api/v1/output/<output_id>/manifest/", methods=['GET'])
def get_output_manifest(output_id):
  try:
    output = Output.query.filter(Output.id==output_id).one()
  except NoResultFound:
    return jsonify({"error": f"Cannot find output {output_id}"}), 404
  if not is_authorized_user(None, output.batch.ci_commit.project_id):
    return forbidden_project(output.batch.ci_commit.project_id)
  manifest_path = output.output_dir / "manifest.outputs.json"
  if output.is_running or request.args.get('refresh') or not manifest_path.exists():
    try:
      manifest = output.update_manifest(compute_hashes=False)
    except UnsafePathError as e:
      return jsonify({"error": f"{e}"}), 400
    return jsonify(manifest)
  else:
    # We return the manifest's content instead of redirecting to dir_to_url(manifest_path):
    # in dev, redirects pointed to http://backend/, which the frontend cannot reach.
    response = make_response(manifest_path.read_text())
    response.headers['Content-Type'] = 'application/json'
    return response


@app.route('/api/v1/output', methods=['POST'])
@app.route('/api/v1/output/', methods=['POST'])
def new_output_webhook():
  """Updates the database when we get new results."""
  data = request.get_json()
  # git_commit_sha for backward-compatibility
  hexsha = data.get('commit_sha') or data.get('git_commit_sha')
  if not hexsha:
    return jsonify({"error": "the commit (commit_sha) was not provided"}), 400

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

  if error := invalid_project(data.get('project')):
    return error
  submitted_by, error = ingest_access(data.get('project'))
  if error:
    return error

  # We get a handle on the Commit object related to our new output
  try:
    ci_commit = CiCommit.get_or_create(
      session=db_session,
      hexsha=hexsha,
      project_id=data['project'],
      data=data,
    )
  except Exception as e:
    return jsonify({"error": f"Could not find your commit ({hexsha}). {e}"}), 404

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
  # A run that is done again, in a new directory or in place: we remember the attempt it replaces
  record_attempt(output, output_directory, is_pending=bool(data.get('is_pending') or data.get('is_running')))

  if not output.data:
    output.data = {}
  if "data" in data: # e.g. storage, job_options, batch name
    output.data.update({k: v for k, v in data['data'].items() if k not in SERVER_KEYS})
    # The `qa batch` command that started the run: the first one when they are nested, e.g. in pipelines.
    # Older clients only send the command of their own `qa batch`. Used to know when batches end (backend/notifications/)
    job_options = data['data'].get('job_options') if isinstance(data['data'].get('job_options'), dict) else {}
    root_command_id = data['data'].get('root_command_id') or job_options.get('command_id')
    if root_command_id:
      output.data['root_command_id'] = str(root_command_id)
    flag_modified(output, "data")
  output.data["user"] = data['user']
  # the changes below are in place: tell SQLAlchemy, also when the client sent no `data`
  flag_modified(output, "data")
  # who really sent it, `user` is who it claims to be
  if submitted_by:
    output.data["submitted_by"] = submitted_by
  else:
    output.data.pop("submitted_by", None)
  # we can only trust CI outputs to run on the exact code from the commit
  output.data["ci"] = data['job_type'] == 'ci'
  # where it comes from, and the batch's if it's new (backend/origins.py)
  sent_data = data.get('data') if isinstance(data.get('data'), dict) else {}
  sent_job_options = sent_data.get('job_options') if isinstance(sent_data.get('job_options'), dict) else {}
  origin = run_origin(data, batch.data, submitted_by, [sent_data.get('root_command_id'), sent_job_options.get('command_id')])
  output.data["origin"] = origin
  claim_batch(batch, origin, run_user(data, submitted_by), (submitted_by or {}).get('user_id'))
  if not isinstance(batch.latest_output_datetime, datetime.datetime) or now - batch.latest_output_datetime > threshold:
    batch.latest_output_datetime = now
  if data.get('batch'):
    output.data["batch"] = data["batch"]
  if output.deleted:
    output.deleted = False

  ci_commit.commit_dir_override = artifacts_commit
  output.output_dir_override = output_directory

  # We update the output's status
  output.set_status(data.get('is_pending', False), data.get('is_running', False))

  # A run that starts again (redo, qa batch...) is not failed anymore, until it says so when it ends.
  # Else re-runs of failed runs show as failed (and count as failed) while they are pending or running.
  if output.is_pending:
    output.is_failed = False
  # We save the output's metrics
  else:
    metrics = data.get('metrics') or {}
    # the metrics scripts added to a previous run of this test stay, unless the run now computes them
    output.metrics = with_added_metrics(output, metrics, current_data(output))
    # False when the metrics don't say: batches count NULL as neither valid nor failed
    output.is_failed = bool(data.get('is_failed', False) or metrics.get('is_failed'))

  db_session.add(ci_commit)
  db_session.add(output)
  db_session.commit()
  if not output.is_pending:
    # maybe the batch's last run: users may want to know
    on_run_ended(db_session, output.data.get('root_command_id'))
  # The metrics the run's code declared, e.g. qaboard.Metric(12.3, suffix="ms")
  if data.get('metrics_definitions'):
    try:
      save_metrics_definitions(db_session, ci_commit, data)
    except Exception as e:
      db_session.rollback()
      print(f"WARNING: could not save the metrics definitions of a run of {hexsha}: {e}")
  return jsonify(output.to_dict())




