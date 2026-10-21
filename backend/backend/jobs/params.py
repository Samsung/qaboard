"""
What admins can ask jobs, validated the same way from the API, schedules and the command line.
Projects are selected with globs on their ids: `*` matches anything, including "/", so "CDE-Users/HW_ALG*" is
the project and its subprojects.
"""
import re
import fnmatch
import datetime
from typing import Optional, List

from ..durations import parse_time


class ParamsError(ValueError):
  pass


MAX_PATTERNS = 100


def globs(value, name: str, default: Optional[List[str]] = None) -> List[str]:
  if value is None or value == '' or value == []:
    return list(default or [])
  if isinstance(value, str):
    # "a, b" or one per line
    value = [v for v in re.split(r'[\n,]', value)]
  if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
    raise ParamsError(f"`{name}` must be a list of project patterns, like [\"my-project*\"]")
  patterns = [v.strip() for v in value if v.strip()]
  if len(patterns) > MAX_PATTERNS:
    raise ParamsError(f"`{name}`: at most {MAX_PATTERNS} patterns")
  return patterns


def matches(project_id: str, include: List[str], exclude: List[str]) -> bool:
  return any(fnmatch.fnmatchcase(project_id, p) for p in include) and not any(fnmatch.fnmatchcase(project_id, p) for p in exclude)


def duration(value, name: str) -> Optional[str]:
  """e.g. "1month", "2weeks 3days" """
  if value is None or value == '':
    return None
  if not isinstance(value, str) or not value.strip():
    raise ParamsError(f"`{name}` must be a duration, like 1month or 2weeks")
  try:
    if parse_time(value.strip()) <= datetime.timedelta(0):
      raise ValueError()
  except (AssertionError, ValueError, TypeError):
    raise ParamsError(f"`{name}`: {value!r} is not a duration, use e.g. 3days, 2weeks, 1month, 1year")
  return value.strip()


def date_or_duration(value, name: str) -> Optional[str]:
  """A date (2026-01-31, in UTC) or a duration before the job starts (3months)"""
  if value is None or value == '':
    return None
  if not isinstance(value, str):
    raise ParamsError(f"`{name}` must be a date (2026-01-31) or a duration (3months)")
  value = value.strip()
  try:
    to_datetime(value, datetime.datetime(2000, 1, 1))
  except ValueError:
    raise ParamsError(f"`{name}`: {value!r} is neither a date like 2026-01-31 nor a duration like 3months")
  return value


def to_datetime(value: Optional[str], now: datetime.datetime) -> Optional[datetime.datetime]:
  """Naive UTC, like the database's dates"""
  if not value:
    return None
  if re.match(r'^\d{4}-\d{2}-\d{2}', value):
    date = datetime.datetime.fromisoformat(value.replace('Z', '+00:00'))
    if date.tzinfo is not None:
      date = date.astimezone(datetime.timezone.utc).replace(tzinfo=None)
    return date
  try:
    delta = parse_time(value)
  except AssertionError:
    raise ValueError(f"not a date or duration: {value}")
  if delta <= datetime.timedelta(0):
    raise ValueError(f"not a duration: {value}")
  return now - delta


def boolean(value, name: str, default=False) -> bool:
  if value is None:
    return default
  if not isinstance(value, bool):
    raise ParamsError(f"`{name}` must be true or false")
  return value


def known_keys(params: dict, keys) -> None:
  if not isinstance(params, dict):
    raise ParamsError("The job's parameters must be an object")
  unknown = sorted(set(params) - set(keys))
  if unknown:
    raise ParamsError(f"Unknown parameters: {', '.join(unknown)}")
