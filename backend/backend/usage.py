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
# Periods of the dashboard: not before, not longer
EARLIEST = datetime.datetime(2000, 1, 1)
MAX_PERIOD = datetime.timedelta(days=5 * 366)

SOURCES = ('webapp', 'cli')
EVENT_NAME = re.compile(r'^[a-z][a-z0-9_]{0,63}$')
PROPERTY_KEY = re.compile(r'^[a-z_][a-z0-9_]{0,63}$')

BATCH_KINDS = ('tuning', 'automated_tuning', 'run_tests', 'redo')


# The SQL of what we count, on the `usage_events` columns (`alias.` when the table has one)

def person(alias: str = '') -> str:
  """Who an event is about: the account, or the unverified name the CLI gave"""
  return f"coalesce({alias}user_id::text, 'name:' || {alias}user_name)"


def web_batch(alias: str = '') -> str:
  """A batch started from the web app"""
  return f"{alias}event = 'batch_start'"


def cli_batch(alias: str = '') -> str:
  """`qa batch` in a terminal, not a dry run. `runner` is only there once the command really runs batches (not --help)"""
  return f"{alias}event = 'cli_command' AND {alias}properties->>'command' = 'batch' AND {alias}properties ? 'runner' AND {alias}properties->>'dryrun' IS DISTINCT FROM 'true'"


# A commit someone looked at: `page_view` events say which (properties.commit_id), of a project
VIEWED_COMMIT = "event = 'page_view' AND properties->>'commit_id' IS NOT NULL"

PERSON, WEB_BATCH, CLI_BATCH = person(), web_batch(), cli_batch()

DEFAULT_DAYS = 30


def utcnow():
  return datetime.datetime.utcnow()


def iso(date: Optional[datetime.datetime]) -> Optional[str]:
  return f"{date.isoformat()}Z" if date else None


# Cleaning what the clients send

_dropped = object()


def clean_string(value: str, max_length: int) -> str:
  """Cut, without the characters PostgreSQL refuses: NUL (text and JSONB) and lone surrogates (not UTF-8)"""
  value = value.replace('\x00', '')[:max_length]
  try:
    value.encode('utf-8')
  except UnicodeEncodeError:
    value = ''.join('\ufffd' if 0xD800 <= ord(c) <= 0xDFFF else c for c in value)
  return value


def clean_value(value):
  """A scalar (strings cut at MAX_STRING, finite numbers, booleans, None) or a short list of those, else `_dropped`"""
  if value is None or isinstance(value, bool):
    return value
  if isinstance(value, str):
    return clean_string(value, MAX_STRING)
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
  value = clean_string(value.strip(), max_length).strip()
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


def find_user_id(user_name: Optional[str]) -> Optional[int]:
  """The person's account, for the CLI's unverified events: never a service account, nor a disabled one"""
  if not user_name:
    return None
  from .models import User
  from .database import db_session
  row = db_session.query(User.id).filter(User.user_name == user_name, User.kind == 'human', User.status == 'active').first()
  return row[0] if row else None


def claim_events(user) -> int:
  """
  A new account takes the events its name sent from the CLI before it existed, so that a person stays one person
  in the dashboard. Called when accounts are created: it never raises, nobody should fail to sign in over this.
  """
  try:
    if user is None or not user.user_name or getattr(user, 'kind', 'human') != 'human':
      return 0
    from .database import db_session
    # a savepoint: a failure here (e.g. before the migration ran) doesn't abort the caller's transaction
    with db_session.begin_nested():
      result = execute("UPDATE usage_events SET user_id = :user_id WHERE user_id IS NULL AND user_name = :user_name",
                       {"user_id": user.id, "user_name": user.user_name})
    count = getattr(result, 'rowcount', None)
    return count if isinstance(count, int) and count >= 0 else 0
  except Exception:
    return 0


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
  elif source == 'cli' and clean_text(user_name_hint, MAX_STRING):
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
    # the period can't extend into the future: trends compare it with a period before of the same, real, length
    self.until = min(until, now) if until else now
    self.since = since or self.until - datetime.timedelta(days=DEFAULT_DAYS)
    if self.since >= self.until:
      raise ValueError("`since` must be before `until`")
    if self.since < EARLIEST:
      raise ValueError(f"`since` can't be before {EARLIEST:%Y-%m-%d}")
    if self.until - self.since > MAX_PERIOD:
      raise ValueError("The period can't be longer than 5 years")
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

