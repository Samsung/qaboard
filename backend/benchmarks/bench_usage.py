#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = [
#   "flask==3.1.3",
#   "flask-cors",
#   "flask-login==0.6.3",
#   "sqlalchemy==2.0.48",
#   "sqlalchemy-utils==0.42.1",
#   "psycopg2-binary",
#   "greenlet",
#   "ujson",
#   "numpy",
#   "pytz",
#   "pyyaml",
#   "requests",
#   "simplejson",
#   "gitpython",
#   "redis",
#   "click",
#   "rich",
#   "joblib",
#   "psutil",
#   "sentry-sdk",
#   "celery",
#   "scipy",
#   "scikit-image",
#   "pillow",
# ]
# ///
"""
Times Admin > Usage and the admin overview (backend/usage.py, api/usage.py, api/admin.py) on the database of
bench_api.py (projects, commits, batches, runs), with users, groups and usage events added:

  uv run backend/benchmarks/bench_api.py --seed            # first, the runs (see there for the database)
  uv run backend/benchmarks/bench_usage.py --seed          # users, groups, batch origins, a year of usage events
  uv run backend/benchmarks/bench_usage.py                 # times the endpoints with this checkout's backend
  uv run backend/benchmarks/bench_usage.py --seed --days 1 # like a server that just got the feature

--explain prints the plans of the queries slower than --explain-ms, e.g. --only overview --explain.
"""
import os
import sys
import json
import time
import zlib
import random
import argparse
import datetime
import statistics
from pathlib import Path
from urllib.parse import urlencode

sys.path.insert(0, str(Path(__file__).resolve().parent))
from bench_api import setup_environment, copy_rows, sync_indexes  # noqa: E402


def parse_args():
  parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
  parser.add_argument('--db', default=os.environ.get('BENCH_DB', 'postgresql://qaboard@localhost:5433/qaboard_bench'))
  parser.add_argument('--backend', type=Path, default=Path(__file__).resolve().parent.parent, help='the backend/ folder to benchmark')
  parser.add_argument('--seed', action='store_true', help='replace the users, groups and usage events')
  parser.add_argument('--users', type=int, default=800)
  parser.add_argument('--days', type=int, default=365, help='days of usage events')
  parser.add_argument('--events-per-day', type=int, default=15000)
  parser.add_argument('--repeat', type=int, default=3)
  parser.add_argument('--keep-indexes', action='store_true')
  parser.add_argument('--cached', action='store_true', help="time the cached answers (by default, what's computed when the cache expired)")
  parser.add_argument('--only', help='only run the cases whose name contains this')
  parser.add_argument('--explain', action='store_true', help="print the plans of the slow queries")
  parser.add_argument('--explain-ms', type=float, default=100)
  parser.add_argument('--json', type=Path, help='save the results there')
  return parser.parse_args()


