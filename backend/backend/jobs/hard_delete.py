"""
Hard-deletes runs: their rows in the database, and what's left of their files. Batches left without runs are deleted
too. Commits are kept. Which runs (`runs`):
- deleted: the runs users deleted. Soft deletes keep e.g. their manifest: we delete it.
- missing_files: the runs whose folder is gone, e.g. deleted by a quota script or by users, deleted in QA-Board or not.
  We never delete files then: only the metadata of runs that have none left.
- both

- Milestones are never deleted: the batches saved as milestones in the web app, and the commits qaboard.yaml
  protects (the latest commit of `project.reference_branch`, and `project.milestones`).
- Fast path: most of those runs have no files left. When a folder is missing, so is everything inside it: we check
  each batch's folder once, and remember the missing folders, instead of checking each run's.
- Storage that isn't mounted looks empty: we never conclude that runs lost their files from a folder missing right
  under a storage root (see common.Folders).
- Errors (e.g. permissions) don't stop the job: the run is kept, so that the next job tries again, and the error
  is recorded with the file and its owner.

The job resumes where it was if it's interrupted: it only looks at what's left.
"""
from pathlib import Path

from sqlalchemy import func
from sqlalchemy.orm import contains_eager

from ..database import db_session
from ..models import Project, CiCommit, Batch, Output
from ..storage import check_storage_path
from ..fs_utils import rmtree, rm_empty_parents
from . import params as p
from .common import matching_projects, quiet, Folders, StorageUnavailable, Protection
from .report import Reporter, utcnow


PARAMS = ('projects', 'exclude_projects', 'runs', 'created_before', 'created_after', 'dry_run')
RUNS = ('deleted', 'missing_files', 'both')
COMMITS_PER_PAGE = 200
ROWS_PER_DELETE = 5_000


def validate(params: dict) -> dict:
  p.known_keys(params, PARAMS)
  runs = params.get('runs') or 'deleted'
  if runs not in RUNS:
    raise p.ParamsError(f"`runs` must be one of: {', '.join(RUNS)}")
  return {
    "projects": p.globs(params.get('projects'), 'projects', default=['*']),
    "exclude_projects": p.globs(params.get('exclude_projects'), 'exclude_projects'),
    "runs": runs,
    "created_before": p.date_or_duration(params.get('created_before'), 'created_before'),
    "created_after": p.date_or_duration(params.get('created_after'), 'created_after'),
    "dry_run": p.boolean(params.get('dry_run'), 'dry_run'),
  }


def describe(params: dict) -> str:
  which = {
    'deleted': 'the deleted runs',
    'missing_files': 'the runs whose files are gone',
    'both': 'the deleted runs, and those whose files are gone,',
  }[params.get('runs') or 'deleted']
  what = f"Hard-delete {which} of {', '.join(params['projects'])}"
  if params.get('exclude_projects'):
    what += f" except {', '.join(params['exclude_projects'])}"
  if params.get('created_before'):
    what += f", created before {params['created_before']}"
  if params.get('created_after'):
    what += f", created after {params['created_after']}"
  return what


def candidate_runs(query, runs, before, after):
  """The runs we look at, in the dates. Never those running (or running again)."""
  query = query.filter(Output.is_pending.isnot(True))
  if runs == 'deleted':
    query = query.filter(Output.deleted.is_(True))
  if before:
    query = query.filter(Output.created_date < before)
  if after:
    query = query.filter(Output.created_date >= after)
  return query


def estimate(params: dict, timeout_seconds=20) -> dict:
  """How many runs match, per project, before excluding the milestones and checking the disk. Raises on timeout."""
  from sqlalchemy import text
  now = utcnow()
  before, after = p.to_datetime(params['created_before'], now), p.to_datetime(params['created_after'], now)
  project_ids = matching_projects(params)
  if not project_ids:
    return {"total": 0, "projects": {}}
  try:
    db_session.execute(text(f"SET LOCAL statement_timeout = {int(timeout_seconds * 1000)}"))
    query = (db_session.query(CiCommit.project_id, func.count(Output.id))
             .select_from(Output)
             .join(Batch, Output.batch_id == Batch.id)
             .join(CiCommit, Batch.ci_commit_id == CiCommit.id)
             .filter(CiCommit.project_id.in_(project_ids))
             .group_by(CiCommit.project_id))
    counts = dict(candidate_runs(query, params['runs'], before, after).all())
  finally:
    db_session.rollback()
  return {"total": sum(counts.values()), "projects": dict(sorted(counts.items(), key=lambda kv: -kv[1]))}


