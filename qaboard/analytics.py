"""
Usage analytics for the `qa` CLI: one `cli_command` event per invocation by a person, so that QA-Board's admins see
which commands people use, from which projects, on which versions, and where `qa` fails for them (Admin → Usage).

It never gets in the way: the event is sent when the command ends, from a daemon thread with short timeouts, waited
for at most a second, and nothing is printed whatever happens (except with QA_VERBOSE). Nothing is sent:
- from CI (`config.is_ci`): CI runs are in QA-Board already, we want what people do,
- from the `qa run` and `qa batch` that `qa batch` and `qa optimize` start (notify.is_nested),
- with `qa --offline`, or QA_NO_ANALYTICS set to anything,
- when nothing says where the server is (we don't send to the default localhost server).

Without a token (`qa auth login`, $QABOARD_TOKEN), the user name `qa` runs as is sent: the server records the event
as unverified. See docs/design/usage-analytics.md.
"""
import os
import sys
import time
import platform
import datetime
import threading
from typing import Any, Callable, Dict, Optional

import click

from .notify import is_nested


# How long we wait for the server, and for the sending thread when the command ends
TIMEOUT = (1, 2)
JOIN_TIMEOUT = 1.0

# The invocation: set by the `qa` group callback, read when the command ends
_state: Dict[str, Any] = {}
# `qa auth <subcommand>`
AUTH_SUBCOMMANDS = ('login', 'status', 'logout', 'token')


def enabled(offline: Optional[bool] = None) -> bool:
  """Whether this invocation sends an event, see the module's docstring."""
  if offline is None:
    offline = bool(_state.get('offline'))
  if offline or 'QA_NO_ANALYTICS' in os.environ:
    return False
  from .config import is_ci
  if is_ci:
    return False
  # the `qa run` and `qa batch` that `qa batch` and `qa optimize` start: one event per command people type.
  # As seen when the command started: `qa batch` marks its own environment for its children (QA_BATCH).
  if _state.get('nested', is_nested()):
    return False
  from .api import qaboard_url_source
  return bool(qaboard_url_source)


def start(command: Optional[str], share: bool = False, tuning: bool = False, dryrun: bool = False, offline: bool = False):
  """Called by the `qa` group callback, once the options are parsed"""
  _state.clear()
  _state.update(
    command=command_name(command),
    started_at=time.monotonic(),
    nested=is_nested(),
    share=bool(share), tuning=bool(tuning), dryrun=bool(dryrun), offline=bool(offline),
    properties={},
  )


def note(**properties):
  """Commands add what they know, e.g. `qa batch` its runner. None values are left out."""
  _state.setdefault('properties', {}).update({k: v for k, v in properties.items() if v is not None})


def command_name(command: Optional[str], argv=None) -> Optional[str]:
  """The subcommand, with `qa auth login` as auth_login"""
  if command != 'auth':
    return command
  argv = sys.argv[1:] if argv is None else argv
  try:
    after = argv[argv.index('auth') + 1:]
  except ValueError:
    return command
  # options may take values (--server x): we look for the subcommands we know
  subcommand = next((arg for arg in after if arg in AUTH_SUBCOMMANDS), None)
  return f"auth_{subcommand}" if subcommand else command


def project_id() -> Optional[str]:
  """The project as the server knows it: what `qa` sends as the batches' project (config.project, as a posix path)"""
  from .api import project_name
  return project_name()


def event(command: Optional[str], started_at: Optional[float], exit_code: Optional[int], properties: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
  """The `cli_command` event, see the catalog in docs/design/usage-analytics.md"""
  from qaboard import __version__
  if not isinstance(exit_code, int) or isinstance(exit_code, bool):
    exit_code = 0 if exit_code is None else 1
  duration = round(time.monotonic() - started_at, 1) if started_at is not None else None
  return {
    "event": "cli_command",
    "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='milliseconds').replace('+00:00', 'Z'),
    "project_id": project_id(),
    "properties": {
      "command": command,
      "version": __version__,
      "python": f"{sys.version_info.major}.{sys.version_info.minor}",
      "os": platform.system().lower(),
      "share": bool(_state.get('share')),
      "tuning": bool(_state.get('tuning')),
      "dryrun": bool(_state.get('dryrun')),
      "duration_s": duration,
      "exit_code": exit_code,
      **(properties or {}),
    },
  }


def payload(event_: Dict[str, Any]) -> Dict[str, Any]:
  from .config import user
  return {"source": "cli", "user_name": user, "events": [event_]}


def send(payload_: Dict[str, Any]) -> None:
  """POSTs the events to the server. Never raises, never prints (except with QA_VERBOSE)."""
  try:
    import json
    import requests
    from .api import api_prefix, headers, api_verify
    url = f"{api_prefix}/events"
    if 'QA_VERBOSE' in os.environ:
      click.secho(f"analytics: POST {url} {json.dumps(payload_)}", fg='cyan', dim=True, err=True)
    r = requests.post(url, data=json.dumps(payload_), headers=headers, verify=api_verify, timeout=TIMEOUT)
    if 'QA_VERBOSE' in os.environ:
      click.secho(f"analytics: {r.status_code}", fg='cyan', dim=True, err=True)
  except Exception as e:
    if 'QA_VERBOSE' in os.environ:
      try:
        click.secho(f"analytics: not sent ({e})", fg='cyan', dim=True, err=True)
      except Exception:
        pass


# What `finish` sends with, replaced in tests
_sender: Callable[[Dict[str, Any]], None] = send


def finish(exit_code: Optional[int] = None) -> None:
  """
  Called once when the command ends: sends the event from a daemon thread, waits for it at most JOIN_TIMEOUT.
  Idempotent, and it never raises: `qa` exits with its own code whatever happens here.
  """
  try:
    if not _state or _state.get('finished'):
      return
    _state['finished'] = True
    if not enabled():
      return
    payload_ = payload(event(_state.get('command'), _state.get('started_at'), exit_code, _state.get('properties')))
    thread = threading.Thread(target=_sender, args=(payload_,), daemon=True, name='qa-analytics')
    thread.start()
    thread.join(timeout=JOIN_TIMEOUT)
  except Exception:
    pass
