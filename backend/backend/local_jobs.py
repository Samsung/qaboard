"""
`qa batch` commands that the server runs itself, in the backend's container: batches started from the web app with
QABOARD_TUNING_RUNNER=local (the default) or celery (api/tuning.py), and redoing runs without the LSF bridge (redo.py).

- They run detached (start_detached): in their own process group, outside of the HTTP request, so that uWSGI's
  `harakiri` (300s) doesn't kill them and requests don't wait for them. Their submission (submissions.py) records
  {"pid", "pgid", "host"}, with the status "submitted". When the script ends, its exit code is written in
  <log_dir>/exit_code: refresh_status() reads it, and the web app reads the logs' "[qaboard] qa batch exited with code".
  Once read, the final status is recorded in the submission (persist_final_status): we stop reading the storage.
- Stopping the batch (Batch.stop) kills them and what they started (stop_local_submissions), if they run on this host:
  with several replicas of the backend, they may run on another, and we say so.
- Their environment is the server's, minus its secrets (qa_environment). It's defense in depth: they run the project's
  code (its .envrc, `qa batch`, iter_inputs...) in the server's container, with its account. Files the server can read
  (e.g. SAML keys, the LSF bridge's ssh key, a Kubernetes ServiceAccount's token) are readable by that code too.

batch.data.submissions can be written by unauthenticated API calls: before we kill processes, we check they're those
we started for the submission (QABOARD_SUBMISSION_ID in their environment), never just the pid we're given.
"""
import os
import time
import signal
import socket
import subprocess
from pathlib import Path
from typing import Any, Dict, List, Optional

from qaboard.runners.env import is_secret as is_runner_secret


# In the environment of what we start, to find it again, even processes that left its process group
SUBMISSION_ENV = 'QABOARD_SUBMISSION_ID'
EXIT_CODE_FILE = 'exit_code'
# the runners whose `qa batch` the server starts itself
LOCAL_RUNNERS = ('local', 'celery')

# Variables whose names contain these words hold secrets, besides those the runners never forward (runners/env.py:
# *TOKEN*, *PASSWORD*, *SECRET*, *AUTH*...). The server is stricter: `qa batch` doesn't need its keys.
SERVER_SECRET_WORDS = ("KEY", "PRIVATE", "CREDENTIAL", "DSN", "DATABASE_URL", "PASS")

def is_secret(name: str, value: str = '') -> bool:
  """From the name, or the value: URLs with credentials (user:password@host)"""
  return is_runner_secret(name, value) or any(word in name.upper() for word in SERVER_SECRET_WORDS)

# The server's settings with secrets or that only the server needs, besides those is_secret() finds from their names:
# the database, LDAP, SMTP, sign-in, analytics, Sentry
SERVER_ONLY_PREFIXES = (
  'QABOARD_DB_', 'QABOARD_LDAP_', 'QABOARD_SMTP_', 'QABOARD_OIDC_', 'QABOARD_SAML_', 'QABOARD_PGADMIN_',
  'PGADMIN_', 'PGPASS', 'POSTHOG_', 'SENTRY_', 'RABBITMQ_', 'UWSGI_',
)
# Only for `qa batch` that may send runs to Celery workers
CELERY_VARIABLES = ('CELERY_BROKER_URL', 'CELERY_RESULT_BACKEND')


def qa_environment(submission_id: str, celery: bool = False, environ: Optional[Dict[str, str]] = None) -> Dict[str, str]:
  """
  The environment of the `qa batch` the server starts: the server's, minus its secrets. It keeps what `qa` needs: PATH,
  HOME, LANG, QABOARD_HOST/QABOARD_PROTOCOL, proxies, CA bundles, QA_RUNNERS_LSF_BRIDGE... and with `celery`, the broker.
  """
  environ = os.environ if environ is None else environ
  env = {
    k: v for k, v in environ.items()
    if not is_secret(k, v) and not k.startswith(SERVER_ONLY_PREFIXES) and k not in CELERY_VARIABLES
  }
  if celery:
    env.update({k: environ[k] for k in CELERY_VARIABLES if k in environ})
  env[SUBMISSION_ENV] = submission_id
  return env


def project_uses_celery(ci_commit) -> bool:
  """Whether the project's qaboard.yaml configures the celery runner: its `qa batch` needs the broker"""
  try:
    config = (ci_commit.project.data or {}).get('qatools_config') or {}
    runners = config.get('runners', config) if isinstance(config, dict) else {}
    return isinstance(runners, dict) and ('celery' in runners or runners.get('default') == 'celery')
  except AttributeError:
    return False


