"""
Admin → Storage → Storage locations: where projects' uploaded runs go (backend/locations.py).
Admins change the locations; where the server may write at all, the storage roots, stays in its environment.
"""
from flask import request, jsonify

from backend import app, db_session
from .. import config, locations
from ..locations import LocationError
from .auth import admin_required


STATUS = {'not_found': 404, 'exists': 409, 'has_runs': 409}


def refused(e: LocationError):
  return jsonify({"error": str(e), "reason": e.reason}), STATUS.get(e.reason, 400)


def answer():
  from ..models import StorageLocation
  rows = StorageLocation.query.order_by(StorageLocation.url).all()
  default = locations.default()
  return {
    "locations": [locations.serialize(row, runs=locations.runs_in(row.url)) for row in rows],
    # the projects no location lists upload there: QABOARD_UPLOAD_ROOT, or the default storage
    "default": {"path": str(default.path), "reachable": default.path.is_dir()} if default else None,
    "default_off_reason": None if default else config.upload_off_reason,
    "storage_roots": [str(root) for root in config.storage_roots],
  }


def row_by_id(location_id):
  from ..models import StorageLocation
  return StorageLocation.query.filter(StorageLocation.id == location_id).one_or_none()


@app.route('/api/v1/admin/storage-locations', methods=['GET'])
@app.route('/api/v1/admin/storage-locations/', methods=['GET'])
@admin_required
def admin_storage_locations():
  return jsonify(answer())


@app.route('/api/v1/admin/storage-locations', methods=['POST'])
@app.route('/api/v1/admin/storage-locations/', methods=['POST'])
@admin_required
def admin_add_storage_location():
  body = request.get_json(silent=True) or {}
  try:
    row = locations.add(body.get('url'), body.get('path'), body.get('projects') or [], check=body.get('check', True) is not False)
  except LocationError as e:
    db_session.rollback()
    return refused(e)
  db_session.commit()
  return jsonify(locations.serialize(row, runs=0)), 201


@app.route('/api/v1/admin/storage-locations/<int:location_id>', methods=['POST', 'DELETE'])
@app.route('/api/v1/admin/storage-locations/<int:location_id>/', methods=['POST', 'DELETE'])
@admin_required
def admin_change_storage_location(location_id):
  row = row_by_id(location_id)
  if row is None:
    return jsonify({"error": "This storage location doesn't exist.", "reason": "not_found"}), 404
  try:
    if request.method == 'DELETE':
      runs = locations.remove(row.url, force=request.args.get('force') in ('1', 'true'))
      db_session.commit()
      return jsonify({"status": "OK", "runs": runs})
    body = request.get_json(silent=True) or {}
    # the url is what runs store: never changed, a new location is added instead
    if 'url' in body and body['url'] != row.url:
      return jsonify({"error": "Runs store the location's URL: it can't change. Add another location instead.", "reason": "invalid"}), 400
    row, _ = locations.update(row.url, path=body.get('path'), projects=body.get('projects'), check=body.get('check', True) is not False)
  except LocationError as e:
    db_session.rollback()
    return refused(e)
  db_session.commit()
  return jsonify(locations.serialize(row, runs=locations.runs_in(row.url)))
