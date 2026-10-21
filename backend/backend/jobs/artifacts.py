"""
Deletes the artifacts of old commits (what `qa save-artifacts` saved: builds, configurations...), keeping:
- the artifacts of milestones: the commits with batches saved as milestones (to redo or compare them), and the commits
  qaboard.yaml protects (the latest commit of `project.reference_branch`, and `project.milestones`),
- the other commits on the reference branch, unless `can_delete_reference_branch`,
- the commits with runs in progress,
- what `keep` lists (artifact groups, paths, globs), and what each project's `storage.garbage.artifacts.keep` lists,
- the files that other subprojects of the same commit still use.

Commits whose artifacts folder is already gone are only marked as such (fast). The runs and the commits stay: their
page says when and by whom the artifacts were deleted, and QA-Board can recreate them (recreate_artifacts).
Commits whose deletion had errors are tried again by the next job.
"""
import datetime

from sqlalchemy import func, or_, and_, text
from sqlalchemy.orm.attributes import flag_modified

from ..database import db_session
from ..models import Project, CiCommit, Batch, Output
from ..durations import parse_time
from . import params as p
from .common import matching_projects, quiet, Folders, Protection
from .report import Reporter, utcnow


PARAMS = ('projects', 'exclude_projects', 'older_than', 'keep', 'can_delete_reference_branch', 'dry_run')
COMMITS_PER_PAGE = 200


def validate(params: dict) -> dict:
  p.known_keys(params, PARAMS)
  older_than = p.duration(params.get('older_than'), 'older_than')
  if not older_than:
    raise p.ParamsError("`older_than` is required: how long since the commit's latest run, e.g. 1month")
  return {
    "projects": p.globs(params.get('projects'), 'projects', default=['*']),
    "exclude_projects": p.globs(params.get('exclude_projects'), 'exclude_projects'),
    "older_than": older_than,
    "keep": p.globs(params.get('keep'), 'keep'),
    "can_delete_reference_branch": p.boolean(params.get('can_delete_reference_branch'), 'can_delete_reference_branch'),
    "dry_run": p.boolean(params.get('dry_run'), 'dry_run'),
  }


def describe(params: dict) -> str:
  what = f"Delete the artifacts of {', '.join(params['projects'])}"
  if params.get('exclude_projects'):
    what += f" except {', '.join(params['exclude_projects'])}"
  what += f", for commits without runs for {params['older_than']}"
  if params.get('keep'):
    what += f", keeping {', '.join(params['keep'])}"
  return what


def artifacts_to_delete(query):
  """Commits whose artifacts are there, or whose deletion had errors"""
  had_errors = and_(
    CiCommit.deleted.is_(True),
    text("coalesce(jsonb_array_length(CASE WHEN jsonb_typeof(ci_commits.data->'artifacts_deleted'->'errors') = 'array' THEN ci_commits.data->'artifacts_deleted'->'errors' END), 0) > 0"),
  )
  return query.filter(or_(CiCommit.deleted.isnot(True), had_errors))


def project_keep(project: Project) -> list:
  """storage.garbage.artifacts.keep in qaboard.yaml"""
  try:
    keep = project.data.get("qatools_config", {}).get("storage", {}).get('garbage', {}).get('artifacts', {}).get('keep') or []
  except AttributeError:  # e.g. storage is a string
    return []
  return [keep] if isinstance(keep, str) else [str(k) for k in keep if k]


