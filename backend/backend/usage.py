"""
Usage analytics: what people do in the web app and with the `qa` CLI (docs/design/usage-analytics.md).

The clients send events to POST /api/v1/events (api/usage.py): this module cleans them (names, properties, times,
sizes: a bad event is dropped, never an error), stores them in one insert, and answers the questions of Admin > Usage
with SQL on `usage_events`, bounded by `created_at` and the indexes on (user, created_at), (project, created_at) and
(event, created_at). Nothing here depends on the web framework.

Who did it is the request's actor, never the event's body. The CLI without a token says the user name it runs as:
those events are `verified = false`, and `user_id` is the account with that name, if any. A person is their user id,
or their unverified name: PERSON below.
"""
import re
import math
import datetime
from typing import Dict, Iterable, List, Optional

# What a request may carry
MAX_EVENTS = 100
MAX_BODY_BYTES = 64 * 1024
# ...and an event
MAX_KEYS = 40
MAX_STRING = 200
MAX_LIST = 20
MAX_PROJECT_ID = 500
MAX_CLIENT_ID = 64
# How far from now an event may say it happened
MAX_PAST = datetime.timedelta(days=1)
MAX_FUTURE = datetime.timedelta(minutes=5)

SOURCES = ('webapp', 'cli')
EVENT_NAME = re.compile(r'^[a-z][a-z0-9_]{0,63}$')
PROPERTY_KEY = re.compile(r'^[a-z_][a-z0-9_]{0,63}$')

BATCH_KINDS = ('tuning', 'automated_tuning', 'run_tests', 'redo')


# The SQL of what we count, on the `usage_events` columns (`alias.` when the table has one)

def person(alias: str = '') -> str:
  """Who an event is about: the account, or the unverified name the CLI gave"""
  return f"coalesce({alias}user_id::text, 'name:' || {alias}user_name)"


def commit(alias: str = '') -> str:
  """A commit someone looked at: `page_view` events say which"""
  return f"CASE WHEN {alias}event = 'page_view' AND {alias}properties ? 'commit_id' THEN coalesce({alias}project_id, '') || '@' || ({alias}properties->>'commit_id') END"


def web_batch(alias: str = '') -> str:
  """A batch started from the web app"""
  return f"{alias}event = 'batch_start'"


def cli_batch(alias: str = '') -> str:
  """`qa batch` in a terminal, not a dry run"""
  return f"{alias}event = 'cli_command' AND {alias}properties->>'command' = 'batch' AND {alias}properties->>'dryrun' IS DISTINCT FROM 'true'"


PERSON, COMMIT, WEB_BATCH, CLI_BATCH = person(), commit(), web_batch(), cli_batch()

DEFAULT_DAYS = 30


def utcnow():
  return datetime.datetime.utcnow()


def iso(date: Optional[datetime.datetime]) -> Optional[str]:
  return f"{date.isoformat()}Z" if date else None


# Cleaning what the clients send

_dropped = object()


def clean_value(value):
  """A scalar (strings cut at MAX_STRING, finite numbers, booleans, None) or a short list of those, else `_dropped`"""
  if value is None or isinstance(value, bool):
    return value
  if isinstance(value, str):
    return value[:MAX_STRING]
  if isinstance(value, int):
    return value
  if isinstance(value, float):
    return value if math.isfinite(value) else _dropped
  if isinstance(value, list):
    cleaned = []
    for item in value[:MAX_LIST]:
      if isinstance(item, list):
        continue
      item = clean_value(item)
      if item is not _dropped:
        cleaned.append(item)
    return cleaned
  return _dropped


def clean_properties(raw) -> dict:
  if not isinstance(raw, dict):
    return {}
  properties = {}
  for key, value in raw.items():
    if len(properties) >= MAX_KEYS:
      break
    if not isinstance(key, str) or not PROPERTY_KEY.match(key):
      continue
    value = clean_value(value)
    if value is not _dropped:
      properties[key] = value
  return properties


