import datetime
import json
import math
import re
import time
from pathlib import Path
from urllib.parse import unquote

from typing import Optional

from flask import request, jsonify, make_response, g
from sqlalchemy.orm.attributes import flag_modified
from sqlalchemy.orm.exc import NoResultFound

from qaboard.conventions import deserialize_config, Reason
from qaboard.utils import outputs_manifest

from backend import app, db_session
from ..models import TestInput, CiCommit, Output
from ..origins import run_origin, run_user, claim_batch
from ..storage import check_storage_path, UnsafePathError
from .. import heartbeats, local_changes, locations, uploads, tokens
from ..metrics_definitions import MAX_KEY_LENGTH, FORBIDDEN_KEYS
from ..redo import redo_response
from ..metrics_definitions import save_metrics_definitions
from ..notifications.batches import on_run_ended
from ..tokens import end_batch_token
from ..attempts import record_attempt
from ..input_catalog import record_run_in_savepoint
from ..access import invalid_project
from ..audit import audit, capped, diff
from .auth import login_required, is_authorized_user, ingest_access, forbidden_project, require_project_access
from ..actor import batch_token_limits, output_batch_token_limits, batch_token_refused, is_batch_request, unauthenticated

# Keys of a run's data that only the server sets
# - optimization_best allows `qa optimize` to replace this run (see api/batch.py)
# - submitted_by is who really sent it (api/auth.py:ingest_access)
# - added_metrics records the metrics scripts added after the run (add_output_metrics)
# - attempt and previous_attempts say how many times the run was done (backend/attempts.py)
# - uploads_files says that the run sends us its files, in a folder we chose (backend/uploads.py)
SERVER_KEYS = {'optimization_best', 'submitted_by', 'added_metrics', 'attempt', 'previous_attempts', 'uploads_files', 'heartbeat', 'silent_since'}
# Metrics that only the run itself sets
RUN_ONLY_METRICS = {'is_failed', 'compute_time'}
# What scripts can say about themselves when they add metrics
SOURCE_KEYS = ('script', 'script_sha256', 'qaboard_version', 'note')
# At most that many metrics added per request, and their text values' length: they're parsed by every view of the batch
MAX_ADDED_METRICS = 500
MAX_ADDED_TEXT = 500
# What a running run reports (report_output_progress): its metrics so far, its parameters and what it uses of its
# machine (qaboard/system_metrics.py: a summary of a few hundred bytes, more with many GPUs), as JSON
MAX_PROGRESS_METRICS = 2000
MAX_PROGRESS_PARAMS_SIZE = 100_000
MAX_RESOURCES_SIZE = 20_000


def checked_resources(resources) -> Optional[dict]:
  """
  What a run says it uses of its machine (qaboard/system_metrics.py), if it looks like it: an object, small enough
  to send with every run of a batch. Else None: we ignore it rather than refuse the report, heartbeats included.
  """
  if not isinstance(resources, dict):
    return None
  try:
    return resources if len(json.dumps(resources)) <= MAX_RESOURCES_SIZE else None
  except (TypeError, ValueError):
    return None


def update_run_data(output, data: dict) -> None:
  """Saves what a run says in `data`, but what only the server sets. Ignores a `resources` that doesn't look like one"""
  kept = {k: v for k, v in data.items() if k not in SERVER_KEYS}
  if 'resources' in kept and checked_resources(kept['resources']) is None:
    del kept['resources']
  # as much as the server allows of how the run's code differs from its commit (backend/local_changes.py)
  local_changes.allowed_data(kept)
  # a run started without a collection says so with nulls (qaboard/payloads.py RUN_DATA_FIELDS): it forgets the one of before
  for key in ('collection', 'collection_version', 'collection_id'):
    if key in kept and kept[key] is None:
      del kept[key]
      output.data.pop(key, None)
  output.data.update(kept)
  # an older `qa` lists the earlier attempts' logs without their runners': what a newer one listed is stale
  if 'attempt_logs' in kept and 'attempt_log_files' not in kept:
    output.data.pop('attempt_log_files', None)


