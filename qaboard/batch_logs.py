"""
`qa batch` and `qa optimize` started from a terminal with --share save their logs in the batch directory,
QA-Board shows them with the batch. We don't save them when they are already saved elsewhere:
by the CI, by QA-Board for the batches it starts, or by `qa optimize` for its iterations.
"""
import os
import sys
import uuid
import datetime
import functools
import subprocess
from pathlib import Path
from typing import Optional

import click

from .config import is_ci
from .utils import tee_std_streams


# ctx.meta[BATCH_LOG] is {"command_id", "path"}, with the path relative to the batch directory
BATCH_LOG = 'qaboard.batch_log'


def should_save_logs(ctx: click.Context) -> bool:
  obj = ctx.obj
  if is_ci:
    return False
  # QA-Board won't know about the batch
  if not obj.get('share') or obj.get('offline') or obj.get('dryrun'):
    return False
  # e.g. `qa batch --list`
  if any(ctx.params.get(flag) for flag in ('list_contexts', 'list_output_dirs', 'list_inputs')):
    return False
  # An iteration of `qa optimize`, our output is in its log (see run_in_log)
  if 'QA_OPTIM_DIR' in os.environ:
    return False
  return not (os.environ.get('QA_BATCH_COMMAND_HIDE_LOGS') or os.environ.get('QA_NO_STREAM_REDIRECT'))


def saves_logs(command):
  """Decorates `qa batch` and `qa optimize`: when needed, saves what they print in the batch directory."""
  @functools.wraps(command)
  def wrapper(ctx, *args, **kwargs):
    if not should_save_logs(ctx):
      return command(ctx, *args, **kwargs)
    command_id = str(uuid.uuid4())
    created_at = datetime.datetime.now(datetime.timezone.utc)
    path = f"qa-batch-logs/{created_at.strftime('%Y%m%d-%H%M%S')}-{command_id[:8]}/log.txt"
    log_path = Path(ctx.obj['batch_dir']) / path
    try:
      log_path.parent.mkdir(parents=True, exist_ok=True)
      file = log_path.open('a', encoding='utf-8', errors='replace')
    except OSError as e:
      click.secho(f"WARNING: Could not save the logs in {log_path} ({e})", fg='yellow', err=True)
      return command(ctx, *args, **kwargs)
    ctx.meta[BATCH_LOG] = {"command_id": command_id, "path": path}
    with file, tee_std_streams(file):
      return command(ctx, *args, **kwargs)
  return wrapper


def batch_log(ctx: click.Context) -> Optional[dict]:
  return ctx.meta.get(BATCH_LOG)


def run_in_log(command: str) -> int:
  """
  Runs a shell command, and prints its output ourselves: it ends up in our saved logs.
  Otherwise subprocesses write to the terminal directly. Returns the exit code.
  """
  with subprocess.Popen(
    command,
    shell=True,
    stdout=subprocess.PIPE,
    stderr=subprocess.STDOUT,
    encoding='utf-8',
    errors='replace',
    # we want to see the output as it's printed
    env={**os.environ, 'PYTHONUNBUFFERED': '1'},
  ) as process:
    assert process.stdout
    for line in process.stdout:
      sys.stdout.write(line)
  return process.returncode