# `bash script` in the background of a shell that exits right away: nothing is left for the server to wait for (no
# zombie), and the script outlives the request and uWSGI's worker. The launcher is started in a new session, so the
# script is in a process group of its own, whose id is the launcher's pid.
LAUNCHER = '( bash "$1"; echo $? > "$2/exit_code" ) >> "$2/log.txt" 2>&1 < /dev/null & echo $!'

# How long we wait for `qa batch`, so that users see right away when it fails to start
def start_wait() -> float:
  try:
    return float(os.environ.get('QABOARD_LOCAL_START_WAIT', 3))
  except ValueError:
    return 3


def start_detached(script_path, log_dir, env: Dict[str, str], wait: Optional[float] = None) -> Dict[str, Any]:
  """
  Runs `bash script_path` on this host, detached, with `env`, its output appended to log_dir/log.txt.
  Waits a few seconds (QABOARD_LOCAL_START_WAIT, default 3): if it ends meanwhile, returns {"status": "done"|"failed",
  "exit_code"}, else {"status": "submitted"}, with {"pid", "pgid", "host"}. Raises if it can't start.
  """
  log_dir = Path(log_dir)
  (log_dir / EXIT_CODE_FILE).unlink(missing_ok=True)
  print(['bash', str(script_path)])
  launcher = subprocess.Popen(
    ['bash', '-c', LAUNCHER, 'qaboard-launcher', str(script_path), str(log_dir)],
    cwd=log_dir, env=env, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    encoding='utf-8', start_new_session=True,
  )
  stdout, stderr = launcher.communicate(timeout=30)
  if launcher.returncode != 0 or not stdout.strip().isdigit():
    raise RuntimeError(f"Could not start {script_path}: {stderr.strip() or stdout.strip()}")
  submission: Dict[str, Any] = {"pid": int(stdout.strip()), "pgid": launcher.pid, "host": socket.gethostname(), "status": "submitted"}
  deadline = time.monotonic() + (start_wait() if wait is None else wait)
  while True:
    exit_code = read_exit_code(log_dir)
    if exit_code is not None:
      return {**submission, "status": "done" if exit_code == 0 else "failed", "exit_code": exit_code}
    if time.monotonic() >= deadline:
      return submission
    time.sleep(0.1)


def read_exit_code(log_dir) -> Optional[int]:
  try:
    with (Path(log_dir) / EXIT_CODE_FILE).open() as f:
      return int(f.read(16).strip())
  except (OSError, ValueError, TypeError):
    return None


def is_local_submission(submission) -> bool:
  """A `qa batch` the server started itself, that was still running the last time we looked"""
  return (isinstance(submission, dict)
          and submission.get('runner') in LOCAL_RUNNERS
          and submission.get('status') == 'submitted'
          and isinstance(submission.get('pid'), int))


def _processes(submission_id: str) -> List[Any]:
  """The processes we started for a submission, and what they started: they have its id in their environment"""
  import psutil
  found = []
  for process in psutil.process_iter():
    try:
      if process.pid != os.getpid() and process.environ().get(SUBMISSION_ENV) == submission_id:
        found.append(process)
    except (psutil.Error, OSError):
      # other users' processes, or gone
      continue
  return found


def _is_running(submission_id: str, pid: int) -> Optional[bool]:
  """Whether the process we started for the submission still runs. None: we can't tell"""
  import psutil
  try:
    process = psutil.Process(pid)
    if process.status() == psutil.STATUS_ZOMBIE:
      return False
    return process.environ().get(SUBMISSION_ENV) == submission_id
  except psutil.NoSuchProcess:
    return False
  except (psutil.Error, OSError):
    return None


def refresh_status(submission, submission_id: Optional[str] = None):
  """
  The submission, with the status of a `qa batch` the server started itself: "done" or "failed" with its "exit_code"
  once it ended, or "failed" if it's gone without saying (e.g. the server's container restarted). Doesn't write anything.
  """
  if not is_local_submission(submission):
    return submission
  exit_code = read_exit_code(submission.get('log_dir'))
  if exit_code is not None:
    return {**submission, "status": "done" if exit_code == 0 else "failed", "exit_code": exit_code}
  submission_id = submission_id or submission.get('id')
  if submission.get('host') == socket.gethostname() and submission_id and _is_running(submission_id, submission['pid']) is False:
    # it writes its exit code before it exits: maybe it did just now
    exit_code = read_exit_code(submission.get('log_dir'))
    if exit_code is not None:
      return {**submission, "status": "done" if exit_code == 0 else "failed", "exit_code": exit_code}
    return {**submission, "status": "failed", "error": "qa batch stopped without an exit code: it was killed, maybe when the QA-Board server restarted."}
  return submission


