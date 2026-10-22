"""
What admins (and users, for what they own) do with what scans found, and with exports:
- delete_paths: deletes folders or files a scan found, that QA-Board doesn't use (untracked runs and exports, what
  deleted runs and artifacts left, other folders without tracked runs inside).
- delete_exports: deletes tracked exports.
- import_runs: adds to QA-Board the untracked runs a scan found in a batch's folder: from their run.json, manifest
  and metrics, like `qa` would have.
They run in the worker's interactive lane: people wait for them.
"""
import json
import datetime
from pathlib import Path

from ..database import db_session
from ..models import Export, Output, TestInput, StorageScanEntry, Batch
from ..storage import check_storage_path
from ..fs_utils import rmtree, rm_empty_parents
from .. import storage_usage, accounts
from . import params as p
from .common import quiet
from .report import Reporter, utcnow
from .scan import DELETABLE


MAX_ITEMS = 10_000


def ids_or_paths(params, key, kind):
  values = params.get(key)
  if not isinstance(values, list) or not values or not all(isinstance(v, kind) for v in values):
    raise p.ParamsError(f"`{key}` must be a non-empty list")
  if len(values) > MAX_ITEMS:
    raise p.ParamsError(f"At most {MAX_ITEMS} at once")
  return values


def deletable(entry: StorageScanEntry) -> bool:
  """Only what QA-Board doesn't use: never a folder with tracked runs, batches' files or artifacts inside"""
  if entry.kind not in DELETABLE:
    return False
  kinds = {k for k, size in (entry.kinds or {}).items() if size}
  return kinds <= DELETABLE | {'untracked_files', 'deleted_run', 'deleted_artifacts', 'untracked_run', 'untracked_export', 'export'}


class DeletePaths:
  INTERACTIVE = True
  CONCURRENT = True
  PARAMS = ('scan_id', 'paths', 'requested_by', 'description')

  @staticmethod
  def validate(params):
    p.known_keys(params, DeletePaths.PARAMS)
    if not isinstance(params.get('scan_id'), int):
      raise p.ParamsError("`scan_id` is required")
    return {"scan_id": params['scan_id'], "paths": ids_or_paths(params, 'paths', str),
            "requested_by": params.get('requested_by'), "description": params.get('description')}

  @staticmethod
  def describe(params):
    return params.get('description') or f"Delete {len(params['paths'])} folders and files found by scan #{params['scan_id']}"

  @staticmethod
  def run(params, report: Reporter):
    done = set(report.progress.get('paths_finished') or [])
    report.set(paths_total=len(params['paths']))
    for path in params['paths']:
      if path in done:
        continue
      if report.should_stop():
        return
      entry = db_session.get(StorageScanEntry, (params['scan_id'], path))
      done.add(path)
      if entry is None or entry.action == 'deleted':
        continue
      if not deletable(entry):
        report.error('other', f"{path} has files QA-Board uses ({', '.join(sorted(entry.kinds or {}))}): it's not deleted", path=path)
        continue
      try:
        check_storage_path(path)
        with quiet():
          rmtree(Path(path))
          rm_empty_parents(Path(path))
      except Exception as e:
        report.exception(e, path=path)
        report.add(paths_failed=1)
        continue
      entry.action = 'deleted'
      report.add(paths_deleted=1, bytes_deleted=entry.bytes or 0)
      ref = entry.ref or {}
      if ref.get('export_id'):
        export = db_session.get(Export, ref['export_id'])
        if export:
          export.deleted_at, export.deleted_by = utcnow(), params.get('requested_by')
      if ref.get('output_id') and entry.kind == 'deleted_run':
        output = db_session.get(Output, ref['output_id'])
        if output:
          output.data = {**(output.data or {}), "storage_left": 0}
          db_session.commit()
          storage_usage.refresh_batches([output.batch_id])
      db_session.commit()
      report.set(paths_finished=sorted(done))


