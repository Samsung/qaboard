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
Times "Activity" (backend/run_activity.py, api/activity.py): the overview, the grouped runs and the runs, on the
database of bench_api.py, made to look like a busy server's: older runs (tens of millions in production), runs that
wait and run now, runs pending for days ("stuck"), runs that ended recently with when they were queued, started
and ended (and some from clients that don't say), users, `qa batch` commands, job options, and batches started
from QA-Board that didn't start yet.

  uv run backend/benchmarks/bench_api.py --seed --commits 8000   # first, the runs (see there for the database)
  uv run backend/benchmarks/bench_activity.py --seed             # older runs, then what Activity reads, a few minutes
  uv run backend/benchmarks/bench_activity.py                    # times the endpoints with this checkout's backend
  uv run backend/benchmarks/bench_activity.py --seed-activity --legacy 0  # only redo what's recent: every client says when its runs end

For the overview, it also prints how long each of its queries takes.
--explain prints the plans of the queries slower than --explain-ms, e.g. --only "overview all" --explain.
"""
import os
import sys
import json
import time
import argparse
import datetime
import statistics
import functools
from pathlib import Path
from urllib.parse import urlencode

sys.path.insert(0, str(Path(__file__).resolve().parent))
from bench_api import setup_environment, sync_indexes  # noqa: E402

ME = 'user0003'  # scope=me: a user who runs a lot
ADMIN = 'activity-admin'


def parse_args():
  parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
  parser.add_argument('--db', default=os.environ.get('BENCH_DB', 'postgresql://qaboard@localhost:5433/qaboard_bench'))
  parser.add_argument('--backend', type=Path, default=Path(__file__).resolve().parent.parent, help='the backend/ folder to benchmark')
  parser.add_argument('--seed', action='store_true', help='add older runs (--older), then what Activity reads (like --seed-activity)')
  parser.add_argument('--seed-activity', action='store_true', help="only replace what's recent: pending runs, when runs ended, users, job options, submissions")
  parser.add_argument('--older', type=int, default=2, help='copies of the runs of the last 60 days, before them')
  parser.add_argument('--deployed-days', type=float, default=15, help='since when runs say when they were queued, started and ended')
  parser.add_argument('--legacy', type=float, default=0.15, help='share of the recent batches from clients that never say when their runs end')
  parser.add_argument('--stuck-batches', type=int, default=60, help='batches with runs pending for days')
  parser.add_argument('--cluster', action='store_true', help='sort the table by created_date after seeding (needs disk)')
  parser.add_argument('--repeat', type=int, default=5)
  parser.add_argument('--keep-indexes', action='store_true')
  parser.add_argument('--only', help='only run the cases whose name contains this')
  parser.add_argument('--explain', action='store_true', help="print the plans of the slow queries")
  parser.add_argument('--explain-ms', type=float, default=50)
  parser.add_argument('--json', type=Path, help='save the results there')
  return parser.parse_args()


# ---------------------------------------------------------------------------
# Data
# ---------------------------------------------------------------------------
def log(cursor, message, sql, params=None):
  start = time.time()
  cursor.execute(sql, params)
  print(f"  {message}: {cursor.rowcount if cursor.rowcount >= 0 else ''} in {time.time() - start:.0f}s", file=sys.stderr)


def seed_older(cursor, args):
  """Older runs, before the last 60 days: copies of those of bench_api.py, so that the table is as big as in production"""
  cursor.execute("SELECT column_name FROM information_schema.columns WHERE table_name = 'outputs' AND column_name <> 'id' ORDER BY ordinal_position")
  columns = [c for (c,) in cursor.fetchall()]
  values = {'created_date': "o.created_date - k * interval '60 days'", 'is_pending': 'false', 'is_running': 'false',
            'queued_at': 'NULL', 'started_at': 'NULL', 'finished_at': 'NULL'}
  select = ", ".join(values.get(c, f"o.{c}") for c in columns)
  cursor.execute("SELECT max(created_date) - interval '60 days' FROM outputs")
  log(cursor, "older runs", f"""
    INSERT INTO outputs ({', '.join(columns)})
    SELECT {select} FROM outputs o, generate_series(1, %(older)s) k WHERE o.created_date >= %(since)s
  """, {"older": args.older, "since": cursor.fetchone()[0]})


def seed_activity(cursor, args):
  now = datetime.datetime.utcnow()
  deployed = now - datetime.timedelta(days=args.deployed_days)
  params = {"now": now, "deployed": deployed, "legacy": args.legacy, "stuck_batches": args.stuck_batches}
  cursor.execute("SELECT setseed(0.17)")
  # start from scratch: bench_api.py makes 1% of the runs pending, whenever they were created
  log(cursor, "reset", """
    UPDATE outputs SET is_pending = false, is_running = false, queued_at = NULL, started_at = NULL, finished_at = NULL
    WHERE is_pending OR queued_at IS NOT NULL OR finished_at IS NOT NULL
  """)
  # Who started the batches, from where, on which queue. 30% from the CI, a few users run most of the rest.
  cursor.execute("DROP TABLE IF EXISTS bench_batches")
  log(cursor, "batches", """
    CREATE TEMP TABLE bench_batches AS
    SELECT id AS batch_id,
           CASE WHEN random() < 0.3 THEN 'ci' ELSE 'user' || lpad((1 + floor(150 * random() ^ 2.5))::text, 4, '0') END AS user_name,
           md5(id::text) AS command_id,
           CASE WHEN random() < 0.85 THEN 'lsf' ELSE 'local' END AS runner,
           (ARRAY['algo', 'algo_long', 'gpu', 'night', 'short', 'big_mem', 'interactive', 'regression'])[1 + floor(8 * random() ^ 1.5)] AS queue,
           (ARRAY['camera', 'slam', 'isp', 'depth', 'audio'])[1 + floor(5 * random())] AS lsf_project,
           random() < %(legacy)s AS legacy,
           60 + 3000 * random() ^ 2 AS run_seconds,
           CASE WHEN random() < 0.7 THEN 30 * random() ELSE 3600 * random() ^ 2 END AS wait_seconds
    FROM batches WHERE created_date >= %(deployed)s - interval '2 days'
  """, params)
  cursor.execute("ALTER TABLE bench_batches ADD PRIMARY KEY (batch_id); ANALYZE bench_batches")
  log(cursor, "users, commands and job options", """
    UPDATE outputs o SET data = json_build_object(
      'user', b.user_name, 'root_command_id', b.command_id,
      'job_options', json_build_object('type', b.runner, 'queue', CASE WHEN b.runner = 'lsf' THEN b.queue END, 'project', b.lsf_project,
                                       'memory', 8000, 'threads', 4, 'command_id', b.command_id, 'cwd', '/home/' || b.user_name || '/work'))
    FROM bench_batches b WHERE b.batch_id = o.batch_id AND o.created_date >= %(deployed)s - interval '2 days'
  """, params)
  # Since the feature was deployed, clients say when runs were queued, started and ended (not all of them)
  log(cursor, "when runs were queued, started and ended", """
    UPDATE outputs o SET queued_at = t.queued_at, started_at = t.started_at, finished_at = least(t.started_at + t.run * interval '1 second', %(now)s)
    FROM (
      SELECT o.id, o.created_date AS queued_at, least(o.created_date + b.wait_seconds * (0.5 + random()) * interval '1 second', %(now)s) AS started_at,
             b.run_seconds * (0.5 + random()) AS run
      FROM outputs o JOIN bench_batches b ON b.batch_id = o.batch_id
      WHERE o.created_date >= %(deployed)s AND NOT b.legacy AND o.created_date < %(now)s - interval '2 hours'
    ) t WHERE t.id = o.id
  """, params)
  # What runs now: the batches of the last 2 hours. Some still wait in the queue.
  log(cursor, "pending runs", """
    UPDATE outputs o SET is_pending = true, is_running = r.running, queued_at = o.created_date,
           started_at = CASE WHEN r.running THEN o.created_date + random() * (%(now)s - o.created_date) END
    FROM (SELECT id, random() < 0.4 AS running FROM outputs WHERE created_date >= %(now)s - interval '2 hours') r
    WHERE r.id = o.id
  """, params)
  # Stuck: batches whose jobs died without saying so, pending for days
  log(cursor, "stuck runs", """
    UPDATE outputs SET is_pending = true, is_running = random() < 0.7
    WHERE batch_id IN (SELECT id FROM batches WHERE created_date BETWEEN %(now)s - interval '60 days' AND %(now)s - interval '1 day'
                       ORDER BY random() LIMIT %(stuck_batches)s)
      AND created_date >= %(now)s - interval '60 days' AND random() < 0.5
  """, params)
  # Started from QA-Board, their `qa batch` didn't start yet: LSF jobs in the queue
  log(cursor, "submissions", """
    UPDATE batches b SET data = (b.data - 'submissions') || jsonb_build_object('submissions', jsonb_build_object(
      'sub-' || b.id, jsonb_build_object('id', 'sub-' || b.id, 'status', 'submitted', 'user', m.user_name, 'runner', 'lsf',
                                         'lsf_job_id', b.id, 'queue', m.queue, 'created_at', to_char(b.created_date, 'YYYY-MM-DD"T"HH24:MI:SS'))))
    FROM bench_batches m
    WHERE m.batch_id = b.id AND b.id IN (SELECT id FROM batches WHERE created_date >= %(now)s - interval '2 days' ORDER BY random() LIMIT 60)
  """, params)
  cursor.execute("""
    SELECT count(*) FILTER (WHERE is_pending), count(*) FILTER (WHERE is_pending AND created_date < %(now)s - interval '1 day'),
           count(*) FILTER (WHERE finished_at >= %(now)s - interval '1 day'), count(*) FILTER (WHERE finished_at >= %(now)s - interval '7 days'),
           count(*) FILTER (WHERE created_date >= %(now)s - interval '8 days' AND finished_at IS NULL AND NOT is_pending)
    FROM outputs WHERE created_date >= %(now)s - interval '61 days'
  """, params)
  pending, stuck, day, week, legacy = cursor.fetchone()
  print(f"  {pending} pending runs ({stuck} for more than a day), {day} ended in the last 24h, {week} in the last 7 days, "
        f"{legacy} in the last 8 days without finished_at", file=sys.stderr)


def seed(args, older: bool):
  import psycopg2
  start = time.time()
  conn = psycopg2.connect(args.db)
  conn.autocommit = True
  cursor = conn.cursor()
  if older:
    seed_older(cursor, args)
  seed_activity(cursor, args)
  if args.cluster:
    # like on a server, the table is in the order runs were created. Needs as much free disk as the table and its indexes.
    log(cursor, "cluster", "CLUSTER outputs USING ix_outputs_created_date")
  log(cursor, "vacuum", "VACUUM ANALYZE outputs, batches")
  cursor.execute("SELECT count(*), pg_size_pretty(pg_total_relation_size('outputs')) FROM outputs")
  print(f"Seeded in {time.time() - start:.0f}s: {'%s outputs, %s with indexes' % cursor.fetchone()}", file=sys.stderr)


def ensure_users(db_session):
  from backend.models import User
  for user_name, admin in [(ADMIN, True), (ME, False)]:
    user = User.query.filter(User.user_name == user_name).first()
    if user is None:
      db_session.add(User(user_name=user_name, full_name=user_name, email=f"{user_name}@example.com", login_type='local', is_admin=admin))
    else:
      user.is_admin = admin
  db_session.commit()


# ---------------------------------------------------------------------------
# Timing
# ---------------------------------------------------------------------------
def cases():
  cases = []
  for window in ['24h', '7d']:
    cases += [
      (f'overview me {window}', 'user', '/api/v1/activity/overview', {'scope': 'me', 'window': window}),
      (f'overview all {window}', 'admin', '/api/v1/activity/overview', {'scope': 'all', 'window': window}),
    ]
  for group in ['batch', 'user', 'queue']:
    cases.append((f'items all 24h by {group}', 'admin', '/api/v1/activity/items', {'scope': 'all', 'group': group}))
  cases += [
    ('items all 7d by batch', 'admin', '/api/v1/activity/items', {'scope': 'all', 'group': 'batch', 'window': '7d'}),
    ('items me 24h by batch', 'user', '/api/v1/activity/items', {'scope': 'me', 'group': 'batch'}),
    ('runs all 24h', 'admin', '/api/v1/activity/runs', {'scope': 'all'}),
    ('runs all 7d', 'admin', '/api/v1/activity/runs', {'scope': 'all', 'window': '7d'}),
    ('runs me 24h', 'user', '/api/v1/activity/runs', {'scope': 'me'}),
  ]
  return cases


def run(args):
  import backend  # noqa: F401
  from backend import app, db_session
  from backend.database import engine, Base
  from backend.models import User
  from backend import tokens as tokens_lib
  from backend import run_activity
  from sqlalchemy import event, text
  if not args.keep_indexes:
    sync_indexes(engine, Base.metadata)
  ensure_users(db_session)
  headers = {}
  for who, user_name in [('admin', ADMIN), ('user', ME)]:
    user = User.query.filter(User.user_name == user_name).one()
    _, secret = tokens_lib.mint(user, 'bench', ['read'])
    headers[who] = {'Authorization': f'Bearer {secret}'}
  db_session.commit()

  # which function of run_activity.py runs each query, and how long they take
  current = [None]
  calls = []
  def timed(name, function):
    @functools.wraps(function)
    def wrapper(*a, **kw):
      label = f"{name}({a[1]})" if name == 'breakdown' else name
      current[0], start = label, time.perf_counter()
      try:
        return function(*a, **kw)
      finally:
        calls.append((label, 1000 * (time.perf_counter() - start)))
        current[0] = None
    return wrapper
  for name in ['totals', 'timeline', 'starting_soon', 'breakdown', 'active_before', 'items', 'runs', 'output_dir_urls']:
    setattr(run_activity, name, timed(name, getattr(run_activity, name)))

  queries = []
  def before(conn, cursor, statement, parameters, context, executemany):
    context._bench_start = time.perf_counter()
  def after(conn, cursor, statement, parameters, context, executemany):
    queries.append((1000 * (time.perf_counter() - context._bench_start), current[0], statement, parameters))
  event.listen(engine, "before_cursor_execute", before)
  event.listen(engine, "after_cursor_execute", after)

  client = app.test_client()
  results = []
  print(f"{'case':<26} {'median':>9} {'min':>9} {'queries':>8} {'size':>8}", file=sys.stderr)
  for name, who, url, params in cases():
    if args.only and args.only not in name:
      continue
    full_url = f"{url}?{urlencode(params)}"
    timings, per_call = [], {}
    for i in range(args.repeat + 1):  # the first run warms caches
      queries.clear()
      calls.clear()
      start = time.perf_counter()
      response = client.get(full_url, headers=headers[who])
      elapsed = time.perf_counter() - start
      if response.status_code != 200:
        raise RuntimeError(f"{name}: {response.status_code} {response.data[:500]}")
      if i:
        timings.append(elapsed)
        for label, ms in calls:
          per_call.setdefault(label, []).append(ms)
    result = {
      'case': name, 'url': full_url,
      'median_ms': round(1000 * statistics.median(timings), 1), 'min_ms': round(1000 * min(timings), 1),
      'queries': len(queries), 'bytes': len(response.data),
      'calls': {label: round(statistics.median(ms), 1) for label, ms in per_call.items()},
    }
    results.append(result)
    print(f"{name:<26} {result['median_ms']:>7.1f}ms {result['min_ms']:>7.1f}ms {result['queries']:>8} {len(response.data) / 1e3:>6.0f}kB", file=sys.stderr)
    if len(result['calls']) > 1:
      print("    " + "  ".join(f"{label} {ms:.0f}ms" for label, ms in result['calls'].items()), file=sys.stderr)
    if args.explain:
      for ms, label, statement, parameters in sorted(queries, key=lambda q: -q[0]):
        if ms < args.explain_ms or not statement.lstrip().upper().startswith(('SELECT', 'WITH')):
          continue
        with engine.connect() as conn:
          raw = conn.connection.cursor()
          raw.execute(f"EXPLAIN (ANALYZE, BUFFERS) {statement}", parameters)
          plan = "\n".join(f"      {row[0]}" for row in raw.fetchall())
        print(f"    {ms:.0f}ms {label}: {' '.join(statement.split())[:120]}\n{plan}", file=sys.stderr)
  with engine.begin() as conn:
    conn.execute(text("DELETE FROM tokens WHERE name = 'bench'"))
  if args.json:
    args.json.write_text(json.dumps(results, indent=2))


if __name__ == '__main__':
  args = parse_args()
  setup_environment(args)
  if args.seed or args.seed_activity:
    import backend  # noqa: F401 creates the tables
    seed(args, older=args.seed)
  run(args)