# ---------------------------------------------------------------------------
# Data
# ---------------------------------------------------------------------------
def seed(args):
  import psycopg2
  rng = random.Random(7)
  now = datetime.datetime.utcnow()
  start = time.time()
  conn = psycopg2.connect(args.db)
  cursor = conn.cursor()
  cursor.execute("TRUNCATE usage_events, group_members, groups RESTART IDENTITY CASCADE")
  cursor.execute("DELETE FROM tokens; DELETE FROM users")

  # Batches: mostly from the CI, like on servers after the migration e9b1c3d5f7a2
  cursor.execute("SELECT setseed(0.42); UPDATE batches SET origin = CASE WHEN random() < 0.8 THEN 'ci' ELSE 'local' END")

  users = []
  for i in range(1, args.users + 1):
    kind = 'service' if i % 40 == 0 else 'human'
    last_login = now - datetime.timedelta(days=rng.random() * 120) if rng.random() < 0.8 else None
    users.append((i, now.isoformat(), f"user{i:04d}", f"User {i}", f"user{i:04d}@example.com", 'local', '{}', kind, 'active',
                  'true' if i == 1 else 'false', last_login.isoformat() if last_login else None, '{}'))
  copy_rows(cursor, 'users', ['id', 'created_date', 'user_name', 'full_name', 'email', 'login_type', 'data', 'kind', 'status', 'is_admin', 'last_login_at', 'preferences'], users)
  cursor.execute("SELECT setval(pg_get_serial_sequence('users', 'id'), (SELECT max(id) FROM users))")

  nb_groups = 60
  copy_rows(cursor, 'groups', ['id', 'name', 'description', 'created_at'], [(g, f"team-{g:02d}", '', now.isoformat()) for g in range(1, nb_groups + 1)])
  members, member_id = [], 0
  for user_id in range(1, args.users + 1):
    for group_id in rng.sample(range(1, nb_groups + 1), rng.randint(1, 3)):
      member_id += 1
      members.append((member_id, group_id, user_id, 'manual', now.isoformat()))
  copy_rows(cursor, 'group_members', ['id', 'group_id', 'user_id', 'source', 'added_at'], members)
  cursor.execute("SELECT setval(pg_get_serial_sequence('groups', 'id'), (SELECT max(id) FROM groups))")
  cursor.execute("SELECT setval(pg_get_serial_sequence('group_members', 'id'), (SELECT max(id) FROM group_members))")

  cursor.execute("SELECT id FROM projects ORDER BY id")
  project_ids = [row[0] for row in cursor.fetchall()]
  # a few projects get most of the views
  project_weights = [1 / (i + 1) for i in range(len(project_ids))]
  humans = [u for u in users if u[7] == 'human']
  user_weights = [1 / (i + 1) ** 0.7 for i in range(len(humans))]
  kinds = ['tuning', 'automated_tuning', 'run_tests', 'redo']
  event_names = ['page_view', 'output_open', 'image_viewer_use', 'commit_compare', 'cli_command', 'batch_start', 'export_start', 'milestone_save']
  event_weights = [60, 14, 8, 5, 9, 2, 1, 1]

  rows, event_id = [], 0
  def flush():
    copy_rows(cursor, 'usage_events', ['id', 'created_at', 'received_at', 'source', 'event', 'user_id', 'user_name', 'verified', 'client_id', 'project_id', 'properties'], rows)
    rows.clear()
  # oldest first, like a server receives them: the table's order follows created_at
  for day in reversed(range(args.days)):
    day_start = now - datetime.timedelta(days=day + 1)
    for when in sorted(day_start + datetime.timedelta(seconds=rng.random() * 86400) for _ in range(args.events_per_day)):
      event_id += 1
      event = rng.choices(event_names, event_weights)[0]
      user = rng.choices(humans, user_weights)[0]
      user_id, user_name, verified = user[0], user[2], 'true'
      source = 'cli' if event == 'cli_command' else 'webapp'
      project_id = rng.choices(project_ids, project_weights)[0]
      properties = {}
      if event == 'page_view':
        properties = {"route": "commit", "has_reference": rng.random() < 0.3}
        if rng.random() < 0.6:
          # people look at the few commits of the week of the projects they work on
          properties["commit_id"] = f"{zlib.crc32(f'{project_id} {when.isocalendar()[:2]} {rng.randint(1, 30)}'.encode()):08x}"
        if rng.random() < 0.03:  # anonymous browsers
          user_id, user_name = None, None
      elif event == 'cli_command':
        properties = {"command": rng.choice(['batch', 'batch', 'run', 'optimize', 'auth']), "runner": "lsf", "tuning": rng.random() < 0.1}
        if rng.random() < 0.1:  # without a token
          user_id, user_name, verified = None, f"ext{rng.randint(1, 50):03d}", 'false'
      elif event == 'batch_start':
        properties = {"kind": rng.choice(kinds)}
      rows.append((event_id, when.isoformat(), when.isoformat(), source, event, user_id, user_name, verified,
                   f"client-{rng.randint(1, 3000)}", project_id, json.dumps(properties)))
    if len(rows) > 200_000:
      flush()
  flush()
  cursor.execute("SELECT setval(pg_get_serial_sequence('usage_events', 'id'), greatest(1, (SELECT max(id) FROM usage_events)))")
  conn.commit()
  conn.autocommit = True
  cursor.execute("VACUUM ANALYZE")
  print(f"Seeded {len(users)} users, {nb_groups} groups, {event_id} usage events over {args.days} days in {time.time() - start:.0f}s", file=sys.stderr)