def parse_timestamp(value, now: datetime.datetime) -> datetime.datetime:
  """When the event happened, naive UTC, clamped to [now - MAX_PAST, now + MAX_FUTURE]. Missing or invalid: now."""
  when = None
  if isinstance(value, str) and value.strip():
    try:
      when = datetime.datetime.fromisoformat(value.strip().replace('Z', '+00:00'))
    except ValueError:
      when = None
  if when is None:
    return now
  if when.tzinfo is not None:
    when = when.astimezone(datetime.timezone.utc).replace(tzinfo=None)
  return max(now - MAX_PAST, min(when, now + MAX_FUTURE))


def clean_text(value, max_length: int) -> Optional[str]:
  if not isinstance(value, str):
    return None
  value = value.strip()[:max_length]
  return value or None


def clean_event(raw, now: Optional[datetime.datetime] = None) -> Optional[dict]:
  """An event as we store it ({event, created_at, project_id, client_id, properties}), or None if it's not one"""
  if not isinstance(raw, dict):
    return None
  name = raw.get('event')
  if not isinstance(name, str) or not EVENT_NAME.match(name):
    return None
  now = now or utcnow()
  return {
    "event": name,
    "created_at": parse_timestamp(raw.get('timestamp'), now),
    "project_id": clean_text(raw.get('project_id'), MAX_PROJECT_ID),
    "client_id": clean_text(raw.get('client_id'), MAX_CLIENT_ID),
    "properties": clean_properties(raw.get('properties')),
  }


def clean_source(value) -> str:
  return value if value in SOURCES else 'webapp'


def find_user_id(user_name: str) -> Optional[int]:
  """The account with this name, for the CLI's unverified events"""
  from .models import User
  from .database import db_session
  row = db_session.query(User.id).filter(User.user_name == user_name).first()
  return row[0] if row else None


def store(events: List[dict], actor=None, source: str = 'webapp', user_name_hint: Optional[str] = None,
          now: Optional[datetime.datetime] = None) -> int:
  """
  Adds cleaned events (clean_event) to the session, in one insert: the caller commits. Returns how many.
  `actor`: the request's (backend/actor.py). Without a user, CLI events are stored unverified, as `user_name_hint`.
  """
  if not events:
    return 0
  from sqlalchemy import insert
  from .models import UsageEvent
  from .database import db_session
  now = now or utcnow()
  source = clean_source(source)
  user = actor.user if actor is not None else None
  if user is not None:
    user_id, user_name, verified = user.id, user.user_name, True
  elif source == 'cli' and user_name_hint:
    user_name = clean_text(user_name_hint, MAX_STRING)
    user_id, verified = find_user_id(user_name), False
  else:
    user_id, user_name, verified = None, None, True
  rows = [{
    "created_at": event['created_at'],
    "received_at": now,
    "source": source,
    "event": event['event'],
    "user_id": user_id,
    "user_name": user_name,
    "verified": verified,
    "client_id": event['client_id'],
    "project_id": event['project_id'],
    "properties": event['properties'],
  } for event in events]
  db_session.execute(insert(UsageEvent), rows)
  return len(rows)


# Periods and filters of the dashboard's queries

class Period:
  """[since, until), and the period of the same length before it, for trends"""
  def __init__(self, since: Optional[datetime.datetime] = None, until: Optional[datetime.datetime] = None,
               now: Optional[datetime.datetime] = None):
    now = now or utcnow()
    self.until = until or now
    self.since = since or self.until - datetime.timedelta(days=DEFAULT_DAYS)
    if self.since >= self.until:
      raise ValueError("`since` must be before `until`")
    self.previous_since = self.since - (self.until - self.since)

  def previous(self) -> 'Period':
    return Period(self.previous_since, self.since)

  def describe(self) -> dict:
    return {"since": iso(self.since), "until": iso(self.until)}


