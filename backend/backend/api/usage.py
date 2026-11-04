"""
Usage analytics (backend/usage.py, docs/design/usage-analytics.md):
- POST /api/v1/events: where the web app and the `qa` CLI send what people do. Answers 204 whether the events were
  stored or dropped (analytics.enabled off, unverified events when ingest.auth is "token"): a bad event is never an error.
- GET /api/v1/admin/usage/*: the numbers of Admin > Usage, with ?format=csv on the tables.
- GET /api/v1/user/usage: users' own numbers.
"""
import io
import csv
import json
import time
import threading

from flask import request, jsonify, g, Response, stream_with_context

from backend import app, db_session
from .. import usage as usage_lib
from ..audit import client_ip
from ..hybrid_cache import hybrid_cache
from ..settings import setting
from .auth import admin_required, login_required


# Over this many events per minute, an actor is told to slow down (429): a loop in a client, not people
EVENTS_PER_MINUTE = 1000
_rate_lock = threading.Lock()
# actor key => [minute, events this minute, events the minute before]: two fixed windows, a few bytes per client
_rate_windows = {}
_rate_cleaned_at = 0.0


def rate_limited(key: str, count: int, now: float = None) -> bool:
  """
  Whether `count` more events from `key` go over the limit for the last minute: the events of this minute, and those
  of the minute before weighted by how much of it is still in the window. Refused events aren't counted: a client
  over the limit gets through again a minute later, however much it insisted.
  """
  global _rate_cleaned_at
  if count <= 0:
    return False
  now = time.monotonic() if now is None else now
  minute, elapsed = divmod(now, 60)
  with _rate_lock:
    window = _rate_windows.get(key)
    if window is None or window[0] != minute:
      previous = window[1] if window is not None and window[0] == minute - 1 else 0
      window = _rate_windows[key] = [minute, 0, previous]
    total = window[1] + window[2] * (1 - elapsed / 60) + count
    if total > EVENTS_PER_MINUTE:
      return True
    window[1] += count
    if now - _rate_cleaned_at >= 60:
      _rate_cleaned_at = now
      for stale in [k for k, w in _rate_windows.items() if w[0] < minute - 1]:
        del _rate_windows[stale]
  return False


def actor_key(actor) -> str:
  if actor is not None and actor.user is not None:
    return f"user:{actor.user.id}"
  return f"ip:{client_ip() or 'unknown'}"


@app.route('/api/v1/events', methods=['POST'])
@app.route('/api/v1/events/', methods=['POST'])
def usage_events():
  if request.content_length and request.content_length > usage_lib.MAX_BODY_BYTES:
    return jsonify({"error": f"At most {usage_lib.MAX_BODY_BYTES // 1024} KiB of events per request."}), 413
  # whatever the header says, we don't read more
  request.max_content_length = usage_lib.MAX_BODY_BYTES
  # the web app's beacons are text/plain
  try:
    body = request.get_json(force=True, silent=True)
  except Exception:  # the body is longer than the header said
    return jsonify({"error": f"At most {usage_lib.MAX_BODY_BYTES // 1024} KiB of events per request."}), 413
  if not isinstance(body, dict) or not isinstance(body.get('events'), list):
    return jsonify({"error": "Send {\"events\": [{\"event\": ..., \"properties\": {...}}]}."}), 400
  if len(body['events']) > usage_lib.MAX_EVENTS:
    return jsonify({"error": f"At most {usage_lib.MAX_EVENTS} events per request."}), 413
  if not setting('analytics.enabled'):
    return '', 204
  actor = g.get('actor')
  if rate_limited(actor_key(actor), len(body['events'])):
    return jsonify({"error": f"Too many events: at most {EVENTS_PER_MINUTE} per minute."}), 429
  source = usage_lib.clean_source(body.get('source'))
  user_name = body.get('user_name') if source == 'cli' else None
  if (actor is None or actor.user is None) and setting('ingest.auth') == 'token':
    # like results: this server wants to know who sends what
    return '', 204
  now = usage_lib.utcnow()
  events = [e for e in (usage_lib.clean_event(raw, now) for raw in body['events']) if e is not None]
  if events:
    try:
      usage_lib.store(events, actor=actor, source=source, user_name_hint=user_name, now=now)
      db_session.commit()
    except Exception:
      # a bad event is never an error for the client: it's dropped, and we hear about it
      db_session.rollback()
      app.logger.exception("Could not store %d usage events", len(events))
  return '', 204