def all_project_ids() -> list:
  from ..models import Project
  return [row[0] for row in Project.query.with_entities(Project.id)]


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


def invalid_added_metrics(metrics, max_metrics=MAX_ADDED_METRICS, allow_empty=False) -> Optional[str]:
  """Why scripts can't add these metrics: values must be finite numbers, booleans, short texts or null, with sane keys."""
  if not isinstance(metrics, dict):
    return '`metrics` must be an object: {"metrics": {"sharpness": 0.4}}'
  if not metrics and not allow_empty:
    return '`metrics` must be an object with at least one metric: {"metrics": {"sharpness": 0.4}}'
  if len(metrics) > max_metrics:
    return f"at most {max_metrics} metrics per request"
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


@app.route("/api/v1/output/<int:output_id>", methods=['GET'])
@app.route("/api/v1/output/<int:output_id>/", methods=['GET'])
def get_output(output_id):
  try:
    output = Output.query.filter(Output.id==output_id).one()
  except NoResultFound:
    return jsonify({"error": f"Cannot find output {output_id}"}), 404
  if not is_authorized_user(None, output.batch.ci_commit.project_id):
    return forbidden_project(output.batch.ci_commit.project_id)
  return jsonify(output.to_dict())


def run_label(output) -> str:
  """How people recognize a run: its input, and its configuration"""
  input_path = str(output.test_input.path) if output.test_input is not None else f"run {output.id}"
  configurations = output.configurations if isinstance(output.configurations, list) else []
  # configurations can be objects: only their names
  names = [c for c in configurations if isinstance(c, str)]
  return capped(f"{input_path} ({', '.join(names)})" if names else input_path)


def run_meta(output) -> dict:
  batch, ci_commit = output.batch, output.batch.ci_commit
  return capped({
    "commit": ci_commit.hexsha,
    "batch": batch.label,
    "batch_id": batch.id,
    "input": str(output.test_input.path) if output.test_input is not None else None,
    "database": str(output.test_input.database) if output.test_input is not None else None,
    "platform": output.platform,
    "configurations": output.configurations,
    "extra_parameters": output.extra_parameters,
  }, items=20)


# What run.update events say changed
AUDITED_STATUS = ('is_failed', 'is_pending', 'is_running')

def run_state(output) -> dict:
  # copies: updates change output.data in place
  return {
    **{k: getattr(output, k) for k in AUDITED_STATUS},
    "metrics": dict(output.metrics or {}),
    "data": dict(output.data or {}),
  }


def run_changes(before: dict, after: dict) -> dict:
  """{field: {from, to}} for the statuses that changed, and {metrics|data: {key: {from, to}}} for the keys that did"""
  changes = diff({k: before[k] for k in AUDITED_STATUS}, {k: after[k] for k in AUDITED_STATUS})
  for field in ('metrics', 'data'):
    changed = diff(before[field], after[field])
    if changed:
      changes[field] = capped(changed)
  return changes


# Only the web app changes or deletes outputs, the CLI uses POST /api/v1/output/
# Deleting removes the output's folder, which comes from unauthenticated API calls
@app.route("/api/v1/output/<int:output_id>", methods=['PUT', 'DELETE'])
@app.route("/api/v1/output/<int:output_id>/", methods=['PUT', 'DELETE'])
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
    # editing results is tampering with them: the audit log says who changed what
    before = run_state(output)
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
      update_run_data(output, data['data'])
      flag_modified(output, "data")
    if data.get('batch'):
      output.data["batch"] = data["batch"]
      flag_modified(output, "data")
    if 'metrics' in data:
      output.metrics = {**output.metrics,  **data['metrics']}
      flag_modified(output, "metrics")
    if changes := run_changes(before, run_state(output)):
      audit('run.update', 'run', output.id, run_label(output), project_id=output.batch.ci_commit.project_id, changes=changes, meta=run_meta(output))
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
    audit('run.delete', 'run', output.id, run_label(output), project_id=output.batch.ci_commit.project_id, meta={**run_meta(output), "soft": soft})
    if not soft:
      db_session.delete(output)
    # soft deletes mark the run as deleted
    db_session.commit()
    from ..storage_usage import refresh_soon
    refresh_soon([batch_id])
    return {"status": "OK"}


