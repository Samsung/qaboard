"""
Redo runs from QA-Board.

We start a single `qa batch --runs-file` for all the runs we redo, so that the runner settings of the batch apply
to them together, e.g. how many runs are in flight (concurrency). Like other batches started from QA-Board,
its script, the list of runs and the logs are saved in the batch directory, and users see them with the batch's logs.

With QABOARD_TUNING_RUNNER=kubernetes, `qa batch` runs in a pod, like batches started from the web app
(runner_jobs.submit_driver), and we don't wait for it. With the LSF bridge, we run it there and wait. Otherwise it runs on
the server, detached like batches started from the web app with the local runner (local_jobs.py): the request doesn't
wait for it, and it gets the server's environment minus its secrets.

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
from .fs_utils import mkdir_shared
from .artifacts import ArtifactsUnavailable
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
def _is_runner(value) -> bool:
  # Kubernetes runs only when the server starts `qa batch` there too: its pod's ServiceAccount, not the server's
  # credentials, may create them. Otherwise they'd run as the server's user (run_as: user).
  return value in ("lsf", "dask", "local", "celery") or (value == "kubernetes" and os.environ.get('QABOARD_TUNING_RUNNER') == 'kubernetes')

SAFE_JOB_OPTIONS = {
  "type": _is_runner,
  "concurrency": _is_int,
  "timeout": _is_number,
  # Kubernetes: the namespace, image... come from qaboard.yaml
  "runs_per_pod": _is_int,
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


def output_runner(output):
  job_options = (output.data or {}).get("job_options")
  return job_options.get("type") if isinstance(job_options, dict) else None


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


def redo_outputs(batch, outputs, user_info) -> dict:
  """
  Redo the `outputs` from `batch`, as `user_info` (the logged-in user who asked, g.user).
  Returns the submission (see submissions.py): its status is "done" if `qa batch` could start the runs, "failed" otherwise,
  "submitted" when `qa batch` was started in a pod (QABOARD_TUNING_RUNNER=kubernetes) or still runs on the server.
  Raises ValueError (e.g. UnsafePathError) if the user name or folders are not safe to use.
  """
  user = safe_user_name(user_info['user_name'])
  ci_commit = batch.ci_commit
  # We run code from there
  check_storage_path(ci_commit.artifacts_dir)
  # We never run from missing artifacts: e.g. without its qaboard.yaml, a subproject's runs would be saved in the parent project.
  # Raises ArtifactsUnavailable if they are missing and can't be restored right now.
  restored = ci_commit.ensure_artifacts(user=user_info)

  command_id = str(uuid.uuid4())
  created_at = datetime.datetime.utcnow()
  log_dir = submission_dir(user_batch_dir(batch.batch_dir, user), created_at, command_id)
  # We write and run scripts there
  check_storage_path(log_dir)
  # users' `qa batch` writes there under their own accounts
  mkdir_shared(log_dir)

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
  on_kubernetes = os.environ.get('QABOARD_TUNING_RUNNER') == 'kubernetes'
  # raises if the user or path are not safe to use in the LSF bridge
  command = None if on_kubernetes else lsf_bridge_command(user, script_path)

  submission = {
    "id": command_id,
    "created_at": created_at.isoformat() + 'Z',
    "user": user,
    "kind": "redo",
    "runs": len(outputs),
    # we run `qa batch` via the LSF bridge and wait for it, or start it on the server (detached) or in a pod
    "runner": "kubernetes" if on_kubernetes else "bridge" if os.environ.get('QA_RUNNERS_LSF_BRIDGE') else "local",
    "command": batch_command,
    "log_dir": str(log_dir),
    "status": "submitting",
  }
  if restored:
    # e.g. only the source files could be restored, or some files are missing
    submission["warning"] = restored["message"]
  record_submission(batch, submission)
  db_session.add(batch)
  db_session.commit()

  try:
    if on_kubernetes:
      from .runner_jobs import submit_driver
      def record_driver(driver):
        # before it's submitted: the batch can be stopped whatever happens next
        submission.update(driver)
        record_submission(batch, submission)
        db_session.add(batch)
        db_session.commit()
      submission.update(submit_driver(script_path, log_dir, user_info, ci_commit, command_id, on_prepared=record_driver))
      submission["status"] = "submitted"
    elif os.environ.get('QA_RUNNERS_LSF_BRIDGE'):
      print(command)
      with (log_dir / 'log.txt').open('a') as log:
        process = subprocess.run(command, shell=True, stdout=log, stderr=subprocess.STDOUT)
      submission.update({"status": "done" if process.returncode == 0 else "failed", "exit_code": process.returncode})
    else:
      from .local_jobs import start_detached, qa_environment, project_uses_celery
      # the runs are done again with their runner: they may need the broker
      celery = (os.environ.get('QABOARD_TUNING_RUNNER') == 'celery' or project_uses_celery(ci_commit)
                or any(output_runner(output) == 'celery' for output in outputs))
      submission.update(start_detached(script_path, log_dir, qa_environment(command_id, celery=celery)))
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


def redo_response(batch, outputs, user_info):
  """The API's response when users ask to redo runs"""
  from flask import jsonify
  if not outputs:
    return jsonify({"error": "There are no runs to redo."}), 400
  try:
    submission = redo_outputs(batch, outputs, user_info)
  except ArtifactsUnavailable as e:
    # we remember that the artifacts are missing, and that we asked to recreate them
    db_session.add(batch.ci_commit)
    db_session.commit()
    return jsonify(e.to_dict()), 409
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
  return jsonify({"status": "OK", "submission": submission, "warning": submission.get("warning")})