# How the queries below count distinct things (people, commits, days...): count(DISTINCT x) sorts all the period's
# events, once per distinct count, which takes tens of seconds on a year of events. They GROUP BY instead, by the
# columns themselves: PostgreSQL knows from their statistics how many groups to expect (a few thousand people), and
# hashes them. Grouped by an expression like PERSON, it can expect millions of groups, and sorts.

# The totals of a period (or of each bucket of the timeseries)
TOTALS = f"""
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

# The people of a period (or of each bucket of the timeseries: `by_bucket`), and whether they used the web app, the
# CLI, unverified: grouped by account and name first, then by PERSON (an account's name can change)
def people_sql(by_bucket=False) -> str:
  start, key = ("date_trunc(:bucket, created_at) AS start, ", "start, ") if by_bucket else ('', '')
  return f"""
    SELECT {key}count(*) AS users, count(*) FILTER (WHERE web) AS web_users, count(*) FILTER (WHERE cli) AS cli_users,
      count(*) FILTER (WHERE unverified) AS unverified_cli_users
    FROM (
      SELECT {key}{PERSON} AS person, bool_or(web) AS web, bool_or(cli) AS cli, bool_or(unverified) AS unverified
      FROM (
        SELECT {start}user_id, user_name,
          bool_or(source = 'webapp' AND user_id IS NOT NULL) AS web,
          bool_or(source = 'cli') AS cli,
          bool_or(source = 'cli' AND NOT verified AND user_id IS NULL) AS unverified
        FROM usage_events WHERE {{where}} AND (user_id IS NOT NULL OR user_name IS NOT NULL)
        GROUP BY {key}user_id, user_name
      ) a
      GROUP BY {key}{PERSON}
    ) p
    {"GROUP BY start" if by_bucket else ''}
  """


# The commits looked at (VIEWED_COMMIT), grouped by project and commit
def commits_sql(by_bucket=False) -> str:
  start, key = ("date_trunc(:bucket, created_at) AS start, ", "start, ") if by_bucket else ('', '')
  return f"""
    SELECT {key}count(*) AS commits_viewed FROM (
      SELECT {start}project_id, properties->>'commit_id' AS commit_id
      FROM usage_events WHERE {{where}} AND {VIEWED_COMMIT}
      GROUP BY {key}project_id, properties->>'commit_id'
    ) c
    {"GROUP BY start" if by_bucket else ''}
  """


COUNTS = f"""
  SELECT * FROM ({people_sql()}) p, ({commits_sql()}) c, (SELECT {TOTALS} FROM usage_events WHERE {{where}}) t
"""

# People (PERSON) whose first event ever is in the period. Accounts and unverified names are counted apart, so that
# each check is one lookup in the (user_id, created_at) or (user_name, created_at) index: with an OR between them,
# PostgreSQL reads every event before the period for each person.
NEW_USERS = """
  SELECT
    (SELECT count(*) FROM (SELECT DISTINCT user_id FROM usage_events WHERE {where} AND user_id IS NOT NULL) p
     WHERE NOT EXISTS (SELECT 1 FROM usage_events e WHERE e.user_id = p.user_id AND e.created_at < :since))
    +
    (SELECT count(*) FROM (SELECT DISTINCT user_name FROM usage_events WHERE {where} AND user_id IS NULL AND user_name IS NOT NULL) p
     WHERE NOT EXISTS (SELECT 1 FROM usage_events e WHERE e.user_name = p.user_name AND e.user_id IS NULL AND e.created_at < :since))
  AS new_users
"""

CI_RUNS = """
  SELECT count(*) AS ci_runs FROM outputs o
  JOIN batches b ON b.id = o.batch_id
  JOIN ci_commits c ON c.id = b.ci_commit_id
  WHERE {where}
"""


def counts(filters: Filters, previous=False) -> dict:
  params = filters.params(previous)
  row = one_of(COUNTS.format(where=filters.where()), params)
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

TIMESERIES_TOTALS = f"""
  SELECT date_trunc(:bucket, created_at) AS start,
    count(*) FILTER (WHERE event = 'output_open') AS outputs_opened,
    count(*) FILTER (WHERE ({WEB_BATCH}) OR ({CLI_BATCH})) AS batches_started,
    count(*) FILTER (WHERE event = 'cli_command') AS cli_commands
  FROM usage_events WHERE {{where}}
  GROUP BY 1
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
  params = {**filters.params(), "bucket": bucket}
  found: Dict[datetime.datetime, dict] = {}
  for sql in (people_sql(by_bucket=True), commits_sql(by_bucket=True), TIMESERIES_TOTALS):
    for row in rows_of(sql.format(where=filters.where()), params):
      found.setdefault(row['start'], {}).update(row)
  buckets = []
  start = bucket_start(filters.period.since, bucket)
  step = datetime.timedelta(days=7 if bucket == 'week' else 1)
  while start < filters.period.until:
    row = found.get(start, {})
    buckets.append({"start": iso(start), **{field: int(row.get(field) or 0) for field in TIMESERIES_FIELDS}})
    start += step
  return buckets


