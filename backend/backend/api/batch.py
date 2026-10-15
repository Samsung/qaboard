import re

from flask import request, jsonify, g
from sqlalchemy.orm.attributes import flag_modified

from backend import app, db_session
from ..models import CiCommit, Batch
from ..storage import check_storage_path, UnsafePathError
from ..redo import redo_response
from .export_to_folder import filter_outputs
from .auth import login_required, require_project_access




@app.route('/api/v1/batch', methods=['POST'])
@app.route('/api/v1/batch/', methods=['POST'])
def update_batch():
  data = request.get_json()
  # prefix_output_dir for backward-compatibility
  batch_dir = data.get("batch_dir", data.get("prefix_output_dir"))
  if batch_dir:
    # The server will write, delete and run code in this folder
    try:
      check_storage_path(batch_dir)
    except UnsafePathError as e:
      return jsonify({"error": f"{e}"}), 400
  batch_data = data.get('data') or {}
  if batch_data.get('optimization'):
    iteration = batch_data.get('iteration')
    if not isinstance(iteration, int):
      return jsonify({"error": "optimization: `iteration` must be an integer"}), 400
    expected_label = f"{data['batch_label']}|iter{iteration}"
    if batch_data.get('is_best_iter') and batch_data.get('iteration_label') != expected_label:
      return jsonify({"error": f"optimization: `iteration_label` must be {expected_label}"}), 400

  # git_commit_sha for backward-compatibility
  hexsha = data.get('commit_sha') or data.get('git_commit_sha')
  try:
    ci_commit = CiCommit.get_or_create(
      session=db_session,
      hexsha=hexsha,
      project_id=request.json['project'],
      data=data,
    )
  except:
    return f"404 ERROR:\n ({request.json['project']}): There is an issue with your commit id ({hexsha})", 404

  batch = ci_commit.get_or_create_batch(data['batch_label'])
  batch.batch_dir_override = batch_dir

  # Clients can store any metadata in each batch.
  # Currently it's used by `qa optimize` to store info on iterations
  if not batch.data:
    batch.data = {}

  for attr in ("qaboard_config", "qaboard_metrics"):
    if attr in data:
      attr_backward_compat = attr.replace("qaboard", "qatools")
      # the first time we see a commit's data, we'll save it
      # we used to do it when receiving hooks from source control,
      # but it led to huge growth of the ci_commits table in a monorepo
      # with 100s of subprojects each full of config data
      if attr not in ci_commit.data:
        ci_commit.data[attr_backward_compat] = data[attr]
        flag_modified(ci_commit, "data")
        db_session.add(ci_commit)
        db_session.commit()
      # And each batch can have changes vs its commit's config and metrics.
      # The use case is usually working locally with `qa --share` and
      # seeing updated visualizations and metrics.
      if ci_commit.data[attr_backward_compat] != data[attr]:
        batch.data[attr_backward_compat] = data[attr]
        flag_modified(batch, "data")

  batch.data = {**batch.data, **batch_data}

  # Save info on each "qa batch" command in the batch, mainly to list them in logs
  command = request.json.get('command')
  if command:
    batch.data["commands"] = {**batch.data.get('commands', {}), **command}
    flag_modified(batch, "data")

  # It's a `qa optimize` experiment. Like all ingest, this call is unauthenticated (the CLI rarely has a token),
  # so it may only replace the optimization's own results: the best iteration's runs, moved into this batch by
  # earlier calls, and the iteration batches named "<label>|iter<N>". Never other runs.
  if batch_data.get('optimization'):
    optim_prefix = f"{data['batch_label']}|iter"
    iteration = batch_data['iteration']
    if batch_data.get('is_best_iter'):
      iteration_label = batch_data['iteration_label']
      batch.data['best_iter'] = iteration
      flag_modified(batch, "data")
      # we will save the outputs from the best iteration in the batch,
      # so first we need to remove any previous best results
      if not batch_data.get("keep_all_best_iters"):
        for o in batch.outputs:
          if o.output_type != 'optim_iteration' and (o.data or {}).get('optimization_best'):
            print(f"  DELETE {o}")
            o.delete(soft=False)
            db_session.delete(o)
      db_session.add(batch)
      db_session.commit()

      # Move results from the best iteration in this batch
      best_batch = ci_commit.get_or_create_batch(iteration_label)
      for o in best_batch.outputs:
        o.batch = batch
        o.data = {**(o.data or {}), 'optimization_best': iteration_label}
        db_session.add(o)
      db_session.commit()

    # delete past iterations (we can have "future iters when running in parallel")
    # results from the best iter are already in the "main" batch
    for b in ci_commit.batches:
      match = re.fullmatch(re.escape(optim_prefix) + r"(\d+)", b.label)
      if match and int(match.group(1)) <= iteration:
        print(f'Deleting iteration {match.group(1)} in {b.label}')
        b.delete(db_session)
        db_session.delete(b)

  db_session.add(batch)
  db_session.commit()
  return jsonify({"status": "OK", "id": batch.id})