@app.route("/api/v1/output/<int:output_id>/metrics", methods=['PATCH'])
@app.route("/api/v1/output/<int:output_id>/metrics/", methods=['PATCH'])
def add_output_metrics(output_id):
  """
  Adds metrics to a finished run, from a script (`run.log()` in the Python SDK): they are merged into the run's metrics,
  and QA-Board remembers who added each one, when and with which script (output.data.added_metrics). The run's own
  metrics.json is not changed, and nothing is written to the storage. Needs a token with the ingest scope and the
  developer role, whatever ingest.auth says: unlike `qa`'s results, this has no legacy anonymous clients.
  """
  project_id = None
  try:
    # only the run's row: Output.test_input is loaded with an outer join, which PostgreSQL can't lock
    output = Output.query.filter(Output.id==output_id).with_for_update(of=Output).one()
    # the session may hold the run from the access check above: read it again, now that it's locked
    db_session.refresh(output)
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
  if refused := output_batch_token_limits(output, what="add metrics to this run"):
    return refused
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
    return jsonify({"error": f"The run itself returned {', '.join(owned)}: pass overwrite=True to replace its values", "reason": Reason.METRICS_EXIST, "metrics": owned}), 409

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


@app.route("/api/v1/output/<int:output_id>/progress", methods=['PATCH'])
@app.route("/api/v1/output/<int:output_id>/progress/", methods=['PATCH'])
def report_output_progress(output_id):
  """
  What a running run looks like so far: its metrics, the parameters it reported, and what it uses of its machine
  (`resources`, also sent with heartbeats). Runs started from code
  (`qaboard.start_run()`) send it every few seconds while they log, so that the web app shows them before they end.
  It replaces what the run said before: the run sends everything each time, nothing has to arrive in order.
  Only for runs that are running: when a run ends, POST /api/v1/output/ says its final metrics, as always.
  Same access as the results `qa` sends (ingest.auth). Much lighter than POST /api/v1/output/: no commit, batch or
  configuration to find or update.
  """
  project_id, found = None, None
  try:
    found = Output.query.filter(Output.id==output_id).one()
    project_id = found.batch.ci_commit.project_id
  except NoResultFound:
    pass
  # who can't see the project doesn't learn whether the run exists
  if project_id is None or not is_authorized_user(None, project_id):
    if project_id is not None:
      return forbidden_project(project_id)
    return jsonify({"error": f"Cannot find output {output_id}"}), 404
  submitted_by, error = ingest_access(project_id)
  if error:
    return error
  if refused := output_batch_token_limits(found, what="report the progress of this run"):
    return refused
  data = request.get_json(silent=True) or {}
  metrics = data.get('metrics', {})
  if problem := invalid_added_metrics(metrics, max_metrics=MAX_PROGRESS_METRICS, allow_empty=True):
    return jsonify({"error": problem}), 400
  params = data.get('params')
  if params is not None and (not isinstance(params, dict) or len(json.dumps(params)) > MAX_PROGRESS_PARAMS_SIZE):
    return jsonify({"error": f"`params` must be an object, of at most {MAX_PROGRESS_PARAMS_SIZE} characters as JSON"}), 400
  # heartbeats carry it: an odd one is ignored, a refused heartbeat would fail the run once it's silent
  resources = checked_resources(data.get('resources'))
  # only now the lock: callers we refuse don't hold up the run's own updates
  try:
    # only the run's row: Output.test_input is loaded with an outer join, which PostgreSQL can't lock
    output = Output.query.filter(Output.id==output_id).with_for_update(of=Output).one()
    # the session may hold the run from the access check above: read it again, now that it's locked
    db_session.refresh(output)
  except NoResultFound:
    return jsonify({"error": f"Cannot find output {output_id}"}), 404
  # a run we failed because it was silent is running again (backend/heartbeats.py)
  if not (output.is_pending and output.is_running) and 'silent_since' not in (output.data or {}):
    return jsonify({"error": "The run isn't running: only running runs report their progress", "reason": Reason.NOT_RUNNING}), 409
  heartbeats.reported(output)

  # the metrics scripts added to a previous attempt stay, unless the run now logs them.
  # Heartbeats (backend/heartbeats.py) say no metrics: they change nothing
  if 'metrics' in data:
    output.metrics = with_added_metrics(output, metrics, current_data(output))
    flag_modified(output, "metrics")
  if params is not None:
    if not output.data:
      output.data = {}
    output.data['params'] = params
    flag_modified(output, "data")
  # heartbeats say it too: a run that is killed said what it used until then
  if resources is not None:
    if not output.data:
      output.data = {}
    output.data['resources'] = resources
    flag_modified(output, "data")
  db_session.add(output)
  db_session.commit()

  definitions = data.get('metrics_definitions')
  if isinstance(definitions, dict) and definitions:
    ci_commit = output.batch.ci_commit
    definitions = {k: v for k, v in definitions.items() if k in metrics}
    project_data = getattr(ci_commit.project, 'data', None)
    project_config = project_data.get('qatools_config') if isinstance(project_data, dict) else None
    try:
      save_metrics_definitions(db_session, ci_commit, {'metrics_definitions': definitions, 'commit_branch': ci_commit.branch, 'qaboard_config': project_config})
    except Exception as e:
      db_session.rollback()
      print(f"WARNING: could not save the metrics definitions of the running output {output_id}: {e}")
  return jsonify(output.to_dict())