class DeleteExports:
  INTERACTIVE = True
  CONCURRENT = True
  PARAMS = ('export_ids', 'requested_by', 'description')

  @staticmethod
  def validate(params):
    p.known_keys(params, DeleteExports.PARAMS)
    return {"export_ids": ids_or_paths(params, 'export_ids', int), "requested_by": params.get('requested_by'), "description": params.get('description')}

  @staticmethod
  def describe(params):
    return params.get('description') or f"Delete {len(params['export_ids'])} exports"

  @staticmethod
  def run(params, report: Reporter):
    report.set(exports_total=len(params['export_ids']))
    for export_id in params['export_ids']:
      if report.should_stop():
        return
      export = db_session.get(Export, export_id)
      if export is None or export.deleted_at:
        continue
      path = Path(export.path)
      try:
        check_storage_path(path)
        with quiet():
          rmtree(path)
          rm_empty_parents(path)
      except Exception as e:
        report.exception(e, path=path)
        report.add(exports_failed=1)
        continue
      export.deleted_at, export.deleted_by = utcnow(), params.get('requested_by')
      db_session.commit()
      report.add(exports_deleted=1, bytes_deleted=export.bytes or 0, linked_bytes=export.linked_bytes or 0)


def read_json(path: Path):
  try:
    with path.open() as f:
      return json.load(f)
  except Exception:
    return None


class ImportRuns:
  INTERACTIVE = True
  CONCURRENT = True
  PARAMS = ('scan_id', 'paths', 'requested_by')

  @staticmethod
  def validate(params):
    p.known_keys(params, ImportRuns.PARAMS)
    if not isinstance(params.get('scan_id'), int):
      raise p.ParamsError("`scan_id` is required")
    return {"scan_id": params['scan_id'], "paths": ids_or_paths(params, 'paths', str), "requested_by": params.get('requested_by')}

  @staticmethod
  def describe(params):
    return f"Add to QA-Board {len(params['paths'])} runs found by scan #{params['scan_id']}"

  @staticmethod
  def run(params, report: Reporter):
    batch_ids = set()
    for path in params['paths']:
      if report.should_stop():
        break
      entry = db_session.get(StorageScanEntry, (params['scan_id'], path))
      if entry is None or entry.kind != 'untracked_run' or entry.action:
        continue
      batch_id = (entry.ref or {}).get('batch_id')
      if not batch_id or db_session.get(Batch, batch_id) is None:
        report.error('other', f"{path} isn't in a batch's folder: QA-Board can't know its commit", path=path)
        continue
      if Output.query.filter(Output.output_dir_override == path).first():
        entry.action = 'imported'
        continue
      run_info = read_json(Path(path) / 'run.json')
      if not isinstance(run_info, dict) or not run_info.get('input_path'):
        report.error('other', f"{path}/run.json is missing or doesn't say which input it ran on", path=path)
        continue
      manifest = read_json(Path(path) / 'manifest.outputs.json') or {}
      metrics = read_json(Path(path) / 'metrics.json') or {}
      size = sum(f.get('st_size', 0) for f in manifest.values() if isinstance(f, dict)) if isinstance(manifest, dict) else entry.bytes
      database = str(run_info.get('database') or '/')
      test_input = TestInput.query.filter(TestInput.database == database, TestInput.path == str(run_info['input_path'])).one_or_none()
      if test_input is None:
        test_input = TestInput(database, run_info['input_path'])
        db_session.add(test_input)
      output = Output(
        batch_id=batch_id, test_input=test_input, platform=run_info.get('platform') or 'linux',
        configurations=run_info.get('configurations') or [], extra_parameters=run_info.get('extra_parameters') or {},
        output_dir_override=path, is_pending=False, is_running=False,
        is_failed=bool(metrics.get('is_failed')) if isinstance(metrics, dict) else False,
        metrics={k: v for k, v in metrics.items() if v == v} if isinstance(metrics, dict) else {},
        data={"storage": size or entry.bytes, "user": accounts.resolve(entry.owner), "imported": {"at": utcnow().isoformat() + 'Z', "by": params.get('requested_by'), "scan_id": params['scan_id']}},
        created_date=entry.newest_mtime or datetime.datetime.utcnow(),
      )
      db_session.add(output)
      entry.action = 'imported'
      db_session.commit()
      batch_ids.add(batch_id)
      report.add(runs_imported=1, bytes=size or 0)
    storage_usage.refresh_batches(batch_ids)
