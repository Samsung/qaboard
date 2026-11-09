"""
Runs that were done again: a ledger of their attempts. A run keeps one row, with its latest attempt's results.

`qa` saves each attempt of a shared run in its own directory (qaboard/attempts.py, docs/rfcs/rerun-directories.md),
and tells us where the run is. Some runs are still done again in place: local ones, projects that opt out, older `qa`.

We keep in the run's data:
- `attempt`: the number of the attempt whose results we have, when it's over 1;
- `previous_attempts`: what we knew of the attempts it replaced, the last MAX_PREVIOUS_ATTEMPTS: how they ended,
  when, who ran them, and their metrics. `in_place` marks those whose files were replaced where they were: what
  viewers show from that directory may come from a cache.
The earlier attempts' metrics are a record, not samples: people run again after they changed their code or fixed a
machine, an earlier attempt often measured something else.
"""
from typing import Any, Dict, Optional

from qaboard.attempts import attempt_of, forget

MAX_PREVIOUS_ATTEMPTS = 10
# What we keep of an earlier attempt's metrics: plain values, not too many
MAX_METRICS = 300
MAX_TEXT = 200


def iso_utc(date) -> Optional[str]:
  return f"{date.isoformat()}Z" if date else None


def kept_metrics(metrics) -> Dict[str, Any]:
  if not isinstance(metrics, dict):
    return {}
  kept = {}
  for key, value in metrics.items():
    if isinstance(value, (bool, int, float)) or value is None or (isinstance(value, str) and len(value) <= MAX_TEXT):
      kept[key] = value
    if len(kept) >= MAX_METRICS:
      break
  return kept


def attempt_summary(output) -> Dict[str, Any]:
  """What the row says of the attempt it holds, before a new attempt replaces it."""
  if getattr(output, 'is_pending', False):
    status = 'unfinished'  # still queued or running, or it was killed before it said how it ended
  else:
    status = 'failed' if getattr(output, 'is_failed', False) else 'success'
  data = getattr(output, 'data', None) or {}
  started_at = getattr(output, 'started_at', None) or getattr(output, 'queued_at', None) or getattr(output, 'created_date', None)
  summary = {
    "attempt": attempt_of(output.output_dir_override) if getattr(output, 'output_dir_override', None) else 1,
    "status": status,
    "started_at": iso_utc(started_at),
    "finished_at": iso_utc(getattr(output, 'finished_at', None)) if status != 'unfinished' else None,
    "user": data.get('user'),
    # a run that didn't finish has the metrics of the attempt before it, if any: they're not its own
    "metrics": (kept_metrics(getattr(output, 'metrics', None)) or None) if status != 'unfinished' else None,
  }
  return {k: v for k, v in summary.items() if v is not None}


def record_attempt(output, output_directory: Optional[str], is_pending: bool = False) -> None:
  """
  Call it when a run reports its status, before anything else of the row changes.
  A run starts a new attempt when it moves to another directory, or when it starts again where it was after it
  ended (`is_pending`: the status it reports): we keep a summary of the attempt it replaces.
  """
  data = dict(getattr(output, 'data', None) or {})
  previous_directory = getattr(output, 'output_dir_override', None)
  is_saved = getattr(output, 'id', None) is not None
  moved = bool(is_saved and output_directory and previous_directory and str(previous_directory) != str(output_directory))
  # `qa batch` says a run is pending, then its `qa run` that it's running: one attempt
  restarted_in_place = bool(is_saved and not moved and is_pending and not getattr(output, 'is_pending', False))
  if moved or restarted_in_place:
    previous_attempts = [a for a in data.get('previous_attempts') or [] if isinstance(a, dict)]
    summary = attempt_summary(output)
    if restarted_in_place:
      summary['in_place'] = True
    data['previous_attempts'] = [*previous_attempts, summary][-MAX_PREVIOUS_ATTEMPTS:]
  if output_directory:
    attempt = attempt_of(output_directory)
    if attempt > 1:
      data['attempt'] = attempt
    else:
      data.pop('attempt', None)
  output.data = data


def reruns_of(output: Dict[str, Any]) -> Optional[Dict[str, Any]]:
  """
  For comparisons and the gate: how many times a run (as the API describes it, Output.to_dict) was done, and how its
  earlier attempts ended. None for runs done once.
  """
  data = output.get('data') or {}
  previous = [a for a in data.get('previous_attempts') or [] if isinstance(a, dict)]
  attempt = data.get('attempt') if isinstance(data.get('attempt'), int) else 1
  if attempt <= 1 and not previous:
    return None
  return {
    "attempt": max(attempt, 1),
    "previous": [a.get('status') or 'unknown' for a in previous],
    "in_place": any(a.get('in_place') for a in previous),
  }


def rerun_counts(outputs) -> Dict[str, int]:
  """
  Among runs (as the API describes them): how many were done again, and how many of those succeeded after an attempt
  that failed, or that never said how it ended. Reviewers want to know when green took several tries.
  """
  counts = {"runs": 0, "after_failure": 0, "after_unfinished": 0}
  for output in outputs:
    reruns = reruns_of(output)
    if not reruns:
      continue
    counts["runs"] += 1
    succeeded = not output.get('is_pending') and not output.get('is_failed')
    if succeeded and 'failed' in reruns['previous']:
      counts["after_failure"] += 1
    elif succeeded and 'unfinished' in reruns['previous']:
      counts["after_unfinished"] += 1
  return counts


def forget_attempts(output_dir) -> None:
  """After a run's folder was removed for good: the first attempt's folder goes too, if only latest_attempt.txt is left in it."""
  from .fs_utils import rm_empty_parents
  first_dir = forget(output_dir)
  if first_dir is not None:
    rm_empty_parents(first_dir)