@app.route('/api/v1/batch/stop', methods=['POST'])
@app.route('/api/v1/batch/stop/', methods=['POST'])
@login_required
def stop_batch():
  data = request.get_json()
  try:
    batch = Batch.query.filter(Batch.id == data['id']).one()
  except:
    return f"404 ERROR:\n Not found", 404
  if forbidden := require_project_access(g.user, batch.ci_commit.project_id):
    return forbidden
  status = batch.stop(db_session)
  return jsonify(status), 200 if not "error" in status else 500

@app.route('/api/v1/batch/redo', methods=['POST'])
@app.route('/api/v1/batch/redo/', methods=['POST'])
@login_required
def redo_batch():
  """Redo the batch's runs: all of them, or only those that failed, were deleted, and/or are listed in output_ids."""
  data = request.get_json()
  try:
    batch = Batch.query.filter(Batch.id == data['id']).one()
  except:
    return f"404 ERROR:\n Not found", 404
  if forbidden := require_project_access(g.user, batch.ci_commit.project_id):
    return forbidden
  only_failed = data.get('only_failed', False)
  only_deleted = data.get('only_deleted', False)
  try:
    # the web application sends the runs users see, e.g. those matching a filter
    output_ids = {int(id) for id in data['output_ids']} if data.get('output_ids') is not None else None
  except (TypeError, ValueError):
    return jsonify({"error": "output_ids must be a list of output IDs"}), 400
  outputs = [
    o for o in batch.outputs
    if (not only_failed or o.is_failed) and (not only_deleted or o.deleted) and (output_ids is None or o.id in output_ids)
  ]
  return redo_response(batch, outputs, g.user['user_name'])

@app.route('/api/v1/batch/rename', methods=['POST'])
@app.route('/api/v1/batch/rename/', methods=['POST'])
@login_required
def rename_batch():
  data = request.get_json()
  try:
    batch = Batch.query.filter(Batch.id == data['id']).one()
  except:
    return '{"error":"not found"}', 404
  if forbidden := require_project_access(g.user, batch.ci_commit.project_id):
    return forbidden
  try:
    assert all([b.label != data['label'] for b in batch.ci_commit.batches])
  except:
    return '{"error":"already exists"}', 403
  batch.rename(label=data['label'], db_session=db_session)
  return '{"status": "OK"}'

# Check move: existing, delete if empty, filter

@app.route('/api/v1/batch/move', methods=['POST'])
@app.route('/api/v1/batch/move/', methods=['POST'])
@login_required
def move_batch():
  data = request.get_json()
  try:
    batch = Batch.query.filter(Batch.id == data['id']).one()
  except:
    return f"404 ERROR:\n Not found", 404
  # The runs move to another batch of the same commit, so in the same project
  if forbidden := require_project_access(g.user, batch.ci_commit.project_id):
    return forbidden
  dst_batch = batch.ci_commit.get_or_create_batch(data['label'])
  for o in filter_outputs(data.get('filter'), batch.outputs):
    o.batch = dst_batch
    db_session.add(o)
  if not batch.outputs:
    batch.delete(session=db_session)
  db_session.commit()
  return '{"status": "OK"}'


@app.route('/api/v1/batch/<batch_id>', methods=['DELETE'])
@app.route('/api/v1/batch/<batch_id>/', methods=['DELETE'])
@login_required
def delete_batch(batch_id):
  try:
    batch = Batch.query.filter(Batch.id == batch_id).one()
  except:
    return f"404 ERROR:\nNot found", 404
  if forbidden := require_project_access(g.user, batch.ci_commit.project_id):
    return forbidden
  stop_status = batch.stop(db_session)
  if "error" in stop_status:
    print(stop_status)
    return jsonify(stop_status), 500
  soft = request.args.get('soft') == 'true'
  only_failed = request.args.get('only_failed') == 'true'
  filter = request.args.get('filter')
  batch.delete(session=db_session, soft=soft, only_failed=only_failed, filter=filter)
  return {"status": "OK"}


