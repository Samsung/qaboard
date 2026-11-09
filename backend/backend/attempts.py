"""
Runs that were done again: `qa` saves each attempt in its own directory (qaboard/attempts.py,
docs/rfcs/rerun-directories.md), and tells us where the run is. A run keeps one row, with its latest attempt's results.

We keep in the run's data:
- `attempt`: the number of the attempt whose results we have, when it's over 1;
- `previous_attempts`: what we knew of the attempts it replaced, the last MAX_PREVIOUS_ATTEMPTS. Not their metrics:
  people run again after they changed their code or fixed a machine, an earlier attempt measured something else.
"""
from typing import Any, Dict, Optional

from qaboard.attempts import attempt_of, forget

MAX_PREVIOUS_ATTEMPTS = 10


def iso_utc(date) -> Optional[str]:
  return f"{date.isoformat()}Z" if date else None


def attempt_summary(output) -> Dict[str, Any]:
  """What the row says of the attempt it holds, before a new attempt replaces it."""
  if getattr(output, 'is_pending', False):
    status = 'unfinished'  # still queued or running, or it was killed before it said how it ended
  else:
    status = 'failed' if getattr(output, 'is_failed', False) else 'success'
  data = getattr(output, 'data', None) or {}
  started_at = getattr(output, 'started_at', None) or getattr(output, 'queued_at', None) or getattr(output, 'created_date', None)
  summary = {
    "attempt": attempt_of(output.output_dir_override),
    "status": status,
    "started_at": iso_utc(started_at),
    "finished_at": iso_utc(getattr(output, 'finished_at', None)) if status != 'unfinished' else None,
    "user": data.get('user'),
  }
  return {k: v for k, v in summary.items() if v is not None}


def record_attempt(output, output_directory: Optional[str]) -> None:
  """
  Call it when a run says where it is, before anything else of the row changes.
  A run that moves to another directory starts a new attempt: we keep a summary of the one it replaces.
  """
  if not output_directory:
    return
  data = dict(getattr(output, 'data', None) or {})
  previous_directory = getattr(output, 'output_dir_override', None)
  is_saved = getattr(output, 'id', None) is not None
  if is_saved and previous_directory and str(previous_directory) != str(output_directory):
    previous_attempts = [a for a in data.get('previous_attempts') or [] if isinstance(a, dict)]
    data['previous_attempts'] = [*previous_attempts, attempt_summary(output)][-MAX_PREVIOUS_ATTEMPTS:]
  attempt = attempt_of(output_directory)
  if attempt > 1:
    data['attempt'] = attempt
  else:
    data.pop('attempt', None)
  output.data = data


def forget_attempts(output_dir) -> None:
  """After a run's folder was removed for good: the first attempt's folder goes too, if only latest_attempt.txt is left in it."""
  from .fs_utils import rm_empty_parents
  first_dir = forget(output_dir)
  if first_dir is not None:
    rm_empty_parents(first_dir)