def parse_date(value: Optional[str], end_of_day=False) -> Optional[datetime.datetime]:
  """An ISO date or datetime. A date alone is its midnight, or the next day's for an inclusive `until`."""
  if not value or not str(value).strip():
    return None
  value = str(value).strip()
  try:
    if len(value) == 10:
      day = datetime.date.fromisoformat(value)
      when = datetime.datetime.combine(day, datetime.time())
      return when + datetime.timedelta(days=1) if end_of_day else when
    when = datetime.datetime.fromisoformat(value.replace('Z', '+00:00'))
  except ValueError:
    raise ValueError(f"Not a date: {value!r}. Use YYYY-MM-DD, or an ISO 8601 date and time.")
  if when.tzinfo is not None:
    when = when.astimezone(datetime.timezone.utc).replace(tzinfo=None)
  return when


def like_escape(value: str) -> str:
  return value.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_')


def clean_project(value: Optional[str]) -> Optional[str]:
  value = (value or '').strip().strip('/')
  return value or None


class Filters:
  """The SQL and parameters that select a period's events, maybe of one project or product (`project`)"""
  def __init__(self, period: Period, project: Optional[str] = None, table: str = 'usage_events'):
    self.period = period
    self.project = clean_project(project)
    self.table = table

  def where(self, since='since', until='until', alias='') -> str:
    prefix = f"{alias}." if alias else ''
    sql = f"{prefix}created_at >= :{since} AND {prefix}created_at < :{until}"
    if self.project:
      sql += f" AND ({prefix}project_id = :project OR {prefix}project_id LIKE :project_like ESCAPE '\\')"
    return sql

  def params(self, previous=False) -> dict:
    period = self.period.previous() if previous else self.period
    params = {"since": period.since, "until": period.until}
    if self.project:
      params.update(project=self.project, project_like=like_escape(self.project) + '/%')
    return params

  def ci_where(self, alias_c='c', alias_o='o') -> str:
    """The CI's runs in the period: outputs created then, of batches with origin ci"""
    sql = f"{alias_o}.created_date >= :since AND {alias_o}.created_date < :until AND b.origin = 'ci'"
    if self.project:
      sql += f" AND ({alias_c}.project_id = :project OR {alias_c}.project_id LIKE :project_like ESCAPE '\\')"
    return sql


def execute(sql: str, params: dict):
  from sqlalchemy import text
  from .database import db_session
  return db_session.execute(text(sql), params)


def rows_of(sql: str, params: dict) -> List[dict]:
  return [dict(row._mapping) if hasattr(row, '_mapping') else dict(row) for row in execute(sql, params).fetchall()]


def one_of(sql: str, params: dict) -> dict:
  rows = rows_of(sql, params)
  return rows[0] if rows else {}


# The counts of Admin > Usage

COUNTS = f"""
  count(DISTINCT CASE WHEN source = 'webapp' THEN user_id END) AS web_users,
  count(DISTINCT CASE WHEN source = 'cli' THEN {PERSON} END) AS cli_users,
  count(DISTINCT {PERSON}) AS users,
  count(DISTINCT CASE WHEN source = 'cli' AND NOT verified AND user_id IS NULL THEN user_name END) AS unverified_cli_users,
  count(DISTINCT {COMMIT}) AS commits_viewed,
  count(*) FILTER (WHERE event = 'commit_compare') AS comparisons,
  count(*) FILTER (WHERE event = 'output_open') AS outputs_opened,
  count(*) FILTER (WHERE event = 'image_viewer_use') AS image_viewer_uses,
  count(*) FILTER (WHERE {WEB_BATCH}) AS web_batches,
  count(*) FILTER (WHERE {CLI_BATCH}) AS cli_batches,
""" + "".join(f"  count(*) FILTER (WHERE event = 'batch_start' AND properties->>'kind' = '{kind}') AS batches_{kind},\n" for kind in BATCH_KINDS) + """
  count(*) FILTER (WHERE event = 'cli_command') AS cli_commands,
  count(*) FILTER (WHERE event = 'export_start') AS exports,
  count(*) FILTER (WHERE event = 'milestone_save') AS milestones,
  count(*) AS events
"""