# Leaderboards

# Each person's days (totals by account, name and day, then by person and day), and the commits they looked at
USERS = f"""
  WITH days AS (
    SELECT {PERSON} AS person, day, max(user_id) AS user_id, max(user_name) AS user_name, bool_and(verified) AS verified,
      sum(web_events) AS web_events, sum(cli_commands) AS cli_commands, sum(batches_started) AS batches_started,
      sum(events) AS events, max(last_seen_at) AS last_seen_at
    FROM (
      SELECT user_id, user_name, created_at::date AS day, bool_and(verified) AS verified,
        count(*) FILTER (WHERE source = 'webapp') AS web_events,
        count(*) FILTER (WHERE event = 'cli_command') AS cli_commands,
        count(*) FILTER (WHERE ({WEB_BATCH}) OR ({CLI_BATCH})) AS batches_started,
        count(*) AS events, max(created_at) AS last_seen_at
      FROM usage_events WHERE {{where}} AND (user_id IS NOT NULL OR user_name IS NOT NULL)
      GROUP BY user_id, user_name, day
    ) a
    GROUP BY 1, 2
  ), commits AS (
    SELECT person, count(*) AS commits_viewed FROM (
      SELECT {PERSON} AS person, project_id, commit_id FROM (
        SELECT user_id, user_name, project_id, properties->>'commit_id' AS commit_id
        FROM usage_events WHERE {{where}} AND (user_id IS NOT NULL OR user_name IS NOT NULL) AND {VIEWED_COMMIT}
        GROUP BY user_id, user_name, project_id, properties->>'commit_id'
      ) a
      GROUP BY 1, 2, 3
    ) c
    GROUP BY 1
  )
  SELECT d.person, max(d.user_id) AS user_id, max(d.user_name) AS user_name, bool_and(d.verified) AS verified,
    count(*) AS active_days, sum(d.web_events) AS web_events, sum(d.cli_commands) AS cli_commands,
    coalesce(max(c.commits_viewed), 0) AS commits_viewed, sum(d.batches_started) AS batches_started,
    sum(d.events) AS events, max(d.last_seen_at) AS last_seen_at
  FROM days d LEFT JOIN commits c ON c.person = d.person
  GROUP BY d.person ORDER BY active_days DESC, events DESC, last_seen_at DESC
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


def users(filters: Filters, limit: Optional[int] = 500) -> List[dict]:
  """The people of the period, most active first. `limit`: None for all of them (LIMIT NULL is no limit)"""
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


# Each account's days and the commits it looked at, then those of each group's members. The commits are counted
# distinct over the group: members look at the same commits.
GROUPS = f"""
  WITH days AS (
    SELECT user_id, created_at::date AS day,
      count(*) FILTER (WHERE ({WEB_BATCH}) OR ({CLI_BATCH})) AS batches_started,
      count(*) FILTER (WHERE event = 'cli_command') AS cli_commands,
      count(*) AS events
    FROM usage_events e WHERE {{where}} AND user_id IS NOT NULL
    GROUP BY 1, 2
  ), commits AS (
    SELECT user_id, project_id, properties->>'commit_id' AS commit_id
    FROM usage_events e WHERE {{where}} AND user_id IS NOT NULL AND {VIEWED_COMMIT}
    GROUP BY 1, 2, 3
  ), activity AS (
    SELECT gm.group_id, count(DISTINCT d.user_id) AS active_members, count(*) AS active_days,
      sum(d.batches_started) AS batches_started, sum(d.cli_commands) AS cli_commands, sum(d.events) AS events
    FROM days d JOIN group_members gm ON gm.user_id = d.user_id
    GROUP BY 1
  ), group_commits AS (
    SELECT group_id, count(*) AS commits_viewed FROM (
      SELECT gm.group_id, c.project_id, c.commit_id FROM commits c JOIN group_members gm ON gm.user_id = c.user_id
      GROUP BY 1, 2, 3
    ) gc
    GROUP BY 1
  ), members AS (
    SELECT group_id, count(*) AS members FROM group_members GROUP BY 1
  )
  SELECT g.id AS group_id, g.name, coalesce(m.members, 0) AS members,
    coalesce(a.active_members, 0) AS active_members, coalesce(a.active_days, 0) AS active_days,
    coalesce(c.commits_viewed, 0) AS commits_viewed, coalesce(a.batches_started, 0) AS batches_started,
    coalesce(a.cli_commands, 0) AS cli_commands, coalesce(a.events, 0) AS events
  FROM groups g
  LEFT JOIN members m ON m.group_id = g.id
  LEFT JOIN activity a ON a.group_id = g.id
  LEFT JOIN group_commits c ON c.group_id = g.id
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


