import json

from flask import request, jsonify
from sqlalchemy.orm.attributes import flag_modified

from backend import app, db_session
from ..models import CiCommit, Batch




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

      for b in ci_commit.batches:
        if b.label.startswith(f"{data['batch_label']}|iter") and b.label != batch_data['last_iteration_label']:
          print(f'Deleting previous iteration {b.label}')
          if b.label != batch_data['last_iteration_label']:
            db_session.delete(b)

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
  success = batch.redo(
    only_failed=data.get('only_failed', False),
    only_deleted=data.get('only_deleted', False),
  )
  if success:
    return '{"status": "OK"}'
  else:
    return jsonify({"status": "Some runs failed to start. Check the 'redo.log' files in the output directories to know more."}), 500

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


