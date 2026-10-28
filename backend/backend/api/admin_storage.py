"""
Admin > Storage > Scans: explore what scans found on disk (backend/jobs/scan.py), like ncdu, and act on it: delete
what QA-Board doesn't use, track exports, add untracked runs back. Scans are started like other jobs (kind scan_storage).
"""
from flask import request, jsonify, g
from sqlalchemy import or_

from backend import app, db_session
from ..models import StorageScan, StorageScanEntry, Export, Job
from ..audit import audit
from .. import accounts
from ..jobs import queue
from ..jobs.params import ParamsError
from ..jobs.scan import UNTRACKED
from ..jobs.storage_actions import deletable
from ..exports import serialize as serialize_export
from .auth import admin_required


def iso(date):
  return f"{date.isoformat()}Z" if date else None


def serialize_scan(scan: StorageScan, job=None) -> dict:
  totals = scan.totals or {}
  by_kind = totals.get('by_kind') or {}
  return {
    "id": scan.id,
    "job_id": scan.job_id,
    "job": queue.serialize_job(job) if job else None,
    "roots": scan.roots or [],
    "status": scan.status,
    "created_at": iso(scan.created_at),
    "finished_at": iso(scan.finished_at),
    "min_bytes": scan.min_bytes,
    "bytes": totals.get('bytes', 0),
    "files": totals.get('files', 0),
    "errors": totals.get('errors', 0),
    "by_kind": by_kind,
    "untracked_bytes": sum(size for kind, size in by_kind.items() if kind in UNTRACKED),
  }


def serialize_entry(entry: StorageScanEntry) -> dict:
  return {
    "path": entry.path,
    "parent": entry.parent,
    "name": entry.name,
    "depth": entry.depth,
    "is_dir": entry.is_dir,
    "kind": entry.kind,
    "bytes": entry.bytes,
    "files": entry.files,
    "newest_mtime": iso(entry.newest_mtime),
    # scans before the accounts were known saved "uid 2041"
    "owners": accounts.resolve_keys(entry.owners),
    "owner": accounts.resolve(entry.owner),
    "kinds": entry.kinds or {},
    "ref": entry.ref or {},
    "small": entry.small or {},
    "action": entry.action,
    "deletable": deletable(entry),
  }


def get_scan_or_404(scan_id):
  scan = db_session.get(StorageScan, scan_id)
  if scan is None:
    return None, (jsonify({"error": "This scan doesn't exist."}), 404)
  return scan, None


def scan_job_status(scan):
  """A scan whose job stopped (crashed, cancelled) says so"""
  job = db_session.get(Job, scan.job_id) if scan.job_id else None
  if job and scan.status == 'running' and job.status in ('failed', 'cancelled'):
    scan.status = job.status
  return job


@app.route('/api/v1/admin/scans', methods=['GET'])
@app.route('/api/v1/admin/scans/', methods=['GET'])
@admin_required
def admin_scans():
  scans = StorageScan.query.order_by(StorageScan.id.desc()).limit(50).all()
  return jsonify({"scans": [serialize_scan(s, scan_job_status(s)) for s in scans]})


@app.route('/api/v1/admin/scans/<int:scan_id>', methods=['GET'])
@app.route('/api/v1/admin/scans/<int:scan_id>/', methods=['GET'])
@admin_required
def admin_scan(scan_id):
  scan, error = get_scan_or_404(scan_id)
  if error:
    return error
  job = scan_job_status(scan)
  by_owner = accounts.resolve_keys((scan.totals or {}).get('by_owner'))
  owners = sorted(({
    "owner": name, "bytes": sum(kinds.values()),
    "untracked_bytes": sum(size for kind, size in kinds.items() if kind in UNTRACKED), "kinds": kinds,
  } for name, kinds in by_owner.items()), key=lambda o: -o['untracked_bytes'])
  return jsonify({**serialize_scan(scan, job), "owners": owners[:200]})