class DeleteArtifacts:
  def __init__(self, params: dict, report: Reporter):
    self.params = params
    self.report = report
    self.dry_run = params['dry_run']
    self.threshold = utcnow() - parse_time(params['older_than'])
    job_id = getattr(report, 'job_id', None)
    self.by = f"admin job #{job_id}" if job_id else "qaboard-admin"

  def run(self):
    report = self.report
    if self.dry_run:
      report.log("Dry run: nothing will be deleted", level='warning')
    report.log(f"Commits without runs since {self.threshold:%Y-%m-%d %H:%M} UTC")
    project_ids = matching_projects(self.params)
    report.set(projects_total=len(project_ids))
    report.log(f"{len(project_ids)} projects match")
    done = set(report.progress.get('projects_finished') or [])
    for project_id in project_ids:
      if project_id in done:
        continue
      if report.should_stop():
        return
      report.set(current_project=project_id)
      if not self.project(project_id):
        return
      done.add(project_id)
      report.set(projects_finished=sorted(done), projects_done=len(done))
    report.set(current_project=None)
    report.flush(force=True)

  def project(self, project_id: str) -> bool:
    report = self.report
    project = db_session.query(Project).filter(Project.id == project_id).one_or_none()
    if project is None:
      return True
    try:
      protection = Protection(project)
    except Exception as e:
      report.error('git', f"{project_id} was skipped: {e}", project_id=project_id)
      report.add(projects_skipped=1)
      return True
    keep = [*self.params['keep'], *project_keep(project)]
    folders = Folders()
    nb_before = report.progress.get('commits_deleted', 0)
    resume = report.progress.get('resume') or {}
    last_id = resume.get('commit_id', 0) if resume.get('project') == project_id else 0
    while True:
      if report.should_stop():
        return False
      query = (db_session.query(CiCommit)
               .filter(CiCommit.project_id == project_id, CiCommit.id > last_id)
               # commits without runs are judged by their date
               .filter(func.coalesce(CiCommit.latest_output_datetime, CiCommit.authored_datetime) < self.threshold))
      if not self.params['can_delete_reference_branch']:
        refs = protection.protected_refs
        query = query.filter(or_(CiCommit.branch.is_(None), CiCommit.branch.notin_([*refs, *[f'origin/{r}' for r in refs]])))
      commits = artifacts_to_delete(query).order_by(CiCommit.id).limit(COMMITS_PER_PAGE).all()
      if not commits:
        break
      last_id = commits[-1].id
      busy = {commit_id for (commit_id,) in db_session.query(Batch.ci_commit_id).join(Output, Output.batch_id == Batch.id)
              .filter(Batch.ci_commit_id.in_([c.id for c in commits]), Output.is_pending.is_(True)).distinct()}
      for commit in commits:
        if report.should_stop():
          return False
        if protection.protects_commit(commit.hexsha):
          report.add(commits_protected=1)
        elif commit.id in busy:
          report.add(commits_busy=1)
        else:
          self.commit(commit, keep, folders, project_id)
      report.add(commits_checked=len(commits))
      report.set(resume={"project": project_id, "commit_id": last_id})
      db_session.expunge_all()
    nb = report.progress.get('commits_deleted', 0) - nb_before
    if nb:
      report.log(f"{project_id}: the artifacts of {nb} commits {'would be ' if self.dry_run else ''}deleted")
    report.add(folder_checks=folders.checks)
    return True

  def commit(self, commit: CiCommit, keep: list, folders: Folders, project_id: str):
    report = self.report
    context = {"project_id": project_id}
    try:
      artifacts_dir = commit.artifacts_dir
      # outside the storage, QA-Board can't delete anyway: it reports it
      missing = not folders.exists(artifacts_dir, outside_storage=True)
    except Exception as e:
      report.error('storage', f"{commit.hexsha[:8]}: {e}", path=getattr(e, 'path', None), **context)
      report.add(commits_failed=1)
      return
    if missing:
      report.add(commits_deleted=1, commits_without_files=1)
      if not self.dry_run:
        commit.deleted = True
        commit.data = {**(commit.data or {}), 'artifacts_deleted': {
          "at": datetime.datetime.now(datetime.timezone.utc).isoformat(), "by": self.by, "nb_deleted": 0, "errors": [], "already_gone": True,
        }}
        flag_modified(commit, "data")
        db_session.commit()
      return
    try:
      with quiet():
        summary = commit.delete(keep=keep, dryrun=self.dry_run, session=db_session, by=self.by)
    except Exception as e:
      db_session.rollback()
      report.exception(e, path=artifacts_dir, **context)
      report.add(commits_failed=1)
      return
    for error in summary["errors"]:
      report.error_message(error, **context)
    report.add(
      commits_deleted=0 if summary["errors"] else 1,
      commits_failed=1 if summary["errors"] else 0,
      artifacts_files=summary["nb_deleted"],
      artifacts_files_kept=summary.get("kept", 0),
    )
    if self.dry_run:
      db_session.rollback()
    else:
      # even with errors: the next job tries again (artifacts_to_delete)
      db_session.commit()


def run(params: dict, report: Reporter):
  DeleteArtifacts(params, report).run()