def delete_files(path: Path):
  """Deletes a run's folder"""
  check_storage_path(path)
  with quiet():
    rmtree(path)
    rm_empty_parents(path)


def chunks(items: list, size: int):
  for start in range(0, len(items), size):
    yield items[start:start + size]


class HardDelete:
  def __init__(self, params: dict, report: Reporter):
    self.params = params
    self.report = report
    self.dry_run = params['dry_run']
    self.runs = params.get('runs') or 'deleted'
    # Runs users didn't delete: we only delete their metadata if they have no files, and must be sure of it
    self.live_runs = self.runs != 'deleted'
    now = utcnow()
    self.before = p.to_datetime(params['created_before'], now)
    self.after = p.to_datetime(params['created_after'], now)

  def run(self):
    report = self.report
    if self.dry_run:
      report.log("Dry run: nothing will be deleted", level='warning')
    if self.before or self.after:
      report.log(f"Runs created{f' after {self.after:%Y-%m-%d %H:%M} UTC' if self.after else ''}{f' before {self.before:%Y-%m-%d %H:%M} UTC' if self.before else ''}")
    project_ids = matching_projects(self.params)
    report.set(projects_total=len(project_ids))
    report.log(f"{len(project_ids)} projects match")
    done = set(report.progress.get('projects_finished') or [])
    for project_id in project_ids:
      if project_id in done:
        continue  # the job was interrupted, it resumes
      if report.should_stop():
        return
      report.set(current_project=project_id)
      if not self.project(project_id):
        return  # stopped
      done.add(project_id)
      report.set(projects_finished=sorted(done), projects_done=len(done))
    report.set(current_project=None)
    report.flush(force=True)

  def project(self, project_id: str) -> bool:
    """Returns whether we went through all the project, else we were asked to stop"""
    report = self.report
    project = db_session.query(Project).filter(Project.id == project_id).one_or_none()
    if project is None:
      return True
    try:
      protection = Protection(project)
    except Exception as e:
      # without knowing its milestones, we don't touch the project
      report.error('git', f"{project_id} was skipped: {e}", project_id=project_id)
      report.add(projects_skipped=1)
      return True
    folders = Folders()
    nb_deleted_before = report.progress.get('runs_deleted', 0)
    # where we were, if the job was interrupted
    resume = report.progress.get('resume') or {}
    last_id = resume.get('commit_id', 0) if resume.get('project') == project_id else 0
    while True:
      if report.should_stop():
        return False
      # by commit: they're indexed by project, batches by commit
      commit_ids = [i for (i,) in db_session.query(CiCommit.id)
                    .filter(CiCommit.project_id == project_id, CiCommit.id > last_id)
                    .order_by(CiCommit.id).limit(COMMITS_PER_PAGE)]
      if not commit_ids:
        break
      last_id = commit_ids[-1]
      query = (db_session.query(Batch)
               .join(CiCommit, Batch.ci_commit_id == CiCommit.id)
               .options(contains_eager(Batch.ci_commit))
               .filter(Batch.ci_commit_id.in_(commit_ids)))
      if self.before:
        # runs are created after their batch
        query = query.filter(Batch.created_date < self.before)
      batches = query.order_by(Batch.id).all()
      counts = dict(candidate_runs(
        db_session.query(Output.batch_id, func.count(Output.id)).filter(Output.batch_id.in_([b.id for b in batches])),
        self.runs, self.before, self.after,
      ).group_by(Output.batch_id).all()) if batches else {}
      for batch in batches:
        if counts.get(batch.id):
          if report.should_stop():
            return False
          self.batch(batch, counts[batch.id], protection, folders)
      report.add(batches_checked=len(batches))
      report.set(resume={"project": project_id, "commit_id": last_id})
      db_session.expunge_all()  # memory stays flat
    nb_deleted = report.progress.get('runs_deleted', 0) - nb_deleted_before
    if nb_deleted:
      report.log(f"{project_id}: {nb_deleted} runs {'would be ' if self.dry_run else ''}deleted")
    report.add(folder_checks=folders.checks)
    return True

  def missing(self, folders: Folders, path, deleted: bool) -> bool:
    """Whether a folder is missing. Raises StorageUnavailable when the storage may not be mounted."""
    # outside the storage, we can't tell if it's mounted: fine for runs users deleted, not for the others
    return not folders.exists(path, outside_storage=deleted)

  def batch(self, batch: Batch, nb_runs: int, protection: Protection, folders: Folders):
    report = self.report
    commit = batch.ci_commit
    context = {"project_id": protection.project_id, "batch_id": batch.id}
    if protection.protects(commit.hexsha, batch.label):
      report.add(runs_protected=nb_runs, batches_protected=1)
      return
    try:
      batch_dir = batch.batch_dir
    except Exception as e:
      report.error('other', f"Could not find the folder of batch {batch.label} of commit {commit.hexsha[:8]}: {e}", **context)
      report.add(runs_failed=nb_runs)
      return

    runs = candidate_runs(db_session.query(Output).filter(Output.batch_id == batch.id), self.runs, self.before, self.after)
    to_delete = []
    # Fast path: the runs saved in the batch's folder, when it's missing
    in_batch_dir = runs.filter(Output.output_dir_override.is_(None))
    try:
      batch_dir_missing = self.missing(folders, batch_dir, deleted=not self.live_runs)
    except StorageUnavailable as e:
      report.error('storage', str(e), path=e.path, **context)
      report.add(runs_failed=nb_runs)
      return
    if batch_dir_missing:
      for output_id, deleted in in_batch_dir.with_entities(Output.id, Output.deleted):
        self.without_files(output_id, deleted, to_delete)
    else:
      for output in in_batch_dir.all():
        try:
          output_dir = output.get_output_dir(batch_dir)
        except Exception as e:  # e.g. legacy runs without their input
          report.error('other', f"Could not find the folder of run {output.id}: {e}", output_id=output.id, **context)
          report.add(runs_failed=1)
          continue
        self.delete_run(output.id, bool(output.deleted), output_dir, folders, to_delete, context)
    # Runs saved elsewhere: each has its folder, often in a few missing parent folders
    for output_id, deleted, output_dir in runs.filter(Output.output_dir_override.isnot(None)).with_entities(Output.id, Output.deleted, Output.output_dir_override):
      self.delete_run(output_id, bool(deleted), Path(output_dir), folders, to_delete, context)

    if self.dry_run or not to_delete:
      report.add(runs_deleted=len(to_delete))
      return
    try:
      for ids in chunks(to_delete, ROWS_PER_DELETE):
        db_session.query(Output).filter(Output.id.in_(ids)).delete(synchronize_session=False)
      batch_deleted = False
      if not db_session.query(Output.id).filter(Output.batch_id == batch.id).limit(1).first():
        db_session.query(Batch).filter(Batch.id == batch.id).delete(synchronize_session=False)
        batch_deleted = True
      db_session.commit()
    except Exception as e:
      db_session.rollback()
      report.error('database', f"Could not delete the runs of batch {batch.label} of commit {commit.hexsha[:8]}: {e}", **context)
      report.add(runs_failed=len(to_delete))
      return
    report.add(runs_deleted=len(to_delete), batches_deleted=1 if batch_deleted else 0)
    if not batch_deleted:
      # users' storage usage counts the runs that weren't deleted
      from ..storage_usage import refresh_soon
      refresh_soon([batch.id])

  def without_files(self, output_id: int, deleted: bool, to_delete: list):
    to_delete.append(output_id)
    self.report.add(runs_without_files=1, **({} if deleted else {"live_runs_without_files": 1}))

  def delete_run(self, output_id: int, deleted: bool, output_dir: Path, folders: Folders, to_delete: list, context: dict):
    """A run whose folder may exist"""
    try:
      missing = self.missing(folders, output_dir, deleted)
    except StorageUnavailable as e:
      self.report.error('storage', str(e), path=e.path, output_id=output_id, **context)
      self.report.add(runs_failed=1)
      return
    if missing:
      self.without_files(output_id, deleted, to_delete)
      return
    if not deleted:
      return  # it has files: users still have it
    if self.runs == 'missing_files':
      return  # we don't delete files in this mode
    if self.dry_run:
      to_delete.append(output_id)
      self.report.add(runs_with_files=1)
      return
    try:
      delete_files(output_dir)
    except Exception as e:
      self.report.exception(e, path=output_dir, output_id=output_id, **context)
      self.report.add(runs_failed=1)
      return
    folders.missing.add(str(output_dir))
    to_delete.append(output_id)
    self.report.add(runs_with_files=1)


def run(params: dict, report: Reporter):
  HardDelete(params, report).run()
