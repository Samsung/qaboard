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

from flask import request, jsonify, g, Response

from backend import app, db_session
from .. import usage as usage_lib
from ..audit import client_ip
from ..settings import setting
from .auth import admin_required, login_required


# Over this many events per minute, an actor is told to slow down (429): a loop in a client, not people
EVENTS_PER_MINUTE = 1000
_rate_lock = threading.Lock()
# actor key => [(when, how many events)] in the last minute
_rate_windows = {}


def rate_limited(key: str, count: int, now: float = None) -> bool:
  """Counts `count` events for `key`, and says whether it's over the limit for the last minute"""
  now = time.monotonic() if now is None else now
  with _rate_lock:
    window = [(when, n) for when, n in _rate_windows.get(key, []) if now - when < 60]
    total = sum(n for _, n in window) + count
    window.append((now, count))
    _rate_windows[key] = window
    if len(_rate_windows) > 10_000:
      # a flood of anonymous clients: forget the oldest
      for stale in [k for k, w in _rate_windows.items() if not w or now - w[-1][0] >= 60]:
        _rate_windows.pop(stale, None)
  return total > EVENTS_PER_MINUTE


def actor_key(actor) -> str:
  if actor is not None and actor.user is not None:
    return f"user:{actor.user.id}"
  return f"ip:{client_ip() or 'unknown'}"


@app.route('/api/v1/events', methods=['POST'])
@app.route('/api/v1/events/', methods=['POST'])
def usage_events():
  if request.content_length and request.content_length > usage_lib.MAX_BODY_BYTES:
    return jsonify({"error": f"At most {usage_lib.MAX_BODY_BYTES // 1024} KiB of events per request."}), 413
  # the web app's beacons are text/plain
  body = request.get_json(force=True, silent=True)
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
    usage_lib.store(events, actor=actor, source=source, user_name_hint=user_name, now=now)
    db_session.commit()
  return '', 204


# Admin > Usage

def period_from_args():
  """(Period, None) from ?since=&until=, or (None, an error response)"""
  try:
    since = usage_lib.parse_date(request.args.get('since'))
    until = usage_lib.parse_date(request.args.get('until'), end_of_day=True)
    return usage_lib.Period(since, until), None
  except ValueError as e:
    return None, (jsonify({"error": str(e)}), 400)


def filters_from_args():
  period, error = period_from_args()
  if error:
    return None, error
  return usage_lib.Filters(period, request.args.get('project')), None


def csv_response(rows, columns, filename: str):
  """A CSV to download, from dicts"""
  out = io.StringIO()
  writer = csv.DictWriter(out, fieldnames=columns, extrasaction='ignore')
  writer.writeheader()
  for row in rows:
    writer.writerow({k: (json.dumps(v) if isinstance(v, (list, dict)) else v) for k, v in row.items()})
  return Response(out.getvalue(), mimetype='text/csv', headers={"Content-Disposition": f'attachment; filename="{filename}"'})


def wants_csv() -> bool:
  return request.args.get('format') == 'csv'


def period_label(filters) -> str:
  return f"{filters.period.since:%Y-%m-%d}_{filters.period.until:%Y-%m-%d}"


@app.route('/api/v1/admin/usage/summary', methods=['GET'])
@app.route('/api/v1/admin/usage/summary/', methods=['GET'])
@admin_required
def admin_usage_summary():
  filters, error = filters_from_args()
  if error:
    return error
  return jsonify(usage_lib.summary(filters))


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
  return jsonify({**filters.period.describe(), "bucket": bucket, "buckets": usage_lib.timeseries(filters, bucket)})


USER_COLUMNS = ('user_id', 'user_name', 'full_name', 'verified', 'active_days', 'web_events', 'cli_commands', 'commits_viewed', 'batches_started', 'events', 'last_seen_at', 'projects')


@app.route('/api/v1/admin/usage/users', methods=['GET'])
@app.route('/api/v1/admin/usage/users/', methods=['GET'])
@admin_required
def admin_usage_users():
  filters, error = filters_from_args()
  if error:
    return error
  users = usage_lib.users(filters)
  if wants_csv():
    return csv_response(users, USER_COLUMNS, f"qaboard-usage-users-{period_label(filters)}.csv")
  return jsonify({**filters.period.describe(), "users": users})


GROUP_COLUMNS = ('group_id', 'name', 'members', 'active_members', 'active_days', 'commits_viewed', 'batches_started', 'cli_commands', 'events')


@app.route('/api/v1/admin/usage/groups', methods=['GET'])
@app.route('/api/v1/admin/usage/groups/', methods=['GET'])
@admin_required
def admin_usage_groups():
  filters, error = filters_from_args()
  if error:
    return error
  groups = usage_lib.groups(filters)
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
  projects = usage_lib.projects(filters)
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
  except ValueError:
    return jsonify({"error": "`limit` must be a number"}), 400
  rows = (usage_lib.event_as_text(row) for row in usage_lib.events_rows(filters, limit=limit))
  if request.args.get('format') == 'json':
    return jsonify({**filters.period.describe(), "events": list(rows)})
  return csv_response(rows, usage_lib.EVENT_COLUMNS, f"qaboard-usage-events-{period_label(filters)}.csv")


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
