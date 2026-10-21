"""
What jobs can do. Each kind validates its parameters, describes them, and runs, reporting to a Reporter.
To add a kind: a module with validate(params) -> params, describe(params) -> str, run(params, report), listed here.
"""
from . import hard_delete, garbage_collect, artifacts


KINDS = {
  'hard_delete': hard_delete,
  'garbage_collect': garbage_collect,
  'delete_artifacts': artifacts,
}

LABELS = {
  'hard_delete': 'Hard-delete runs',
  'garbage_collect': 'Delete old results',
  'delete_artifacts': 'Delete artifacts',
}


def get(kind: str):
  from .params import ParamsError
  if kind not in KINDS:
    raise ParamsError(f"Unknown job kind: {kind!r}. Use one of: {', '.join(KINDS)}")
  return KINDS[kind]


def validate(kind: str, params) -> dict:
  return get(kind).validate(params if params is not None else {})
