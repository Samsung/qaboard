"""
The deletion rules that apply to a project, in words users understand: what the schedules admins set up
(Admin > Storage) delete, when, and what they keep, with what the project's qaboard.yaml says.
"""
from typing import Optional, List

from .database import db_session
from .models import JobSchedule, Project
from .jobs.cron import describe as describe_cron
from .jobs.params import matches


def garbage_config(project: Optional[Project]) -> dict:
  try:
    return ((project.data or {}).get("qatools_config", {}).get("storage", {}).get('garbage', {}) or {}) if project else {}
  except AttributeError:
    return {}


def iso(date):
  return f"{date.isoformat()}Z" if date else None


def applies(schedule: JobSchedule, project_id: Optional[str]) -> bool:
  params = schedule.params or {}
  include = params.get('projects') or ['*']
  if project_id is None:
    return True
  return matches(project_id, include, params.get('exclude_projects') or [])


def rule(schedule: JobSchedule, project: Optional[Project]) -> Optional[dict]:
  params = schedule.params or {}
  when = describe_cron(schedule.cron, schedule.timezone)
  scope = ', '.join(params.get('projects') or ['*'])
  base = {
    "kind": schedule.kind,
    "schedule": schedule.name,
    "when": when,
    "next_run_at": iso(schedule.next_run_at),
    "last_run_at": iso(schedule.last_run_at),
    "projects": scope,
    "dry_run": bool(params.get('dry_run')),
  }
  if schedule.kind == 'hard_delete':
    runs = params.get('runs') or 'deleted'
    age = f" created before {params['created_before']}" if params.get('created_before') else ''
    what = {
      'deleted': f"Runs that were deleted{age} are removed for good, with what's left of their files.",
      'missing_files': f"Runs{age} whose folder was deleted are removed from QA-Board.",
      'both': f"Runs that were deleted{age} are removed for good, with what's left of their files, and so are runs whose folder was deleted.",
    }[runs]
    return {**base, "title": "Deleted runs are removed", "detail": what, "keeps": "Milestones are kept."}
  if schedule.kind == 'garbage_collect':
    config = garbage_config(project)
    if params.get('older_than'):
      after, source = params['older_than'], 'set by the admins for this project'
    elif project is not None and config.get('after'):
      after, source = config['after'], "from the project's qaboard.yaml (storage.garbage.after)"
    else:
      after, source = params.get('default_older_than') or '1month', 'the default for projects whose qaboard.yaml says nothing'
    artifacts = params.get('delete_artifacts') or ((config.get('artifacts') or {}).get('delete') if isinstance(config.get('artifacts'), dict) else False)
    reference = params.get('can_delete_reference_branch') or config.get('can_delete_reference_branch')
    detail = f"The files of runs on commits without new runs for {after} are deleted ({source}). The runs stay listed, as deleted."
    if artifacts:
      detail += " The commits' artifacts are deleted too."
    keeps = "Milestones are kept" + (", and the reference branch's latest commit." if reference else ", and the commits of the reference branch.")
    return {**base, "title": "Old results are deleted", "detail": detail, "keeps": keeps, "after": after}
  if schedule.kind == 'delete_artifacts':
    keep = params.get('keep') or []
    detail = f"The artifacts of commits without runs for {params.get('older_than')} are deleted."
    if keep:
      detail += f" Kept: {', '.join(keep)}."
    keeps = "Milestones' artifacts are kept" + (", and the reference branch's latest commit's." if params.get('can_delete_reference_branch') else ", and the reference branch's.")
    return {**base, "title": "Old artifacts are deleted", "detail": detail, "keeps": keeps}
  return None


def rules(project_id: Optional[str] = None) -> List[dict]:
  """The enabled schedules that delete something in the project (all of them without a project), the soonest first"""
  project = db_session.get(Project, project_id) if project_id else None
  answer = []
  schedules = JobSchedule.query.filter(JobSchedule.enabled.is_(True)).order_by(JobSchedule.next_run_at.asc().nullslast()).all()
  for schedule in schedules:
    if schedule.kind not in ('hard_delete', 'garbage_collect', 'delete_artifacts') or not applies(schedule, project_id):
      continue
    item = rule(schedule, project)
    if item:
      answer.append(item)
  return answer


def project_settings(project_id: str) -> dict:
  """What the project's qaboard.yaml says about deleting its results"""
  project = db_session.get(Project, project_id)
  config = garbage_config(project)
  return {
    "after": config.get('after'),
    "artifacts_delete": bool((config.get('artifacts') or {}).get('delete')) if isinstance(config.get('artifacts'), dict) else False,
    "can_delete_reference_branch": bool(config.get('can_delete_reference_branch')),
  } if project else {}