# Admin > Usage

def period_from_args():
  """(Period, None) from ?since=&until=, or (None, an error response)"""
  try:
    since = usage_lib.parse_date(request.args.get('since'))
    until = usage_lib.parse_date(request.args.get('until'), end_of_day=True)
    return usage_lib.Period(since, until), None
  except OverflowError:
    return None, (jsonify({"error": "The dates are out of range."}), 400)
  except ValueError as e:
    return None, (jsonify({"error": str(e)}), 400)


def filters_from_args():
  period, error = period_from_args()
  if error:
    return None, error
  return usage_lib.Filters(period, request.args.get('project')), None


def csv_cell(value):
  """Lists and dicts as JSON. Spreadsheets run cells that start like formulas: those get a quote (anonymous clients choose project ids)"""
  if isinstance(value, (list, dict)):
    value = json.dumps(value, sort_keys=True)
  if isinstance(value, str) and value[:1] in ('=', '+', '-', '@', '\t', '\r'):
    return "'" + value
  return value


def csv_lines(rows, columns):
  """The CSV, line by line: a generator, the exports can be long"""
  out = io.StringIO()
  writer = csv.DictWriter(out, fieldnames=columns, extrasaction='ignore')
  writer.writeheader()
  yield out.getvalue()
  for row in rows:
    out.seek(0)
    out.truncate()
    writer.writerow({k: csv_cell(v) for k, v in row.items()})
    yield out.getvalue()


def csv_response(rows, columns, filename: str):
  """A CSV to download, streamed from dicts"""
  return Response(stream_with_context(csv_lines(rows, columns)), mimetype='text/csv',
                  headers={"Content-Disposition": f'attachment; filename="{filename}"'})


def wants_csv() -> bool:
  return request.args.get('format') == 'csv'


def period_label(filters) -> str:
  return f"{filters.period.since:%Y-%m-%d}_{filters.period.until:%Y-%m-%d}"


# What Admin > Usage shows reads weeks to years of events, seconds of SQL: kept a few minutes, for all the server's
# processes (Redis), keyed by the request's parameters as they are. Going back to a period, or reloading, is instant;
# the last minutes' events show up a few minutes later.
USAGE_CACHE_SECONDS = 300


@hybrid_cache(ttl=USAGE_CACHE_SECONDS, maxsize=64)
def cached_usage(name: str, since: str, until: str, project: str, bucket: str = None):
  """The JSON of an Admin > Usage table. The arguments are the query string's: they were checked by filters_from_args"""
  period = usage_lib.Period(usage_lib.parse_date(since), usage_lib.parse_date(until, end_of_day=True))
  filters = usage_lib.Filters(period, project)
  if name == 'summary':
    return usage_lib.summary(filters)
  if name == 'timeseries':
    return {**period.describe(), "bucket": bucket, "buckets": usage_lib.timeseries(filters, bucket)}
  if name == 'users':
    return {**period.describe(), "users": usage_lib.users(filters)}
  if name == 'groups':
    return {**period.describe(), "groups": usage_lib.groups(filters)}
  if name == 'projects':
    return {**period.describe(), "projects": usage_lib.projects(filters)}
  raise ValueError(name)


def usage_of(name: str, bucket: str = None):
  return cached_usage(name, request.args.get('since') or '', request.args.get('until') or '', request.args.get('project') or '', bucket)


@app.route('/api/v1/admin/usage/summary', methods=['GET'])
@app.route('/api/v1/admin/usage/summary/', methods=['GET'])
@admin_required
def admin_usage_summary():
  filters, error = filters_from_args()
  if error:
    return error
  return jsonify(usage_of('summary'))


@app.route('/api/v1/admin/usage/timeseries', methods=['GET'])
@app.route('/api/v1/admin/usage/timeseries/', methods=['GET'])
@admin_required
def admin_usage_timeseries():
  filters, error = filters_from_args()
  if error:
    return error
  bucket = request.args.get('bucket', 'day')
  if bucket not in usage_lib.BUCKETS:
    return jsonify({"error": f"`bucket` must be one of {', '.join(usage_lib.BUCKETS)}"}), 400
  return jsonify(usage_of('timeseries', bucket))


