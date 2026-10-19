"""
QA-Board emails users when the runs of their `qa batch` end. On by default, `export QA_NOTIFY=none` turns it off.
QA-Board's server knows when the last run ends, see backend/notifications/ in QA-Board's repository.

We never ask in CI, for `qa batch` commands started by other ones (e.g. pipeline steps, `qa optimize` iterations:
their runs count as the first command's), or for batches started from QA-Board (it asks itself).
The runners forward the environment to runs, so nested commands know the first one from QA_BATCH_ROOT_COMMAND_ID.
"""
import os
from typing import Optional

import click


off_values = ('0', 'false', 'no', 'none', 'off')


def is_nested(environ=os.environ) -> bool:
  """Whether this `qa batch` was started by another one, or by `qa optimize`"""
  return bool(environ.get('QA_BATCH_ROOT_COMMAND_ID') or environ.get('QA_BATCH'))


def inherit_root_command(ctx, root_command_id):
  """
  The commands this one starts (their processes inherit the environment) know their runs are part of it.
  Until the command ends: e.g. other `qa batch` invoked later in the same Python process are not nested.
  """
  previous = os.environ.get('QA_BATCH_ROOT_COMMAND_ID')
  os.environ['QA_BATCH_ROOT_COMMAND_ID'] = root_command_id
  def restore():
    if previous is None:
      os.environ.pop('QA_BATCH_ROOT_COMMAND_ID', None)
    else:
      os.environ['QA_BATCH_ROOT_COMMAND_ID'] = previous
  ctx.call_on_close(restore)


def notify_channel(is_ci: bool, nested: bool, started_by_qaboard: bool, environ=os.environ) -> Optional[str]:
  """"email" if users get an email when the batch ends (the default), else None"""
  value = (environ.get('QA_NOTIFY') or 'email').strip().lower()
  if value in off_values:
    return None
  if value != 'email':
    click.secho(f"WARNING: QA_NOTIFY={value} is not supported, only QA_NOTIFY=email (the default) or none", fg='yellow', err=True)
    return None
  if is_ci or nested or started_by_qaboard:
    return None
  return 'email'


def print_notification(notification):
  """What QA-Board answered when `qa batch` asked to notify the user"""
  if not notification:
    return
  if notification.get('error'):
    click.secho(f"QA_NOTIFY: {notification['error']}", fg='yellow', err=True)
  elif notification.get('recipient'):
    click.secho(f"QA-Board will email {notification['recipient']} when the runs end (`export QA_NOTIFY=none` to stop).", dim=True, err=True)