NEW_USERS = f"""
  SELECT count(*) AS new_users FROM (
    SELECT user_id, user_name FROM usage_events WHERE {{where}} AND (user_id IS NOT NULL OR user_name IS NOT NULL)
    GROUP BY user_id, user_name
  ) p
  WHERE NOT EXISTS (
    SELECT 1 FROM usage_events e WHERE e.created_at < :since
    AND ((p.user_id IS NOT NULL AND e.user_id = p.user_id) OR (p.user_id IS NULL AND e.user_id IS NULL AND e.user_name = p.user_name))
  )
"""

CI_RUNS = """
  SELECT count(*) AS ci_runs FROM outputs o
  JOIN batches b ON b.id = o.batch_id
  JOIN ci_commits c ON c.id = b.ci_commit_id
  WHERE {where}
"""


def counts(filters: Filters, previous=False) -> dict:
  params = filters.params(previous)
  row = one_of(f"SELECT {COUNTS} FROM usage_events WHERE {filters.where()}", params)
  row = {k: int(v or 0) for k, v in row.items()}
  by_kind = {kind: row.pop(f'batches_{kind}', 0) for kind in BATCH_KINDS}
  by_kind['cli'] = row.pop('cli_batches', 0)
  row['batches_started'] = row.pop('web_batches', 0) + by_kind['cli']
  row['batches_started_by_kind'] = by_kind
  row['new_users'] = int(one_of(NEW_USERS.format(where=filters.where()), params).get('new_users') or 0)
  row['ci_runs'] = int(one_of(CI_RUNS.format(where=filters.ci_where()), params).get('ci_runs') or 0)
  return row


def summary(filters: Filters) -> dict:
  return {**filters.period.describe(), "project": filters.project,
          "counts": counts(filters), "previous_counts": counts(filters, previous=True)}


# Trends

BUCKETS = ('day', 'week')

TIMESERIES = f"""
  SELECT date_trunc(:bucket, created_at) AS start,
    count(DISTINCT CASE WHEN source = 'webapp' THEN user_id END) AS web_users,
    count(DISTINCT CASE WHEN source = 'cli' THEN {PERSON} END) AS cli_users,
    count(DISTINCT {COMMIT}) AS commits_viewed,
    count(*) FILTER (WHERE event = 'output_open') AS outputs_opened,
    count(*) FILTER (WHERE ({WEB_BATCH}) OR ({CLI_BATCH})) AS batches_started,
    count(*) FILTER (WHERE event = 'cli_command') AS cli_commands
  FROM usage_events WHERE {{where}}
  GROUP BY 1 ORDER BY 1
"""
TIMESERIES_FIELDS = ('web_users', 'cli_users', 'commits_viewed', 'outputs_opened', 'batches_started', 'cli_commands')


def bucket_start(when: datetime.datetime, bucket: str) -> datetime.datetime:
  day = datetime.datetime.combine(when.date(), datetime.time())
  if bucket == 'week':
    day -= datetime.timedelta(days=day.weekday())  # Monday, like date_trunc
  return day


def timeseries(filters: Filters, bucket: str = 'day') -> List[dict]:
  """One row per bucket of the period, also the empty ones"""
  if bucket not in BUCKETS:
    raise ValueError(f"`bucket` must be one of {', '.join(BUCKETS)}")
  found = {row['start']: row for row in rows_of(TIMESERIES.format(where=filters.where()), {**filters.params(), "bucket": bucket})}
  buckets = []
  start = bucket_start(filters.period.since, bucket)
  step = datetime.timedelta(days=7 if bucket == 'week' else 1)
  while start < filters.period.until:
    row = found.get(start, {})
    buckets.append({"start": iso(start), **{field: int(row.get(field) or 0) for field in TIMESERIES_FIELDS}})
    start += step
  return buckets


# Leaderboards