# Each project's totals, commits looked at, and viewers: who looked at its pages, the person, or the anonymous browser
# (servers that don't require signing in), grouped by account, name and browser first
PROJECTS = f"""
  WITH totals AS (
    SELECT project_id,
      count(*) FILTER (WHERE event = 'output_open') AS outputs_opened,
      count(*) FILTER (WHERE ({WEB_BATCH}) OR ({CLI_BATCH})) AS batches_started,
      count(*) FILTER (WHERE event = 'cli_command') AS cli_commands,
      count(*) AS events
    FROM usage_events WHERE {{where}} AND project_id IS NOT NULL
    GROUP BY 1
  ), viewers AS (
    SELECT project_id, count(*) AS people FROM (
      SELECT project_id, coalesce({PERSON}, 'client:' || client_id) AS viewer FROM (
        SELECT project_id, user_id, user_name, client_id
        FROM usage_events WHERE {{where}} AND project_id IS NOT NULL AND event = 'page_view'
        GROUP BY 1, 2, 3, 4
      ) a
      WHERE coalesce({PERSON}, 'client:' || client_id) IS NOT NULL
      GROUP BY 1, 2
    ) v
    GROUP BY 1
  ), commits AS (
    SELECT project_id, count(*) AS commits_viewed FROM (
      SELECT project_id, properties->>'commit_id' FROM usage_events
      WHERE {{where}} AND project_id IS NOT NULL AND {VIEWED_COMMIT}
      GROUP BY 1, 2
    ) c
    GROUP BY 1
  )
  SELECT t.project_id, coalesce(v.people, 0) AS people, coalesce(c.commits_viewed, 0) AS commits_viewed,
    t.outputs_opened, t.batches_started, t.cli_commands, t.events
  FROM totals t
  LEFT JOIN viewers v ON v.project_id = t.project_id
  LEFT JOIN commits c ON c.project_id = t.project_id
"""
# The projects with events in a period (the one before, to find the quiet projects)
PROJECT_IDS = "SELECT DISTINCT project_id FROM usage_events WHERE {where} AND project_id IS NOT NULL"

PROJECTS_CI_RUNS = """
  SELECT c.project_id, count(*) AS ci_runs FROM outputs o
  JOIN batches b ON b.id = o.batch_id
  JOIN ci_commits c ON c.id = b.ci_commit_id
  WHERE {where}
  GROUP BY 1
"""

PROJECTS_CI_IDS = """
  SELECT DISTINCT c.project_id FROM outputs o
  JOIN batches b ON b.id = o.batch_id
  JOIN ci_commits c ON c.id = b.ci_commit_id
  WHERE {where}
"""

# Which of these projects had events before the period, the others are new: an index lookup per project
PROJECTS_SEEN_BEFORE = """
  SELECT p.project_id FROM unnest(CAST(:projects AS text[])) AS p(project_id)
  WHERE EXISTS (SELECT 1 FROM usage_events e WHERE e.project_id = p.project_id AND e.created_at < :since)
"""
# The projects with CI runs since then, without reading the runs (there are millions, and reading them from disk can
# take a minute): their commits got runs since then (latest_output_datetime, set when runs are sent, a day earlier
# for servers whose timezone isn't UTC), and have a batch from the CI. Close enough for a hint: a commit of the CI
# that only got other runs lately counts too.
CI_PROJECTS_SINCE = """
  SELECT DISTINCT c.project_id FROM ci_commits c
  WHERE c.latest_output_datetime >= :since_commits
  AND EXISTS (SELECT 1 FROM batches b WHERE b.ci_commit_id = c.id AND b.origin = 'ci')
"""
# The projects people (or anonymous browsers) looked at since then
VIEWED_PROJECTS_SINCE = """
  SELECT DISTINCT project_id FROM usage_events WHERE created_at >= :since AND event = 'page_view' AND project_id IS NOT NULL
"""

PROJECT_STATUSES = ('active', 'ci_only', 'quiet', 'new')


def product_of(project_id: str) -> str:
  return project_id.split('/')[0]


