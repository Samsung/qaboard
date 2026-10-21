"""
What jobs can do. Each kind validates its parameters, describes them, and runs, reporting to a Reporter.
To add a kind: a module with validate(params) -> params, describe(params) -> str, run(params, report), listed here.
"""
from . import hard_delete, garbage_collect, artifacts, usage, delete_runs, groups


KINDS = {
  'hard_delete': hard_delete,
  'garbage_collect': garbage_collect,
  'delete_artifacts': artifacts,
  'storage_usage': usage,
  'delete_runs': delete_runs,
  'sync_groups': groups,
}

LABELS = {
  'hard_delete': 'Hard-delete runs',
  'garbage_collect': 'Delete old results',
  'delete_artifacts': 'Delete artifacts',
  'storage_usage': 'Compute storage usage',
  'delete_runs': "Delete users' runs",
  'sync_groups': "Update users' groups",
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