@app.route("/api/v1/uploads/authorize", methods=['PUT'])
def authorize_upload():
  """
  Whether the request may send files: 204 with a token that can send results (or a session), else 401 or 403 with why.
  nginx asks before it receives the body of a file (services/nginx/snippets/qaboard-uploads-auth.conf): who has no
  token can't fill its disk. For runs' files, commits' artifacts and batch logs: their endpoints check the project
  and the role with the file.
  """
  actor = g.get('actor')
  if actor is None or actor.user is None:
    return jsonify({"error": "No token that can send results: run `qa auth login`, or in CI set QABOARD_TOKEN to a token with the ingest scope.", "reason": "login_required"}), 401
  if actor.token is not None and not actor.has_scope('ingest'):
    return jsonify({"error": "This token can't send results: it needs the \"ingest\" scope.", "reason": "missing_scope", "required": "ingest"}), 403
  if tokens.is_batch_token(actor.token) and (refused := batch_token_upload_limits(request.environ.get('QABOARD_ORIGINAL_URI'))):
    return refused
  # nginx passes it on with the file: the endpoints know it asked (uploads.unchecked_by_proxy)
  return '', 204, {uploads.PROXY_CHECKED_HEADER: '1'}


def batch_token_upload_limits(uri: Optional[str]):
  """
  For authorize_upload: None if a batch token may send this file, else the 403. The endpoints check it again with
  the file, this only keeps other batches' files from nginx's disk. nginx says the URL (QABOARD_ORIGINAL_URI).
  """
  # the path as nginx routes it: decoded, with `..` resolved, without the query. A `?` or `#` may be in file names
  path = uri or ''
  if match := re.fullmatch(r'/api/v1/output/(\d+)/files/.+', path, re.DOTALL):
    output = Output.query.filter(Output.id == int(match.group(1))).one_or_none()
    # the endpoint says it doesn't exist
    return output_batch_token_limits(output, what="send files of this run") if output is not None else None
  # (configurations from before nginx sent $uri send the query)
  if match := re.fullmatch(r'/api/v1/batch/submissions/([^/?]+)/log(?:\?.*)?', path, re.DOTALL):
    if tokens.batch_token_for(g.actor, unquote(match.group(1))) is None:
      return batch_token_refused("send the log of another batch")
    return None
  # the commits' artifacts (only `qa save-artifacts` sends them), or a URL nginx didn't say
  return batch_token_refused("send these files")


