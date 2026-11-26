"""
Admin → Storage → Data folders: folders QA-Board reads but never changes, e.g. datasets (backend/data_folders.py).
"""
from flask import request, jsonify, g

from backend import app, db_session
from .. import config, data_folders, settings
from ..data_folders import DataFolderError
from .auth import admin_required


STATUS = {'not_found': 404, 'exists': 409}


def refused(e: DataFolderError):
  return jsonify({"error": str(e), "reason": e.reason}), STATUS.get(e.reason, 400)


def answer():
  return {
    "data_folders": [data_folders.serialize(path) for path in data_folders.paths()],
    # also readable, set in the server's environment
    "storage_roots": [str(root) for root in config.storage_roots],
  }


@app.route('/api/v1/admin/data-folders', methods=['GET'])
@app.route('/api/v1/admin/data-folders/', methods=['GET'])
@admin_required
def admin_data_folders():
  return jsonify(answer())


@app.route('/api/v1/admin/data-folders', methods=['POST'])
@app.route('/api/v1/admin/data-folders/', methods=['POST'])
@admin_required
def admin_add_data_folder():
  """{"path": "/mnt/nas/datasets", "check": true}"""
  body = request.get_json(silent=True) or {}
  try:
    path = data_folders.add(body.get('path'), check=body.get('check', True) is not False, by=g.actor.user)
  except DataFolderError as e:
    db_session.rollback()
    return refused(e)
  except ValueError as e:  # the setting's own checks
    db_session.rollback()
    return jsonify({"error": str(e), "reason": "invalid"}), 400
  db_session.commit()
  settings.invalidate_cache()
  return jsonify(data_folders.serialize(path)), 201


@app.route('/api/v1/admin/data-folders', methods=['DELETE'])
@app.route('/api/v1/admin/data-folders/', methods=['DELETE'])
@admin_required
def admin_remove_data_folder():
  """?path=/mnt/nas/datasets. The files stay: QA-Board only stops reading them"""
  try:
    path = data_folders.remove(request.args.get('path'), by=g.actor.user)
  except DataFolderError as e:
    db_session.rollback()
    return refused(e)
  db_session.commit()
  settings.invalidate_cache()
  return jsonify({"status": "OK", "path": path})
