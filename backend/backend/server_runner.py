"""
Where the `qa batch` of the batches the server starts runs: tuning, `qa optimize` and `qa batch --commit`
(api/tuning.py), and redoing runs (redo.py). Admins choose it with QABOARD_TUNING_RUNNER:
- not set: the server starts no batches. They'd run the project's code (its .envrc, `qa batch`, iter_inputs...), and
  with artifacts sent by `qa save-artifacts`, anyone with a project token could make the server run code.
- local, celery: `qa batch` runs in the backend's container, as its account (local_jobs.py). The explicit opt-in.
- lsf: `bsub` from the server, or via the LSF bridge (QA_RUNNERS_LSF_BRIDGE). kubernetes: in a pod (runner_jobs.py).
Redo also runs `qa batch` via the LSF bridge when it's set, whatever the runner but kubernetes.
"""
import os
from typing import Optional


# `qa batch` runs in the backend's container
IN_SERVER_RUNNERS = ('local', 'celery')
RUNNERS = (*IN_SERVER_RUNNERS, 'lsf', 'kubernetes')
DOCS = "/docs/backend-admin/runners"


def server_runner() -> Optional[str]:
  """The runner of the batches the server starts (QABOARD_TUNING_RUNNER), or None: it starts none"""
  return os.environ.get('QABOARD_TUNING_RUNNER', '').strip().lower() or None


def redo_runner() -> Optional[str]:
  """How redo runs `qa batch`: "kubernetes" (a pod), "bridge" (the LSF bridge), "local" (the backend's container) or None"""
  runner = server_runner()
  if runner == 'kubernetes':
    return 'kubernetes'
  if os.environ.get('QA_RUNNERS_LSF_BRIDGE'):
    return 'bridge'
  return 'local' if runner in IN_SERVER_RUNNERS else None


def runs_in_server(runner: Optional[str]) -> bool:
  return runner in IN_SERVER_RUNNERS


def _docs() -> str:
  from .api.tuning import docs_link
  return docs_link(DOCS)


def refusal(redo: bool = False) -> Optional[str]:
  """Why the server can't start this batch (or redo runs, with `redo`) at all, for users: None if it can"""
  runner = server_runner()
  what = "redo runs" if redo else "start batches"
  elsewhere = ("Run `qa batch` again from CI or a terminal" if redo else "Start the batch from CI or a terminal with `qa batch`") + ": it still works."
  if runner is not None and runner not in RUNNERS:
    return (f"QA-Board can't {what}: its QABOARD_TUNING_RUNNER ({runner}) isn't local, celery, lsf or kubernetes. "
            f"Ask its administrators to fix it. {elsewhere} See {_docs()}")
  if (redo_runner() if redo else runner) is None:
    if redo and runner == 'lsf':
      return ("QA-Board redoes runs on LSF through its LSF bridge, which isn't set up (QA_RUNNERS_LSF_BRIDGE). "
              f"Ask its administrators to set it. {elsewhere} See {_docs()}")
    return (f"This QA-Board server doesn't {what} itself: its administrators haven't chosen where they run "
            f"(QABOARD_TUNING_RUNNER, e.g. on Kubernetes or LSF). Ask them to set it up. {elsewhere} See {_docs()}")
  return None