@app.route("/api/v1/output/<int:output_id>/files/<path:path>", methods=['PUT'])
def upload_output_file(output_id, path):
  """
  Saves a file of a run that doesn't share a storage with the server, in the folder the server chose for it when the
  run started (POST /api/v1/output/ with "storage": "upload"). The request's body is the file.
  - `path` is the file's path in the run's folder. Sending it again replaces it.
  - `?offset=<size>` adds the body at the end of the file instead, for the files runs append to (log.txt): the file
    must have that size, else 409 with its `size`.
  - `X-Content-SHA256`: the body's SHA-256 (hexadecimal). When sent, the server checks what it received.
  Only while the run is pending or running: finished runs don't change.
  Always with a token that can send results to the project, whatever ingest.auth says: the files are served to
  everyone who opens the run.
  """
  if refused := uploads.unchecked_by_proxy(request.environ):
    return jsonify({"error": str(refused), "reason": refused.reason}), refused.status
  output = Output.query.filter(Output.id==output_id).one_or_none()
  project_id = output.batch.ci_commit.project_id if output is not None else None
  # who can't see the project doesn't learn whether the run exists
  if project_id is None or not is_authorized_user(None, project_id):
    if project_id is not None:
      return forbidden_project(project_id)
    return jsonify({"error": f"Cannot find output {output_id}"}), 404
  submitted_by, error = ingest_access(project_id, require_token=True)
  if error:
    return error
  if refused := output_batch_token_limits(output, what="send files of this run"):
    return refused
  if not uploads.enabled(project_id):
    return jsonify({"error": uploads.disabled_message(), "reason": Reason.UPLOADS_DISABLED}), 400
  try:
    offset = int(request.args['offset']) if 'offset' in request.args else None
  except ValueError:
    return jsonify({"error": "?offset= is the file's current size, in bytes"}), 400
  if request.content_length is None:
    return jsonify({"error": "Send the file's size (Content-Length): chunked uploads aren't supported."}), 411

  directory = locations.local_path(output.output_dir_override) if output.output_dir_override else None
  # not any folder the database has: one we chose for a run of this project, that said it uploads
  if not directory or not (output.data or {}).get('uploads_files') or not uploads.is_run_dir(directory, project_id):
    return jsonify({"error": "This run saves its files in a storage shared with the server: it doesn't upload them.", "reason": Reason.NOT_UPLOADED}), 409
  if not output.is_pending:
    return jsonify({"error": "The run has ended: its files don't change anymore.", "reason": Reason.NOT_RUNNING}), 409
  if local_changes.refuses_file(path):
    return jsonify({"error": "This server doesn't keep the code of the runs' local changes (runs.local_changes): only their summary.", "reason": Reason.LOCAL_CHANGES_NOT_ALLOWED}), 422
  started = time.monotonic()
  try:
    size = uploads.save_file(Path(directory), path, request.stream, request.content_length, sha256=request.headers.get('X-Content-SHA256'), offset=offset)
  except uploads.UploadError as e:
    return jsonify({"error": str(e), "reason": e.reason, **e.details}), e.status
  print(f"[uploads] output {output_id}: {path}, {request.content_length} bytes in {time.monotonic() - started:.1f}s", flush=True)
  return jsonify({"path": path, "size": size})


