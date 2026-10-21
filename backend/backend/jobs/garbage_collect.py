"""
Deletes old results, following each project's qaboard.yaml (`storage.garbage`), like `qaboard_clean`.
Runs are soft-deleted (their files, not their metadata): a hard delete job removes them later.
See website/docs/storage/deleting-old-data.mdx
"""
from . import params as p
from .report import Reporter


PARAMS = ('projects', 'exclude_projects', 'older_than', 'default_older_than', 'can_delete_reference_branch',
          'delete_outputs', 'delete_artifacts', 'dry_run')


def validate(params: dict) -> dict:
  p.known_keys(params, PARAMS)
  valid = {
    "projects": p.globs(params.get('projects'), 'projects', default=['*']),
    "exclude_projects": p.globs(params.get('exclude_projects'), 'exclude_projects'),
    # overrides qaboard.yaml's storage.garbage.after
    "older_than": p.duration(params.get('older_than'), 'older_than'),
    # for projects whose qaboard.yaml doesn't say
    "default_older_than": p.duration(params.get('default_older_than'), 'default_older_than') or '1month',
    "can_delete_reference_branch": p.boolean(params.get('can_delete_reference_branch'), 'can_delete_reference_branch'),
    "delete_outputs": p.boolean(params.get('delete_outputs'), 'delete_outputs', default=True),
    "delete_artifacts": p.boolean(params.get('delete_artifacts'), 'delete_artifacts'),
    "dry_run": p.boolean(params.get('dry_run'), 'dry_run'),
  }
  if valid['older_than'] and valid['projects'] == ['*']:
    # like `qaboard_clean --before`: overriding what every project asks for is rarely what you want
    raise p.ParamsError("`older_than` overrides what projects set in qaboard.yaml: choose which projects. To apply to the projects that don't set it, use `default_older_than`.")
  return valid


def describe(params: dict) -> str:
  what = f"Delete the old results of {', '.join(params['projects'])}"
  if params.get('exclude_projects'):
    what += f" except {', '.join(params['exclude_projects'])}"
  if params.get('older_than'):
    what += f", older than {params['older_than']}"
  else:
    what += f", as qaboard.yaml says (else older than {params['default_older_than']})"
  return what


def run(params: dict, report: Reporter):
  from ..clean import collect_garbage
  collect_garbage(
    lambda project_id: p.matches(project_id, params['projects'], params['exclude_projects']),
    report,
    before=params['older_than'],
    default_after=params['default_older_than'],
    can_delete_reference_branch=params['can_delete_reference_branch'],
    can_delete_outputs=params['delete_outputs'],
    can_delete_artifacts=params['delete_artifacts'],
    dryrun=params['dry_run'],
  )
