"""
Redo runs from QA-Board.

We start a single `qa batch --runs-file` for all the runs we redo, so that the runner settings of the batch apply
to them together, e.g. how many runs are in flight (concurrency). Like other batches started from QA-Board,
its script, the list of runs and the logs are saved in the batch directory, and users see them with the batch's logs.

Note: almost everything used here comes from unauthenticated API calls (see shell_utils.py).
"""
import os
import re
import json
import uuid
import datetime
import subprocess
from pathlib import Path

from backend import db_session
from .shell_utils import quote, is_shell_safe, safe_user_name, lsf_bridge_command
from .storage import check_storage_path
from .submissions import record_submission, user_batch_dir, submission_dir


def _is_int(value) -> bool:
  return isinstance(value, int) and not isinstance(value, bool)

def _is_number(value) -> bool:
  return _is_int(value) or isinstance(value, float)

def _is_megabytes(value) -> bool:
  # from the CLI (--lsf-max-memory) it's a string
  return _is_int(value) or (isinstance(value, str) and value.isdigit())

def _is_word(value) -> bool:
  return isinstance(value, str) and is_shell_safe(value)

# LSF resource requirements, e.g. "select[mem>4000] rusage[mem=4000] span[hosts=1]". `qa` puts them in double quotes.
_lsf_resources_re = re.compile(r'^[\w .,:;=<>\[\](){}|&!*+/#%@~-]*$')

# The job options of the runs we redo. `qa batch` uses them to build shell commands (e.g. bsub),
# so we keep only those needed to run like before, with safe values. Others come from the project's qaboard.yaml.
SAFE_JOB_OPTIONS = {
  "type": lambda value: value in ("lsf", "dask", "local", "celery"),
  "concurrency": _is_int,
  "timeout": _is_number,
  # LSF
  "queue": _is_word,
  "project": _is_word,
  "priority": _is_int,
  "max_memory": _is_megabytes,
  "max_threads": _is_int,
  "resources": lambda value: isinstance(value, str) and bool(_lsf_resources_re.match(value)),
  "concurrency_strategy": lambda value: value in ("array", "waves"),
}

def safe_job_options(job_options) -> dict:
  if not isinstance(job_options, dict):
    return {}
  return {k: v for k, v in job_options.items() if k in SAFE_JOB_OPTIONS and SAFE_JOB_OPTIONS[k](v)}


def run_spec(output) -> dict:
  """How `qa batch --runs-file` redoes an output"""
  data = output.data or {}
  return {
    "input_path": str(output.test_input.path),
    "database": str(output.test_input.database),
    "type": output.output_type,
    "platform": output.platform,
    "configurations": output.configurations,
    "extra_parameters": output.extra_parameters,
    "batch": data.get("batch"),
    "job_options": safe_job_options(data.get("job_options")),
  }


def redo_script(ci_commit, user, command_id, batch_command) -> str:
  # CI results are saved under the CI user's folder (QABOARD_DEFAULT_USER), runs started here under the user's
  outputs_dir_prefix = str(user_batch_dir(ci_commit.outputs_dir, user))
  artifacts_dir = str(ci_commit.artifacts_dir)
  return '\n'.join([
    '#!/bin/bash',
    # Tells users how it went, like other batches started from QA-Board
    'trap \'echo "[qaboard] qa batch exited with code $?"\' EXIT',
    'set -ex',
    "export CI=true",
    f"export GIT_COMMIT={quote(ci_commit.hexsha)}",
    f"export QA_OUTPUTS_COMMIT={quote(outputs_dir_prefix)}",
    # backward compatibility with previous qa versions, remove later...
    f"export QATOOLS_CI_COMMIT_DIR={quote(outputs_dir_prefix)}",
    "export QABOARD_TUNING=true",
    f'export QA_BATCH_COMMAND_ID={quote(command_id)}',
    "",
    # get the env right
    'umask 0',
    f'mkdir -p {quote(artifacts_dir)}',
    f'cd {quote(artifacts_dir)}',
    'set +ex',
    '[[ -f ".envrc" ]] && source .envrc',
    '[[ -f "../.envrc" ]] && source ../.envrc',
    '[[ -f "../../.envrc" ]] && source ../../.envrc',
    '[[ -f "../../../.envrc" ]] && source ../../../.envrc',
    'set -ex',
    "",
    batch_command,
    "",
  ])