@app.route('/api/v1/output/redo/<int:output_id>', methods=['POST'])
@app.route('/api/v1/output/redo/<int:output_id>/', methods=['POST'])
@login_required
def output_redo(output_id):
  try:
    output = Output.query.filter(Output.id==output_id).one()
  except NoResultFound:
    return jsonify({"error": f"Cannot find output {output_id}"}), 404
  if forbidden := require_project_access(g.user, output.batch.ci_commit.project_id):
    return forbidden
  return redo_response(output.batch, [output], g.user)


@app.route("/api/v1/output/<int:output_id>/manifest", methods=['GET'])
@app.route("/api/v1/output/<int:output_id>/manifest/", methods=['GET'])
def get_output_manifest(output_id):
  try:
    output = Output.query.filter(Output.id==output_id).one()
  except NoResultFound:
    return jsonify({"error": f"Cannot find output {output_id}"}), 404
  if not is_authorized_user(None, output.batch.ci_commit.project_id):
    return forbidden_project(output.batch.ci_commit.project_id)
  refresh = request.args.get('refresh')
  # rewriting it (without hashes) changes the run's files: signed-in users only
  if refresh and (g.get('actor') is None or g.actor.user is None):
    return unauthenticated()
  manifest_path = output.output_dir / "manifest.outputs.json"
  # uploaded runs that ended sent their manifest, with hashes: it stays as they sent it
  uploaded_and_done = (output.data or {}).get('uploads_files') and not output.is_running
  if uploaded_and_done and not manifest_path.exists():
    try:
      check_storage_path(output.output_dir)
    except UnsafePathError as e:
      return jsonify({"error": f"{e}"}), 400
    return jsonify(outputs_manifest(output.output_dir, output.batch.ci_commit.project.data.get('qatools_config', {}), compute_hashes=False))
  if not uploaded_and_done and (output.is_running or refresh or not manifest_path.exists()):
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

  # Runs without a storage shared with us send their files after this request: we choose their folder (backend/uploads.py)
  uploads_files = data.get('storage') == 'upload'
  if uploads_files and not uploads.enabled(str(data.get('project') or '')):
    return jsonify({"error": uploads.disabled_message(), "reason": Reason.UPLOADS_DISABLED}), 400
  if uploads_files and not uploads.supports_project(str(data.get('project'))):
    return jsonify({"error": f"Projects with a folder named \"{uploads.RUNS_FOLDER}\" can't upload their files.", "reason": Reason.UPLOADS_UNSUPPORTED_PROJECT}), 400

  # The server will write, delete and run code in those folders
  output_directory = data.get('output_directory') if not uploads_files else None
  # prefix_output_dir for backward-compatibility
  artifacts_commit = data.get('artifacts_commit', data.get('commit_ci_dir')) if not uploads_files else None
  if not artifacts_commit or not artifacts_commit.startswith('/'): # or "some-protocol://"
    artifacts_commit = None # just ignore...
  try:
    if output_directory:
      check_storage_path(output_directory)
    if artifacts_commit:
      check_storage_path(artifacts_commit)
  except UnsafePathError as e:
    return jsonify({"error": f"{e}"}), 400
  # the folders of uploaded runs are the server's to choose: no client says its results (or artifacts) are there, or
  # above them, else deleting its run would delete them
  for folder in (output_directory, artifacts_commit):
    if folder and uploads.overlaps_uploads(folder, project_ids=all_project_ids):
      return jsonify({"error": f"{folder} is where the server saves the files runs send it: results can't be saved there directly.", "reason": Reason.UPLOADS_FOLDER}), 400

  if error := invalid_project(data.get('project')):
    return error
  # files are always sent with a token, whatever ingest.auth says: say it when the run starts, not at its first file
  submitted_by, error = ingest_access(data.get('project'), require_token=uploads_files)
  if error:
    return error
  if refused := batch_token_limits(data.get('project'), hexsha, data.get('batch_label')):
    return refused
  # its commit exists, and stays as it is: where its artifacts are, its config, the project's...
  from_batch = is_batch_request()

  # We get a handle on the Commit object related to our new output
  try:
    ci_commit = CiCommit.get_or_create(
      session=db_session,
      hexsha=hexsha,
      project_id=data['project'],
      data=data,
      existing_only=from_batch,
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
  # the run is found by what anyone can say about it: without a token, no one replaces a run that sent its files
  if not submitted_by and (output.data or {}).get('uploads_files'):
    db_session.rollback()
    return jsonify({"error": "This run's files were sent to the server with a token: send it with a token too.", "reason": "ingest_token_required"}), 403
  # not saved yet: a new run of the input (input_projects counts them)
  is_new_output = getattr(output, "id", None) is None
  output.output_type = data.get('input_type', '')
  if uploads_files:
    starts = bool(data.get('is_running') and not data.get('keep_previous'))
    current = output.output_dir_override if (output.data or {}).get('uploads_files') else None
    if current and not starts and uploads.is_run_dir(locations.local_path(current), ci_commit.project_id):
      # a run that goes on or ends stays where it sent its files, even if the project's new runs now go elsewhere
      output_directory = current
    else:
      try:
        upload_dir = uploads.run_dir(ci_commit.project_id, ci_commit.hexsha, batch.label, platform, configurations, data['extra_parameters'], test_input_path, database=data['database'])
      except uploads.UploadError as e:
        db_session.rollback()
        return jsonify({"error": str(e), "reason": e.reason}), e.status
      # the run stores its location in full: a URL when it's in a storage location, e.g. s3://... (backend/locations.py)
      output_directory = locations.location_of(upload_dir)
      # The run starts: what its previous attempt uploaded goes, like `qa run` cleans the folder it starts in.
      # Not when `qa batch` only says the run is pending, nor for runs that continue (--keep-previous, resume=True)
      if starts:
        uploads.clean_run_dir(upload_dir, ci_commit.project_id)
  # A run that is done again, in a new directory or in place: we remember the attempt it replaces
  record_attempt(output, output_directory, is_pending=bool(data.get('is_pending') or data.get('is_running')))

  if not output.data:
    output.data = {}
  if "data" in data: # e.g. storage, job_options, batch name
    update_run_data(output, data['data'])
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
  # only runs that asked for it, with a token, send us files (upload_output_file)
  if uploads_files:
    output.data["uploads_files"] = True
  else:
    output.data.pop("uploads_files", None)
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

  if not from_batch:
    ci_commit.commit_dir_override = artifacts_commit
  output.output_dir_override = output_directory

  # We update the output's status
  output.set_status(data.get('is_pending', False), data.get('is_running', False))
  # runs that report at least every few minutes while they run: failed if they stay silent
  heartbeats.started(output, data)

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
  # Which projects used the input, for their Inputs tab, saved with the run: in a savepoint, it never fails the run.
  # Only new runs: the updates of a run (pending, running, done) don't count again.
  if is_new_output:
    record_run_in_savepoint(db_session, test_input.id, ci_commit.project_id, new_output=True)
  db_session.commit()
  if not output.is_pending:
    # maybe the batch's last run: users may want to know
    on_run_ended(db_session, output.data.get('root_command_id'))
    # and its token soon no longer needed (tokens.mint_for_batch)
    end_batch_token(db_session, output.data.get('root_command_id'))
  # The metrics the run's code declared, e.g. qaboard.Metric(12.3, suffix="ms")
  if data.get('metrics_definitions'):
    try:
      save_metrics_definitions(db_session, ci_commit, data, trust_branch=not from_batch)
    except Exception as e:
      db_session.rollback()
      print(f"WARNING: could not save the metrics definitions of a run of {hexsha}: {e}")
  # the most the run may record of its local changes: runs in a storage shared with us don't write more
  return jsonify({**output.to_dict(), "local_changes_level": local_changes.level()})