ENTRY_SORTS = {
  'size': StorageScanEntry.bytes.desc(),
  'oldest': StorageScanEntry.newest_mtime.asc().nullsfirst(),
  'newest': StorageScanEntry.newest_mtime.desc().nullslast(),
  'name': StorageScanEntry.name.asc(),
}


@app.route('/api/v1/admin/scans/<int:scan_id>/entries', methods=['GET'])
@app.route('/api/v1/admin/scans/<int:scan_id>/entries/', methods=['GET'])
@admin_required
def admin_scan_entries(scan_id):
  """
  `parent`: a folder's entries, like ncdu (none: the scanned roots). `flat=true`: all the entries of `kind`, e.g. the
  biggest untracked runs anywhere. Filter by `owner`, sort by size, oldest, newest or name.
  """
  scan, error = get_scan_or_404(scan_id)
  if error:
    return error
  query = StorageScanEntry.query.filter(StorageScanEntry.scan_id == scan_id)
  parent = request.args.get('parent')
  current = None
  if request.args.get('flat') in ('1', 'true'):
    kinds = [k for k in (request.args.get('kind') or ','.join(sorted(UNTRACKED))).split(',') if k]
    query = query.filter(StorageScanEntry.kind.in_(kinds))
    if parent:
      query = query.filter(or_(StorageScanEntry.path.like(parent.rstrip('/') + '/%')))
  elif parent:
    current = db_session.get(StorageScanEntry, (scan_id, parent))
    query = query.filter(StorageScanEntry.parent == parent)
    if request.args.get('kind'):
      query = query.filter(StorageScanEntry.kind.in_(request.args['kind'].split(',')))
  else:
    query = query.filter(StorageScanEntry.depth == 0)
  if request.args.get('owner'):
    query = query.filter(StorageScanEntry.owner.in_(accounts.aliases(request.args['owner'])))
  try:
    limit = max(1, min(int(request.args.get('limit', 200)), 1000))
    offset = max(0, int(request.args.get('offset', 0)))
  except ValueError:
    raise ParamsError("`limit` and `offset` must be numbers")
  total = query.count()
  entries = query.order_by(ENTRY_SORTS.get(request.args.get('sort') or 'size', ENTRY_SORTS['size'])).offset(offset).limit(limit).all()
  return jsonify({
    "entries": [serialize_entry(e) for e in entries],
    "total": total,
    "current": serialize_entry(current) if current else None,
  })


def body_paths(scan_id):
  data = request.get_json(silent=True) or {}
  paths = data.get('paths')
  if not isinstance(paths, list) or not paths or not all(isinstance(p, str) for p in paths):
    raise ParamsError("Select what to act on: `paths`")
  entries = StorageScanEntry.query.filter(StorageScanEntry.scan_id == scan_id, StorageScanEntry.path.in_(paths)).all()
  if len(entries) != len(set(paths)):
    raise ParamsError("Some paths aren't in this scan")
  return entries


@app.route('/api/v1/admin/scans/<int:scan_id>/delete', methods=['POST'])
@app.route('/api/v1/admin/scans/<int:scan_id>/delete/', methods=['POST'])
@admin_required
def admin_scan_delete(scan_id):
  """Deletes folders and files that QA-Board doesn't use, in the background"""
  scan, error = get_scan_or_404(scan_id)
  if error:
    return error
  entries = body_paths(scan_id)
  refused = [e.path for e in entries if not deletable(e)]
  if refused:
    return jsonify({"error": f"QA-Board uses files in {refused[0]}{f' and {len(refused) - 1} more' if len(refused) > 1 else ''}: delete runs, batches and artifacts from their pages, or with the other jobs.", "refused": refused[:50]}), 400
  size = sum(e.bytes or 0 for e in entries)
  job = queue.create('delete_paths', {
    "scan_id": scan_id, "paths": [e.path for e in entries], "requested_by": g.user['user_name'],
    "description": f"Delete {len(entries)} folders and files found by scan #{scan_id} ({_human(size)})",
  }, user=g.actor.user)
  audit('storage.delete_paths', 'job', job.id, job.params['description'], meta={"scan_id": scan_id, "paths": [e.path for e in entries][:50], "bytes": size})
  db_session.commit()
  return jsonify({"job": queue.serialize_job(job)}), 201