# ---------------------------------------------------------------------------
# Timing
# ---------------------------------------------------------------------------
def cases():
  today = datetime.datetime.utcnow().date()
  def period(days):
    return {'since': (today - datetime.timedelta(days=days - 1)).isoformat(), 'until': today.isoformat()}
  cases = [('overview', '/api/v1/admin/overview', {})]
  for label, days in [('30d', 30), ('12m', 365)]:
    bucket = 'week' if days > 90 else 'day'
    cases += [
      (f'usage {label}: summary', '/api/v1/admin/usage/summary', period(days)),
      (f'usage {label}: timeseries', '/api/v1/admin/usage/timeseries', {**period(days), 'bucket': bucket}),
      (f'usage {label}: users', '/api/v1/admin/usage/users', period(days)),
      (f'usage {label}: groups', '/api/v1/admin/usage/groups', period(days)),
      (f'usage {label}: projects', '/api/v1/admin/usage/projects', period(days)),
    ]
  cases += [
    ('usage 30d, product: summary', '/api/v1/admin/usage/summary', {**period(30), 'project': 'monorepo'}),
    ('usage 30d, product: projects', '/api/v1/admin/usage/projects', {**period(30), 'project': 'monorepo'}),
    ('usage of a user (admin card)', '/api/v1/admin/usage/users/2', {}),
    ('my usage (settings)', '/api/v1/user/usage', {}),
  ]
  return cases


def run(args):
  import backend
  from backend import app, db_session
  from backend.database import engine, Base
  from backend.models import User
  from backend import tokens as tokens_lib
  from backend.api import admin as admin_api
  from backend.api import usage as usage_api
  from sqlalchemy import event, text
  if not args.keep_indexes:
    sync_indexes(engine, Base.metadata)

  admin = User.query.filter(User.is_admin.is_(True)).first()
  if admin is None:
    raise SystemExit("No admin: run with --seed first")
  _, secret = tokens_lib.mint(admin, 'bench', ['read', 'admin'])
  db_session.commit()
  headers = {'Authorization': f'Bearer {secret}'}

  queries = []
  def before(conn, cursor, statement, parameters, context, executemany):
    context._bench_start = time.perf_counter()
  def after(conn, cursor, statement, parameters, context, executemany):
    queries.append((1000 * (time.perf_counter() - context._bench_start), statement, parameters))
  event.listen(engine, "before_cursor_execute", before)
  event.listen(engine, "after_cursor_execute", after)

  client = app.test_client()
  results = []
  print(f"{'case':<34} {'median':>10} {'min':>10} {'queries':>8} {'slowest query':>14}", file=sys.stderr)
  for name, url, params in cases():
    if args.only and args.only not in name:
      continue
    full_url = f"{url}?{urlencode(params)}" if params else url
    timings, slowest = [], []
    for i in range(args.repeat + 1):  # the first run warms caches
      # the overview and Admin > Usage cache what they compute: we time what the first admin after it expires waits
      if not args.cached:
        admin_api.usage_items.cache_clear()
        usage_api.cached_usage.cache_clear()
      queries.clear()
      start = time.perf_counter()
      response = client.get(full_url, headers=headers)
      elapsed = time.perf_counter() - start
      if response.status_code != 200:
        raise RuntimeError(f"{name}: {response.status_code} {response.data[:500]}")
      if i:
        timings.append(elapsed)
        slowest = sorted(queries, key=lambda q: -q[0])
    result = {
      'case': name, 'url': full_url,
      'median_ms': round(1000 * statistics.median(timings), 1), 'min_ms': round(1000 * min(timings), 1),
      'queries': len(slowest), 'slowest_query_ms': round(slowest[0][0], 1) if slowest else 0,
    }
    results.append(result)
    print(f"{name:<34} {result['median_ms']:>8.1f}ms {result['min_ms']:>8.1f}ms {result['queries']:>8} {result['slowest_query_ms']:>12.1f}ms", file=sys.stderr)
    if args.explain:
      for ms, statement, parameters in slowest:
        if ms < args.explain_ms or not statement.lstrip().upper().startswith(('SELECT', 'WITH')):
          continue
        with engine.connect() as conn:
          raw = conn.connection.cursor()
          raw.execute(f"EXPLAIN (ANALYZE, BUFFERS) {statement}", parameters)
          plan = "\n".join(f"      {row[0]}" for row in raw.fetchall())
        print(f"    {ms:.0f}ms: {' '.join(statement.split())[:160]}\n{plan}", file=sys.stderr)
  with engine.begin() as conn:
    conn.execute(text("DELETE FROM tokens WHERE name = 'bench'"))
  if args.json:
    args.json.write_text(json.dumps(results, indent=2))


if __name__ == '__main__':
  args = parse_args()
  setup_environment(args)
  if args.seed:
    import backend  # noqa: F401 creates the tables
    seed(args)
  run(args)
