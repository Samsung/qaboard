"""
Cron expressions for job schedules: "minute hour day-of-month month day-of-week", e.g. "30 2 * * 1-5".
Fields support `*`, lists (1,15), ranges (1-5), steps (*/15, 0-30/10) and names (mon, jan).
Like cron, when both the day of month and the day of week are restricted, either can match.
"""
import datetime
from typing import Optional
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError


FIELDS = (
  # name, min, max, names
  ('minute', 0, 59, None),
  ('hour', 0, 23, None),
  ('day of month', 1, 31, None),
  ('month', 1, 12, ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']),
  ('day of week', 0, 7, ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']),
)
ALIASES = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
}


class CronError(ValueError):
  pass


def _value(text: str, name: str, low: int, high: int, names) -> int:
  if names and text.lower() in names:
    # names start at the field's minimum (jan=1, sun=0)
    return names.index(text.lower()) + (1 if name == 'month' else 0)
  try:
    value = int(text)
  except ValueError:
    raise CronError(f"Invalid {name}: {text!r}")
  if not low <= value <= high:
    raise CronError(f"The {name} must be between {low} and {high}, not {value}")
  return value


def _field(text: str, name: str, low: int, high: int, names) -> set:
  values = set()
  for part in text.split(','):
    if not part:
      raise CronError(f"Invalid {name}: {text!r}")
    step = 1
    if '/' in part:
      part, step_text = part.split('/', 1)
      try:
        step = int(step_text)
      except ValueError:
        raise CronError(f"Invalid step in the {name}: {step_text!r}")
      if step < 1:
        raise CronError(f"Invalid step in the {name}: {step}")
    if part == '*':
      start, end = low, high
    elif '-' in part:
      start_text, end_text = part.split('-', 1)
      start, end = _value(start_text, name, low, high, names), _value(end_text, name, low, high, names)
      if start > end:
        raise CronError(f"Invalid range in the {name}: {part}")
    else:
      start = _value(part, name, low, high, names)
      # "5/10": from 5, every 10
      end = high if step > 1 else start
    values.update(range(start, end + 1, step))
  return values


class Cron:
  def __init__(self, expression: str):
    if not isinstance(expression, str) or not expression.strip():
      raise CronError("The schedule is empty")
    expression = ALIASES.get(expression.strip().lower(), expression)
    parts = expression.split()
    if len(parts) != 5:
      raise CronError(f"Expected 5 fields (minute hour day-of-month month day-of-week), got {len(parts)}: {expression!r}")
    self.minutes, self.hours, self.days, self.months, weekdays = [_field(p, *f) for p, f in zip(parts, FIELDS)]
    # 7 is also Sunday
    self.weekdays = {d % 7 for d in weekdays}
    self.any_day = parts[2] == '*'
    self.any_weekday = parts[4] == '*'

  def _day_matches(self, day: datetime.date) -> bool:
    if day.month not in self.months:
      return False
    in_month = day.day in self.days
    # isoweekday: Monday=1..Sunday=7
    in_week = day.isoweekday() % 7 in self.weekdays
    if self.any_day and self.any_weekday:
      return True
    if self.any_day:
      return in_week
    if self.any_weekday:
      return in_month
    return in_month or in_week

  def next_after(self, after: datetime.datetime) -> datetime.datetime:
    """The first time strictly after `after`, a naive or aware datetime, in the same timezone"""
    start = after.replace(second=0, microsecond=0) + datetime.timedelta(minutes=1)
    day = start.date()
    # leap days on a Sunday may be years away
    for _ in range(366 * 8):
      if self._day_matches(day):
        for hour in sorted(self.hours):
          for minute in sorted(self.minutes):
            candidate = datetime.datetime.combine(day, datetime.time(hour, minute), tzinfo=start.tzinfo)
            if candidate >= start:
              return candidate
      day += datetime.timedelta(days=1)
    raise CronError("This schedule never runs")


def timezone(name: Optional[str]) -> ZoneInfo:
  try:
    return ZoneInfo(name or 'UTC')
  except (ZoneInfoNotFoundError, ValueError):
    raise CronError(f"Unknown time zone: {name!r}, use names like UTC or Europe/Paris")


def next_run(expression: str, tz_name: str, after_utc: datetime.datetime) -> datetime.datetime:
  """The next run after `after_utc` (naive UTC), as naive UTC, with the cron expression read in the time zone"""
  tz = timezone(tz_name)
  local = after_utc.replace(tzinfo=datetime.timezone.utc).astimezone(tz)
  candidate = Cron(expression).next_after(local)
  # normalizes times that don't exist (DST gaps) or happen twice (we take the first)
  return candidate.astimezone(datetime.timezone.utc).replace(tzinfo=None)


WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']


def describe(expression: str, tz_name: str = 'UTC') -> str:
  """ "0 2 * * *" => "every day at 02:00 (UTC)". Falls back to the expression when it's not a simple one."""
  try:
    cron = Cron(expression)
  except CronError:
    return expression
  at = ''
  if len(cron.hours) == 1 and len(cron.minutes) == 1:
    at = f" at {min(cron.hours):02d}:{min(cron.minutes):02d} ({tz_name})"
  elif len(cron.hours) == 24 and len(cron.minutes) == 1:
    return f"every hour at :{min(cron.minutes):02d}"
  else:
    return f"on the schedule \"{expression}\" ({tz_name})"
  every_month = len(cron.months) == 12
  if cron.any_day and cron.any_weekday and every_month:
    return f"every day{at}"
  if cron.any_day and every_month and not cron.any_weekday:
    days = [WEEKDAYS[d] for d in sorted(cron.weekdays)]
    if days == WEEKDAYS[1:6]:
      return f"every weekday{at}"
    return f"every {', '.join(days)}{at}"
  if cron.any_weekday and every_month and len(cron.days) == 1:
    day = min(cron.days)
    suffix = 'th' if 11 <= day <= 13 else {1: 'st', 2: 'nd', 3: 'rd'}.get(day % 10, 'th')
    return f"on the {day}{suffix} of every month{at}"
  return f"on the schedule \"{expression}\" ({tz_name})"
