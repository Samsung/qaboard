"""
What jobs can do. Each kind validates its parameters, describes them, and runs, reporting to a Reporter.
To add a kind: a module with validate(params) -> params, describe(params) -> str, run(params, report), listed here.
"""
from . import hard_delete, garbage_collect, artifacts, usage, delete_runs, groups, measure_deleted, scan, storage_actions, fail_stuck_runs


KINDS = {
  'hard_delete': hard_delete,
  'garbage_collect': garbage_collect,
  'delete_artifacts': artifacts,
  'storage_usage': usage,
  'delete_runs': delete_runs,
  'sync_groups': groups,
  'measure_deleted': measure_deleted,
  'scan_storage': scan,
  'delete_paths': storage_actions.DeletePaths,
  'delete_exports': storage_actions.DeleteExports,
  'import_runs': storage_actions.ImportRuns,
  'fail_stuck_runs': fail_stuck_runs,
}

LABELS = {
  'hard_delete': 'Hard-delete runs',
  'garbage_collect': 'Delete old results',
  'delete_artifacts': 'Delete artifacts',
  'storage_usage': 'Compute storage usage',
  'delete_runs': "Delete users' runs",
  'sync_groups': "Update users' groups",
  'measure_deleted': "Measure what deleted runs left",
  'scan_storage': 'Scan the storage',
  'delete_paths': 'Delete untracked files',
  'delete_exports': 'Delete exports',
  'import_runs': 'Add untracked runs',
  'fail_stuck_runs': 'Fail stuck runs',
}

# Kinds run in the worker's interactive lane, next to the long maintenance jobs: users wait for them
INTERACTIVE = [kind for kind, module in KINDS.items() if getattr(module, 'INTERACTIVE', False)]


def get(kind: str):
  from .params import ParamsError
  if kind not in KINDS:
    raise ParamsError(f"Unknown job kind: {kind!r}. Use one of: {', '.join(KINDS)}")
  return KINDS[kind]


def validate(kind: str, params) -> dict:
  return get(kind).validate(params if params is not None else {})