def redo_outputs(batch, outputs, user) -> dict:
  """
  Redo the `outputs` from `batch`, as `user` (the logged-in user who asked).
  Returns the submission (see submissions.py): its status is "done" if `qa batch` could start the runs, "failed" otherwise.
  Raises ValueError (e.g. UnsafePathError) if the user name or folders are not safe to use.
  """
  user = safe_user_name(user)
  ci_commit = batch.ci_commit
  # We run code from there
  check_storage_path(ci_commit.artifacts_dir)
  # in case it was deleted without QA-Board being made aware
  if not ci_commit.artifacts_dir.exists():
    print("Restoring artifacts")
    ci_commit.save_artifacts()

  command_id = str(uuid.uuid4())
  created_at = datetime.datetime.utcnow()
  log_dir = submission_dir(user_batch_dir(batch.batch_dir, user), created_at, command_id)
  # We write and run scripts there
  check_storage_path(log_dir)
  prev_mask = os.umask(0)
  try:
    log_dir.mkdir(parents=True, exist_ok=True)
  finally:
    os.umask(prev_mask)

  runs_path = log_dir / 'runs.json'
  with runs_path.open('w') as f:
    json.dump({"runs": [run_spec(output) for output in outputs]}, f, indent=2, default=str)
  batch_command = ' '.join([
    'qa',
    '--label', quote(batch.label),
    'batch',
    '--no-wait',
    '--action-on-existing=run',
    '--action-on-pending=run',
    '--runs-file', quote(str(runs_path)),
  ])
  script = redo_script(ci_commit, user, command_id, batch_command)
  script_path = log_dir / 'redo.sh'
  with script_path.open('w') as f:
    f.write(script)
  # raises if the user or path are not safe to use in the LSF bridge
  command = lsf_bridge_command(user, script_path)

  submission = {
    "id": command_id,
    "created_at": created_at.isoformat() + 'Z',
    "user": user,
    "kind": "redo",
    "runs": len(outputs),
    # we run `qa batch` and wait for it, directly or via the LSF bridge
    "runner": "bridge" if os.environ.get('QA_RUNNERS_LSF_BRIDGE') else "local",
    "command": batch_command,
    "log_dir": str(log_dir),
    "status": "submitting",
  }
  record_submission(batch, submission)
  db_session.add(batch)
  db_session.commit()

  print(command)
  try:
    with (log_dir / 'log.txt').open('a') as log:
      process = subprocess.run(command, shell=True, stdout=log, stderr=subprocess.STDOUT)
    submission.update({"status": "done" if process.returncode == 0 else "failed", "exit_code": process.returncode})
  except Exception as e:
    submission.update({"status": "failed", "error": str(e)})
  # `qa batch` updated the batch meanwhile
  db_session.refresh(batch)
  record_submission(batch, submission)
  db_session.add(batch)
  db_session.commit()
  return submission


def log_tail(submission, size=4000) -> str:
  """The end of the logs, to tell users why the runs failed to start"""
  try:
    with (Path(submission['log_dir']) / 'log.txt').open(errors='replace') as f:
      return f.read()[-size:]
  except OSError:
    return submission.get('error', '')


def redo_response(batch, outputs, user):
  """The API's response when users ask to redo runs"""
  from flask import jsonify
  if not outputs:
    return jsonify({"error": "There are no runs to redo."}), 400
  try:
    submission = redo_outputs(batch, outputs, user)
  except ValueError as e: # e.g. the user name or folders are not safe to use
    return jsonify({"error": f"{e}"}), 400
  except Exception as e:
    return jsonify({"error": f"{e}"}), 500
  if submission['status'] == 'failed':
    reason = f"qa batch exited with code {submission['exit_code']}" if 'exit_code' in submission else submission.get('error')
    return jsonify({
      "error": f"The runs failed to start ({reason}). Its logs are with the batch's logs.",
      "logs": log_tail(submission),
      "submission": submission,
    }), 500
  return jsonify({"status": "OK", "submission": submission})
