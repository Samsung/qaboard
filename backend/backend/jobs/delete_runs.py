"""
Deletes the files of runs users chose in "Storage usage", like deleting runs in the web app: the runs stay listed,
as deleted (soft delete). Only:
- the runs of `owner`, unless an admin chose everyone's (owner None),
- runs that are not running,
- outside milestones (batches saved as milestones),
- if `folder` is set, the runs in that folder.
Errors don't stop the job: the run is kept, and the error is listed with the file and its owner.
"""
from pathlib import Path

from sqlalchemy import func

from ..database import db_session
from ..models import Batch, Output, Project
from .. import storage_usage
from . import params as p
from .common import quiet
from .report import Reporter


PARAMS = ('batch_ids', 'owner', 'folder', 'description', 'dry_run')
MAX_BATCHES = 100_000
# users' deletions run in the worker's interactive lane: they don't wait for long maintenance jobs
INTERACTIVE = True
# several users can delete at the same time
CONCURRENT = True


def validate(params: dict) -> dict:
  p.known_keys(params, PARAMS)
  batch_ids = params.get('batch_ids')
  if not isinstance(batch_ids, list) or not batch_ids or not all(isinstance(i, int) for i in batch_ids):
    raise p.ParamsError("`batch_ids` must be a list of batch ids")
  if len(batch_ids) > MAX_BATCHES:
    raise p.ParamsError(f"At most {MAX_BATCHES} batches at once")
  owner = params.get('owner')
  if owner is not None and not isinstance(owner, str):
    raise p.ParamsError("`owner` must be a user name")
  folder = params.get('folder')
  try:
    folder = storage_usage.normalize_folder(folder)
  except ValueError as e:
    raise p.ParamsError(str(e))
  description = params.get('description')
  return {
    "batch_ids": batch_ids,
    "owner": owner,
    "folder": folder,
    "description": str(description)[:300] if description else None,
    "dry_run": p.boolean(params.get('dry_run'), 'dry_run'),
  }


def describe(params: dict) -> str:
  whose = f"{params['owner']}'s runs" if params.get('owner') is not None else "the runs"
  what = params.get('description') or f"{len(params['batch_ids'])} batch{'es' if len(params['batch_ids']) > 1 else ''}"
  where = f", in {params['folder']}" if params.get('folder') else ''
  return f"Delete the files of {whose}: {what}{where}"


def in_folder(path: Path, folder: str) -> bool:
  return str(path) == folder or str(path).startswith(folder.rstrip('/') + '/')


def run(params: dict, report: Reporter):
  owner, folder, dry_run = params['owner'], params['folder'], params['dry_run']
  done = set(report.progress.get('batches_finished') or [])
  ids = [i for i in params['batch_ids'] if i not in done]
  report.set(batches_total=len(params['batch_ids']))
  milestones = {}  # project => MilestoneBatches
  for batch_id in ids:
    if report.should_stop():
      return
    batch = db_session.get(Batch, batch_id)
    if batch is None:
      done.add(batch_id)
      continue
    commit = batch.ci_commit
    project_id = commit.project_id
    if project_id not in milestones:
      milestones[project_id] = db_session.get(Project, project_id).milestone_batches
    runs = (db_session.query(Output).filter(Output.batch_id == batch_id, Output.deleted.isnot(True)))
    if owner is not None:
      runs = runs.filter(func.coalesce(Output.data['user'].as_string(), '') == owner)
    runs = runs.all()
    context = {"project_id": project_id, "batch_id": batch_id}
    if batch.label in milestones[project_id].of_commit(project_id, commit.hexsha):
      report.add(runs_kept_milestones=len(runs), batches_kept_milestones=1)
      done.add(batch_id)
      continue
    deleted = 0
    for output in runs:
      if output.is_pending:
        report.add(runs_kept_running=1)
        continue
      size = output.data.get('storage') if isinstance(output.data, dict) else None
      size = size if isinstance(size, (int, float)) else 0
      if folder:
        try:
          if not in_folder(output.output_dir, folder):
            report.add(runs_kept_outside_folder=1)
            continue
        except Exception as e:
          report.error('other', f"Could not find the folder of run {output.id}: {e}", output_id=output.id, **context)
          report.add(runs_failed=1)
          continue
      if dry_run:
        report.add(runs_deleted=1, bytes_deleted=size)
        continue
      try:
        with quiet():
          output.delete(soft=True)
        output.deleted = True
        deleted += 1
        report.add(runs_deleted=1, bytes_deleted=size)
      except Exception as e:
        report.exception(e, path=output.output_dir_override, output_id=output.id, **context)
        report.add(runs_failed=1)
        try:
          with quiet():
            output.update_manifest()
        except Exception:
          pass
    if not dry_run:
      db_session.commit()
      if deleted:
        storage_usage.refresh_batches([batch_id])
    done.add(batch_id)
    report.set(batches_finished=sorted(done), batches_done=len(done))
    db_session.expunge_all()