USERS = f"""
  SELECT {PERSON} AS person, max(user_id) AS user_id, max(user_name) AS user_name, bool_or(verified) AS verified,
    count(DISTINCT created_at::date) AS active_days,
    count(*) FILTER (WHERE source = 'webapp') AS web_events,
    count(*) FILTER (WHERE event = 'cli_command') AS cli_commands,
    count(DISTINCT {COMMIT}) AS commits_viewed,
    count(*) FILTER (WHERE ({WEB_BATCH}) OR ({CLI_BATCH})) AS batches_started,
    count(*) AS events, max(created_at) AS last_seen_at
  FROM usage_events WHERE {{where}} AND (user_id IS NOT NULL OR user_name IS NOT NULL)
  GROUP BY 1 ORDER BY active_days DESC, events DESC, last_seen_at DESC
  LIMIT :limit
"""

USER_PROJECTS = f"""
  SELECT {PERSON} AS person, project_id, count(*) AS events
  FROM usage_events WHERE {{where}} AND project_id IS NOT NULL AND (user_id IS NOT NULL OR user_name IS NOT NULL)
  GROUP BY 1, 2
"""

TOP_PROJECTS = 3


def accounts(user_ids: Iterable[int]) -> Dict[int, dict]:
  user_ids = [u for u in set(user_ids) if u is not None]
  if not user_ids:
    return {}
  rows = rows_of("SELECT id, user_name, full_name FROM users WHERE id IN :ids", {"ids": tuple(user_ids)})
  return {row['id']: row for row in rows}


def users(filters: Filters, limit: int = 500) -> List[dict]:
  rows = rows_of(USERS.format(where=filters.where()), {**filters.params(), "limit": limit})
  projects: Dict[str, list] = {}
  for row in rows_of(USER_PROJECTS.format(where=filters.where()), filters.params()):
    projects.setdefault(row['person'], []).append((int(row['events']), row['project_id']))
  known = accounts(row['user_id'] for row in rows)
  result = []
  for row in rows:
    account = known.get(row['user_id'], {})
    top = sorted(projects.get(row['person'], []), reverse=True)[:TOP_PROJECTS]
    result.append({
      "user_id": row['user_id'],
      "user_name": account.get('user_name') or row['user_name'],
      "full_name": account.get('full_name'),
      "verified": bool(row['verified']),
      "active_days": int(row['active_days']),
      "web_events": int(row['web_events']),
      "cli_commands": int(row['cli_commands']),
      "commits_viewed": int(row['commits_viewed']),
      "batches_started": int(row['batches_started']),
      "events": int(row['events']),
      "last_seen_at": iso(row['last_seen_at']),
      "projects": [project for _, project in top],
    })
  return result


GROUPS = f"""
  SELECT g.id AS group_id, g.name, count(DISTINCT gm.user_id) AS members,
    count(DISTINCT e.user_id) AS active_members,
    count(DISTINCT (e.user_id, e.created_at::date)) FILTER (WHERE e.id IS NOT NULL) AS active_days,
    count(DISTINCT {commit('e.')}) AS commits_viewed,
    count(e.id) FILTER (WHERE ({web_batch('e.')}) OR ({cli_batch('e.')})) AS batches_started,
    count(e.id) FILTER (WHERE e.event = 'cli_command') AS cli_commands,
    count(e.id) AS events
  FROM groups g
  LEFT JOIN group_members gm ON gm.group_id = g.id
  LEFT JOIN usage_events e ON e.user_id = gm.user_id AND {{where}}
  GROUP BY g.id, g.name
  ORDER BY active_members DESC, events DESC, g.name
"""


def groups(filters: Filters) -> List[dict]:
  rows = rows_of(GROUPS.format(where=filters.where(alias='e')), filters.params())
  return [{
    "group_id": row['group_id'],
    "name": row['name'],
    "members": int(row['members']),
    "active_members": int(row['active_members']),
    "active_days": int(row['active_days']),
    "commits_viewed": int(row['commits_viewed']),
    "batches_started": int(row['batches_started']),
    "cli_commands": int(row['cli_commands']),
    "events": int(row['events']),
  } for row in rows]