USER_COLUMNS = ('user_id', 'user_name', 'full_name', 'verified', 'active_days', 'web_events', 'cli_commands', 'commits_viewed', 'batches_started', 'events', 'last_seen_at', 'projects')


@app.route('/api/v1/admin/usage/users', methods=['GET'])
@app.route('/api/v1/admin/usage/users/', methods=['GET'])
@admin_required
def admin_usage_users():
  filters, error = filters_from_args()
  if error:
    return error
  if wants_csv():
    # all of them, not the top 500 of the page: not cached
    return csv_response(usage_lib.users(filters, limit=None), USER_COLUMNS, f"qaboard-usage-users-{period_label(filters)}.csv")
  return jsonify(usage_of('users'))


GROUP_COLUMNS = ('group_id', 'name', 'members', 'active_members', 'active_days', 'commits_viewed', 'batches_started', 'cli_commands', 'events')


@app.route('/api/v1/admin/usage/groups', methods=['GET'])
@app.route('/api/v1/admin/usage/groups/', methods=['GET'])
@admin_required
def admin_usage_groups():
  filters, error = filters_from_args()
  if error:
    return error
  groups = usage_of('groups')['groups']
  if wants_csv():
    return csv_response(groups, GROUP_COLUMNS, f"qaboard-usage-groups-{period_label(filters)}.csv")
  return jsonify({**filters.period.describe(), "groups": groups})


PROJECT_COLUMNS = ('project_id', 'product', 'status', 'people', 'commits_viewed', 'outputs_opened', 'batches_started', 'cli_commands', 'ci_runs', 'events')


@app.route('/api/v1/admin/usage/projects', methods=['GET'])
@app.route('/api/v1/admin/usage/projects/', methods=['GET'])
@admin_required
def admin_usage_projects():
  filters, error = filters_from_args()
  if error:
    return error
  projects = usage_of('projects')['projects']
  if wants_csv():
    return csv_response(projects, PROJECT_COLUMNS, f"qaboard-usage-projects-{period_label(filters)}.csv")
  return jsonify({**filters.period.describe(), "projects": projects})


@app.route('/api/v1/admin/usage/events', methods=['GET'])
@app.route('/api/v1/admin/usage/events/', methods=['GET'])
@admin_required
def admin_usage_events():
  """The raw events of the period: CSV by default, it's for spreadsheets. ?format=json for scripts, ?limit= to peek."""
  filters, error = filters_from_args()
  if error:
    return error
  try:
    limit = int(request.args['limit']) if request.args.get('limit') else None
    if limit is not None and limit < 1:
      raise ValueError
  except ValueError:
    return jsonify({"error": "`limit` must be a positive number"}), 400
  rows = usage_lib.events_rows(filters, limit=limit)
  if request.args.get('format') == 'json':
    # one event per line (NDJSON): scripts read them as they come
    lines = (json.dumps(usage_lib.event_as_json(row), sort_keys=True) + "\n" for row in rows)
    return Response(stream_with_context(lines), mimetype='application/x-ndjson')
  return csv_response((usage_lib.event_as_text(row) for row in rows), usage_lib.EVENT_COLUMNS, f"qaboard-usage-events-{period_label(filters)}.csv")


@app.route('/api/v1/admin/usage/users/<int:user_id>', methods=['GET'])
@app.route('/api/v1/admin/usage/users/<int:user_id>/', methods=['GET'])
@admin_required
def admin_usage_user(user_id):
  period, error = period_from_args()
  if error:
    return error
  return jsonify({"user_id": user_id, **usage_lib.user_usage(user_id, period)})


@app.route('/api/v1/user/usage', methods=['GET'])
@app.route('/api/v1/user/usage/', methods=['GET'])
@login_required
def my_usage():
  """What QA-Board recorded about the signed-in user: the same numbers admins see"""
  period, error = period_from_args()
  if error:
    return error
  user = g.actor.user
  return jsonify({"user_id": user.id, **usage_lib.user_usage(user.id, period)})