FINAL_STATUS_FIELDS = ('status', 'exit_code', 'error')

def persist_final_status(batch_id, submission) -> bool:
  """
  Records in batch.data the final status of a `qa batch` the server ran (from refresh_status), so that later reads
  don't look at the storage for its exit code. In its own transaction, only if the submission is still "submitted",
  and only if nothing holds the batch's row (e.g. the request's own session, that changed the batch): then we skip it
  and record it next time. Returns whether it was recorded.
  """
  submission_id = submission.get('id') if isinstance(submission, dict) else None
  if batch_id is None or not isinstance(submission_id, str) or submission.get('status') == 'submitted':
    return False
  patch = {k: submission[k] for k in FINAL_STATUS_FIELDS if k in submission}
  import json
  from sqlalchemy import text
  from backend.database import engine
  try:
    with engine.begin() as connection:
      result = connection.execute(text("""
        UPDATE batches SET data = jsonb_set(data, ARRAY['submissions', :submission_id], (data->'submissions'->:submission_id) || CAST(:patch AS jsonb))
        WHERE id IN (SELECT id FROM batches WHERE id = :batch_id FOR UPDATE SKIP LOCKED)
          AND data->'submissions'->:submission_id->>'status' = 'submitted'
      """), {"batch_id": batch_id, "submission_id": submission_id, "patch": json.dumps(patch)})
      return result.rowcount > 0
  except Exception as e:
    print(f"WARNING: could not record the status of the `qa batch` {submission_id} of batch {batch_id}: {e}")
    return False


def _kill(submission_id: str, submission: dict, grace: float = 3) -> None:
  """Stops what we started for the submission: its process group, and the processes with its id in their environment"""
  import psutil
  processes = _processes(submission_id)
  # The process group too, for what cleared its environment. Only the group of a process we started.
  pgid = submission.get('pgid')
  groups = set()
  if isinstance(pgid, int) and pgid > 1 and pgid != os.getpgrp():
    for process in processes:
      try:
        if os.getpgid(process.pid) == pgid:
          groups.add(pgid)
      except OSError:
        pass
  for sig in (signal.SIGTERM, signal.SIGKILL):
    for group in groups:
      try:
        os.killpg(group, sig)
      except OSError:
        pass
    for process in processes:
      try:
        process.send_signal(sig)
      except psutil.Error:
        pass
    if sig == signal.SIGTERM:
      _, processes = psutil.wait_procs(processes, timeout=grace)
      groups = {g for g in groups if _group_exists(g)}
      if not processes and not groups:
        return


def _group_exists(pgid: int) -> bool:
  try:
    os.killpg(pgid, 0)
    return True
  except OSError:
    return False


def stop_local_submissions(data) -> Dict[str, list]:
  """
  Stops the `qa batch` the server started itself for a batch (batch.data), with what they started, e.g. local runs.
  Returns {"stopped": [submission ids], "errors": [...]} for those we couldn't stop: those on another host.
  """
  submissions = (data or {}).get('submissions') or {}
  stopped: List[str] = []
  errors: List[str] = []
  if not isinstance(submissions, dict):
    return {"stopped": stopped, "errors": errors}
  here = socket.gethostname()
  for submission_id, submission in submissions.items():
    if not is_local_submission(submission) or refresh_status(submission, submission_id)['status'] != 'submitted':
      continue
    host = submission.get('host')
    if host != here:
      message = (f"Could not stop the `qa batch` {submission_id[:8]}: it runs on {host}, another replica of the QA-Board server "
                 f"(this one is {here}). Try again, or ask your QA-Board admins to stop it.")
      print(f"WARNING: {message}")
      errors.append(message)
      continue
    print(f"stopping the local `qa batch` {submission_id} (pid {submission.get('pid')})")
    _kill(submission_id, submission)
    stopped.append(submission_id)
  return {"stopped": stopped, "errors": errors}