PROJECTS = f"""
  SELECT project_id,
    count(DISTINCT CASE WHEN event = 'page_view' THEN {PERSON} END) AS people,
    count(DISTINCT {COMMIT}) AS commits_viewed,
    count(*) FILTER (WHERE event = 'output_open') AS outputs_opened,
    count(*) FILTER (WHERE ({WEB_BATCH}) OR ({CLI_BATCH})) AS batches_started,
    count(*) FILTER (WHERE event = 'cli_command') AS cli_commands,
    count(*) AS events
  FROM usage_events WHERE {{where}} AND project_id IS NOT NULL
  GROUP BY 1
"""

PROJECTS_CI_RUNS = """
  SELECT c.project_id, count(*) AS ci_runs FROM outputs o
  JOIN batches b ON b.id = o.batch_id
  JOIN ci_commits c ON c.id = b.ci_commit_id
  WHERE {where}
  GROUP BY 1
"""

# Which of these projects had events before the period: the others are new
PROJECTS_SEEN_BEFORE = """
  SELECT DISTINCT project_id FROM usage_events WHERE created_at < :since AND project_id IN :projects
"""

PROJECT_STATUSES = ('active', 'ci_only', 'quiet', 'new')


def product_of(project_id: str) -> str:
  return project_id.split('/')[0]


def projects(filters: Filters) -> List[dict]:
  """
  The projects with activity in the period or the one before, and how they're used:
  `active` (people looked), `ci_only` (CI runs, nobody looked), `quiet` (nothing, but something before), `new` (active, first seen now).
  """
  current = {row['project_id']: row for row in rows_of(PROJECTS.format(where=filters.where()), filters.params())}
  ci_runs = {row['project_id']: int(row['ci_runs']) for row in rows_of(PROJECTS_CI_RUNS.format(where=filters.ci_where()), filters.params())}
  previous = {row['project_id'] for row in rows_of(PROJECTS.format(where=filters.where()), filters.params(previous=True))}
  previous |= {row['project_id'] for row in rows_of(PROJECTS_CI_RUNS.format(where=filters.ci_where()), filters.params(previous=True))}
  ids = sorted(set(current) | set(ci_runs) | previous)
  active_ids = [p for p in ids if int(current.get(p, {}).get('people') or 0) > 0]
  seen_before = set()
  if active_ids:
    seen_before = {row['project_id'] for row in rows_of(PROJECTS_SEEN_BEFORE, {"since": filters.period.since, "projects": tuple(active_ids)})}
  result = []
  for project_id in ids:
    row = current.get(project_id, {})
    people = int(row.get('people') or 0)
    runs = ci_runs.get(project_id, 0)
    if people > 0:
      status = 'new' if project_id not in seen_before else 'active'
    elif runs > 0:
      status = 'ci_only'
    else:
      status = 'quiet'
    result.append({
      "project_id": project_id,
      "product": product_of(project_id),
      "people": people,
      "commits_viewed": int(row.get('commits_viewed') or 0),
      "outputs_opened": int(row.get('outputs_opened') or 0),
      "batches_started": int(row.get('batches_started') or 0),
      "cli_commands": int(row.get('cli_commands') or 0),
      "events": int(row.get('events') or 0),
      "ci_runs": runs,
      "status": status,
    })
  result.sort(key=lambda p: (-p['people'], -p['events'], -p['ci_runs'], p['project_id']))
  return result


# One person

USER_USAGE = """
  SELECT count(*) AS total, count(DISTINCT created_at::date) AS active_days,
    min(created_at) AS first_in_period, max(created_at) AS last_seen_at
  FROM usage_events WHERE {where} AND {who}
"""
USER_FIRST_SEEN = "SELECT min(created_at) AS first_seen_at FROM usage_events WHERE {who}"
USER_BY_EVENT = "SELECT event, count(*) AS count FROM usage_events WHERE {where} AND {who} GROUP BY 1 ORDER BY 2 DESC, 1"
USER_BY_PROJECT = "SELECT project_id, count(*) AS count FROM usage_events WHERE {where} AND {who} AND project_id IS NOT NULL GROUP BY 1 ORDER BY 2 DESC, 1 LIMIT 50"