@app.route('/api/v1/admin/scans/<int:scan_id>/track-exports', methods=['POST'])
@app.route('/api/v1/admin/scans/<int:scan_id>/track-exports/', methods=['POST'])
@admin_required
def admin_scan_track_exports(scan_id):
  """The untracked exports are tracked: their owners see them in Storage usage > Exports, and can delete them"""
  scan, error = get_scan_or_404(scan_id)
  if error:
    return error
  entries = body_paths(scan_id)
  tracked = []
  for entry in entries:
    if entry.kind != 'untracked_export':
      continue
    export = Export.query.filter(Export.path == entry.path).one_or_none()
    if export is None:
      export = Export(path=entry.path, owner=accounts.resolve(entry.owner), source='scan', created_at=entry.newest_mtime or queue.utcnow(),
                      updated_at=entry.newest_mtime or queue.utcnow(), bytes=entry.bytes, files=entry.files,
                      measured_at=scan.finished_at or queue.utcnow(), data={"scan_id": scan_id})
      db_session.add(export)
      db_session.flush()
    export.deleted_at = None
    entry.kind, entry.action = 'export', 'tracked'
    entry.ref = {**(entry.ref or {}), "export_id": export.id}
    tracked.append(export)
  audit('storage.track_exports', 'scan', scan_id, f"scan #{scan_id}", meta={"exports": len(tracked)})
  db_session.commit()
  return jsonify({"exports": [serialize_export(e) for e in tracked]})


@app.route('/api/v1/admin/scans/<int:scan_id>/import-runs', methods=['POST'])
@app.route('/api/v1/admin/scans/<int:scan_id>/import-runs/', methods=['POST'])
@admin_required
def admin_scan_import_runs(scan_id):
  scan, error = get_scan_or_404(scan_id)
  if error:
    return error
  entries = [e for e in body_paths(scan_id) if e.kind == 'untracked_run']
  if not entries:
    raise ParamsError("Select untracked runs")
  job = queue.create('import_runs', {"scan_id": scan_id, "paths": [e.path for e in entries], "requested_by": g.user['user_name']}, user=g.actor.user)
  audit('storage.import_runs', 'job', job.id, job.kind, meta={"scan_id": scan_id, "runs": len(entries)})
  db_session.commit()
  return jsonify({"job": queue.serialize_job(job)}), 201


@app.route('/api/v1/admin/scans/<int:scan_id>', methods=['DELETE'])
@app.route('/api/v1/admin/scans/<int:scan_id>/', methods=['DELETE'])
@admin_required
def admin_delete_scan(scan_id):
  """What a scan found is deleted, not the files: when it's outdated, or the scan failed"""
  scan, error = get_scan_or_404(scan_id)
  if error:
    return error
  job = db_session.get(Job, scan.job_id) if scan.job_id else None
  if job is not None and job.status in queue.ACTIVE:
    return jsonify({"error": f"Scan #{scan_id} is {job.status}: cancel its job first."}), 400
  audit('storage.delete_scan', 'scan', scan_id, f"scan #{scan_id}", meta={"roots": (scan.roots or [])[:20], "status": scan.status})
  db_session.delete(scan)
  db_session.commit()
  return jsonify({"deleted": scan_id})


def _human(size) -> str:
  for unit in ('B', 'KB', 'MB', 'GB', 'TB', 'PB'):
    if size < 1000 or unit == 'PB':
      return f"{size:.1f} {unit}"
    size /= 1000