def projects(filters: Filters) -> List[dict]:
  """
  The projects with activity in the period or the one before, and how they're used:
  `new` (their first event ever is in the period), `active` (people, or anonymous browsers, looked at them),
  `ci_only` (CI runs, nobody looked), `quiet` (no events and no CI runs now, some in the period before).
  """
  current = {row['project_id']: row for row in rows_of(PROJECTS.format(where=filters.where()), filters.params())}
  ci_runs = {row['project_id']: int(row['ci_runs']) for row in rows_of(PROJECTS_CI_RUNS.format(where=filters.ci_where()), filters.params())}
  # the period before: only which projects had activity
  previous = {row['project_id'] for row in rows_of(PROJECT_IDS.format(where=filters.where()), filters.params(previous=True))}
  previous |= {row['project_id'] for row in rows_of(PROJECTS_CI_IDS.format(where=filters.ci_where()), filters.params(previous=True))}
  ids = sorted(set(current) | set(ci_runs) | previous)
  seen_before = set()
  if current:
    seen_before = {row['project_id'] for row in rows_of(PROJECTS_SEEN_BEFORE, {"since": filters.period.since, "projects": sorted(current)})}
  result = []
  for project_id in ids:
    row = current.get(project_id, {})
    people = int(row.get('people') or 0)
    runs = ci_runs.get(project_id, 0)
    if row and project_id not in seen_before:
      status = 'new'
    elif people > 0:
      status = 'active'
    elif runs > 0:
      status = 'ci_only'
    elif row:
      status = 'active'  # e.g. only CLI commands: someone works on it
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
  SELECT count(*) AS total, count(*) FILTER (WHERE NOT verified) AS unverified, count(DISTINCT created_at::date) AS active_days,
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
    # sent by the CLI without a token, as this user's name: anyone who can reach the server could have sent them
    "unverified": int(totals.get('unverified') or 0),
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


def event_as_json(row: dict) -> dict:
  """A row for JSON: dates in ISO, properties as they are"""
  return {**row, "created_at": iso(row['created_at']), "received_at": iso(row['received_at'])}


def event_as_text(row: dict) -> dict:
  """A row for CSV: dates in ISO, properties as a JSON string"""
  import json
  return {**event_as_json(row), "properties": json.dumps(row['properties'], sort_keys=True)}


# For the admin overview

def active_user_ids(since: datetime.datetime) -> set:
  """The people (human accounts that still exist) with an event since then"""
  # an index lookup per account, not every event of the period
  rows = rows_of("""
    SELECT u.id AS user_id FROM users u
    WHERE u.kind = 'human' AND EXISTS (SELECT 1 FROM usage_events e WHERE e.user_id = u.id AND e.created_at >= :since)
  """, {"since": since})
  return {row['user_id'] for row in rows}


def ci_only_projects(since: datetime.datetime) -> List[str]:
  """Projects with CI runs since then that nobody looked at in the web app (people, or anonymous browsers)"""
  ci = {row['project_id'] for row in rows_of(CI_PROJECTS_SINCE, {"since": since, "since_commits": since - datetime.timedelta(days=1)})}
  # looking at a subproject is looking at the project: every viewed project id and its parents
  viewed = set()
  for row in rows_of(VIEWED_PROJECTS_SINCE, {"since": since}):
    parts = row['project_id'].split('/')
    viewed.update('/'.join(parts[:i]) for i in range(1, len(parts) + 1))
  return sorted(project_id for project_id in ci if project_id not in viewed)


def web_only_users(since: datetime.datetime) -> List[int]:
  """The accounts active in the web app since then that didn't use the CLI since then. One pass over the period:
  "ever" read all the past events of each of them"""
  rows = rows_of("""
    SELECT user_id FROM usage_events WHERE created_at >= :since AND user_id IS NOT NULL
    GROUP BY user_id HAVING bool_or(source = 'webapp') AND NOT bool_or(source = 'cli')
    ORDER BY 1
  """, {"since": since})
  return [row['user_id'] for row in rows]


def tuning_products(since: datetime.datetime) -> dict:
  """{product: whether anyone started a tuning} for the products people looked at since then"""
  rows = rows_of("""
    SELECT split_part(project_id, '/', 1) AS product,
      bool_or((event = 'batch_start' AND properties->>'kind' IN ('tuning', 'automated_tuning'))
              OR (event = 'cli_command' AND (properties->>'tuning' = 'true' OR properties->>'command' = 'optimize'))) AS tuning
    FROM usage_events WHERE created_at >= :since AND project_id IS NOT NULL
    GROUP BY 1
  """, {"since": since})
  return {row['product']: bool(row['tuning']) for row in rows}