def user_usage(user_id: int, period: Period) -> dict:
  filters = Filters(period)
  who = "user_id = :user_id"
  params = {**filters.params(), "user_id": user_id}
  totals = one_of(USER_USAGE.format(where=filters.where(), who=who), params)
  first = one_of(USER_FIRST_SEEN.format(who=who), params)
  return {
    **period.describe(),
    "total": int(totals.get('total') or 0),
    "active_days": int(totals.get('active_days') or 0),
    "first_seen_at": iso(first.get('first_seen_at')),
    "last_seen_at": iso(totals.get('last_seen_at')),
    "by_event": [{"event": row['event'], "count": int(row['count'])} for row in rows_of(USER_BY_EVENT.format(where=filters.where(), who=who), params)],
    "by_project": [{"project_id": row['project_id'], "count": int(row['count'])} for row in rows_of(USER_BY_PROJECT.format(where=filters.where(), who=who), params)],
  }


# The raw events, for spreadsheets and scripts

EVENT_COLUMNS = ('id', 'created_at', 'received_at', 'source', 'event', 'user_id', 'user_name', 'verified', 'client_id', 'project_id', 'properties')
EVENTS = f"SELECT {', '.join(EVENT_COLUMNS)} FROM usage_events WHERE {{where}} AND id > :after_id ORDER BY id LIMIT :chunk"


def events_rows(filters: Filters, chunk: int = 5000, limit: Optional[int] = None):
  """The period's events, oldest first, read in chunks"""
  after_id, done = 0, 0
  while True:
    rows = rows_of(EVENTS.format(where=filters.where()), {**filters.params(), "after_id": after_id, "chunk": chunk})
    for row in rows:
      yield row
      done += 1
      if limit is not None and done >= limit:
        return
    if len(rows) < chunk:
      return
    after_id = rows[-1]['id']


def event_as_text(row: dict) -> dict:
  """A row for CSV: dates in ISO, properties as JSON"""
  import json
  return {**row, "created_at": iso(row['created_at']), "received_at": iso(row['received_at']),
          "properties": json.dumps(row['properties'], sort_keys=True)}


# For the admin overview

def active_user_ids(since: datetime.datetime) -> set:
  """The accounts with an event since then"""
  rows = rows_of("SELECT DISTINCT user_id FROM usage_events WHERE created_at >= :since AND user_id IS NOT NULL", {"since": since})
  return {row['user_id'] for row in rows}


def ci_only_projects(since: datetime.datetime) -> List[str]:
  """Projects with CI runs since then that nobody looked at in the web app"""
  rows = rows_of("""
    SELECT DISTINCT c.project_id FROM outputs o
    JOIN batches b ON b.id = o.batch_id
    JOIN ci_commits c ON c.id = b.ci_commit_id
    WHERE o.created_date >= :since AND b.origin = 'ci'
    AND NOT EXISTS (
      SELECT 1 FROM usage_events e WHERE e.created_at >= :since AND e.event = 'page_view'
      AND (e.project_id = c.project_id OR e.project_id LIKE c.project_id || '/%')
    )
    ORDER BY 1
  """, {"since": since})
  return [row['project_id'] for row in rows]


def web_only_users(since: datetime.datetime) -> List[int]:
  """The accounts active in the web app since then that never used the CLI"""
  rows = rows_of("""
    SELECT DISTINCT user_id FROM usage_events w WHERE created_at >= :since AND source = 'webapp' AND user_id IS NOT NULL
    AND NOT EXISTS (SELECT 1 FROM usage_events c WHERE c.user_id = w.user_id AND c.source = 'cli')
  """, {"since": since})
  return [row['user_id'] for row in rows]


def tuning_products(since: datetime.datetime) -> dict:
  """{product: whether anyone started a tuning} for the products people looked at since then"""
  rows = rows_of("""
    SELECT split_part(project_id, '/', 1) AS product,
      bool_or(event = 'batch_start' AND properties->>'kind' IN ('tuning', 'automated_tuning')) AS tuning
    FROM usage_events WHERE created_at >= :since AND project_id IS NOT NULL AND source = 'webapp'
    GROUP BY 1
  """, {"since": since})
  return {row['product']: bool(row['tuning']) for row in rows}
