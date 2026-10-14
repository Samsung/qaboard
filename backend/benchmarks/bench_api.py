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
#   "polyleven",
#   "celery",
#   "scipy",
#   "scikit-image",
#   "pillow",
# ]
# ///
"""
Times the API endpoints behind the projects list, the lists of commits and the branch filter,
through Flask's test client, on a Postgres database filled with realistic data:
many projects, and one big project from a monorepo with thousands of commits, batches and outputs.

  # A throwaway Postgres (any version >= 12), e.g. on port 5433:
  initdb -D /tmp/qaboard-bench -U qaboard --auth=trust
  pg_ctl -D /tmp/qaboard-bench -o "-p 5433 -c shared_buffers=512MB" start

  uv run backend/benchmarks/bench_api.py --seed     # (re)creates and fills the database, a few minutes
  uv run backend/benchmarks/bench_api.py            # times the endpoints with this checkout's backend
  # Compare with another version of the code, e.g. before your changes:
  git worktree add /tmp/qaboard-base master
  uv run backend/benchmarks/bench_api.py --backend /tmp/qaboard-base/backend

Before timing, the database's indexes are made to match the models of the backend under test
(--keep-indexes to skip), so that the same data can be used to compare versions.
The real backend imports python-ldap and python3-saml, which need system libraries: we stub them.
"""
import io
import os
import sys
import json
import time
import types
import random
import argparse
import datetime
import statistics
from pathlib import Path
from urllib.parse import urlparse, urlencode


BIG_PROJECT = 'monorepo/algo/big'
METRICS = ['psnr', 'ssim', 'loss', 'runtime', 'memory', 'recall', 'precision', 'f1', 'rmse', 'latency']


def parse_args():
  parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
  parser.add_argument('--db', default=os.environ.get('BENCH_DB', 'postgresql://qaboard@localhost:5433/qaboard_bench'))
  parser.add_argument('--backend', type=Path, default=Path(__file__).resolve().parent.parent, help='the backend/ folder to benchmark')
  parser.add_argument('--seed', action='store_true', help='drop everything and fill the database')
  parser.add_argument('--projects', type=int, default=800)
  parser.add_argument('--commits', type=int, default=5000, help='commits in the big project')
  parser.add_argument('--batches', type=int, default=3, help='batches per commit in the big project')
  parser.add_argument('--outputs', type=int, default=200, help='outputs per batch in the big project')
  parser.add_argument('--repeat', type=int, default=5)
  parser.add_argument('--keep-indexes', action='store_true')
  parser.add_argument('--only', help='only run the cases whose name contains this')
  parser.add_argument('--json', type=Path, help='save the results there')
  return parser.parse_args()


def setup_environment(args):
  url = urlparse(args.db)
  os.environ.update({
    'QABOARD_DB_HOST': url.hostname or 'localhost',
    'QABOARD_DB_PORT': str(url.port or 5432),
    'QABOARD_DB_USER': url.username or 'qaboard',
    'QABOARD_DB_PASSWORD': url.password or '',
    'QABOARD_DB_NAME': url.path.lstrip('/'),
    'QABOARD_DATA_DIR': os.environ.get('QABOARD_DATA_DIR', str(Path(os.environ.get('TMPDIR', '/tmp')) / 'qaboard-bench-data')),
    'SECRET_KEY': 'benchmark',
    'REDIS_HOST': os.environ.get('REDIS_HOST', '127.0.0.1'),
  })
  # Not needed for those endpoints, and they need system libraries to build
  for name in ['ldap', 'onelogin', 'onelogin.saml2', 'onelogin.saml2.auth', 'onelogin.saml2.utils']:
    sys.modules[name] = types.ModuleType(name)
  sys.modules['onelogin.saml2.auth'].OneLogin_Saml2_Auth = None
  sys.modules['onelogin.saml2.utils'].OneLogin_Saml2_Utils = None
  # The backend imports qaboard (the CLI package) from the repository
  sys.path[:0] = [str(args.backend), str(args.backend.parent)]


def reset_database(args):
  import psycopg2
  with psycopg2.connect(args.db) as conn, conn.cursor() as cursor:
    cursor.execute("DROP SCHEMA public CASCADE; CREATE SCHEMA public;")


# ---------------------------------------------------------------------------
# Data
# ---------------------------------------------------------------------------
words = ("fix add remove refactor update improve tune speed up denoise demosaic calibration pipeline tests ci "
         "kernel memory leak regression crash metrics threshold sensor isp hdr autofocus tracking slam depth "
         "model training inference quantization export config cleanup docs typo merge revert wip").split()
first_names = "alice bob carol dave erin frank grace heidi ivan judy mallory nina oscar peggy rupert sybil trent victor walter yael".split()
last_names = "cohen levi mizrahi peretz biton friedman shapiro katz azoulay dahan ohana segal golan amar weiss".split()


def git_payload(path_with_namespace, rng):
  # what GitLab webhooks give us (we keep it in Project.data.git)
  name = path_with_namespace.split('/')[-1]
  return {
    "id": rng.randint(1, 100000), "name": name, "description": " ".join(rng.choices(words, k=12)),
    "web_url": f"https://gitlab.example.com/{path_with_namespace}",
    "avatar_url": f"https://gitlab.example.com/uploads/project/avatar/{rng.randint(1, 999)}/logo.png" if rng.random() < 0.5 else None,
    "git_ssh_url": f"git@gitlab.example.com:{path_with_namespace}.git",
    "git_http_url": f"https://gitlab.example.com/{path_with_namespace}.git",
    "namespace": path_with_namespace.split('/')[0], "visibility_level": 10,
    "path_with_namespace": path_with_namespace, "default_branch": "master",
    "ci_config_path": None, "homepage": f"https://gitlab.example.com/{path_with_namespace}",
    "url": f"git@gitlab.example.com:{path_with_namespace}.git",
    "ssh_url": f"git@gitlab.example.com:{path_with_namespace}.git",
    "http_url": f"https://gitlab.example.com/{path_with_namespace}.git",
  }


def qaboard_config(project_id, rng):
  return {
    "project": {
      "name": project_id, "url": f"git@gitlab.example.com:{project_id}",
      "reference_branch": "master", "milestones": ["v1.0", "v2.0"],
      "entrypoint": "qa/main.py", "description": " ".join(rng.choices(words, k=8)),
    },
    "storage": {"linux": "/mnt/qaboard"},
    "inputs": {
      "types": {t: {"globs": ["*.raw", "*.dng", "*.bin"], "database": {"linux": f"/data/{t}"}, "metadata": {"sensor": "imx"}} for t in ["raw", "video", "depth", "imu"]},
      "batches": [f"qa/batches/{b}.yaml" for b in ["ci", "nightly", "tuning", "regression", "full"]],
    },
    "outputs": {
      "visualizations": [{"name": f"view {i}", "path": f"output_{i}.png", "type": "image/png"} for i in range(30)],
      "metrics": "qa/metrics.yaml", "default_tab_details": "summary",
    },
    "runners": {"default": "lsf", "lsf": {"queue": "algo", "memory": 8000, "threads": 4}, "local": {"concurrency": 8}},
    "integrations": [{"text": f"Integration {i}", "href": f"https://jenkins.example.com/job/{i}", "icon": "build"} for i in range(8)],
    "bit_accuracy": {"patterns": ["*.raw", "*.yuv"], "plots": [{"x": "frame", "y": "error"}]},
  }


def qaboard_metrics(rng):
  available = {}
  for i in range(60):
    key = METRICS[i] if i < len(METRICS) else f"metric_{i}"
    available[key] = {"label": f"{key} label", "short_label": key, "smaller_is_better": i % 2 == 0, "target": rng.random(), "plot_scale": 1, "plot_unit": "dB", "suffix": "", "scale": 1}
  return {"available_metrics": available, "main_metrics": METRICS[:4], "dashboard_metrics": METRICS[:6], "summary_metrics": METRICS}


def copy_rows(cursor, table, columns, rows):
  buffer = io.StringIO()
  for row in rows:
    buffer.write("\t".join("\\N" if v is None else str(v).replace("\\", "\\\\").replace("\t", " ").replace("\n", " ") for v in row))
    buffer.write("\n")
  buffer.seek(0)
  cursor.copy_expert(f"COPY {table} ({','.join(columns)}) FROM STDIN", buffer)


def seed(args):
  import psycopg2
  rng = random.Random(42)
  now = datetime.datetime.now(datetime.timezone.utc)
  start = time.time()
  conn = psycopg2.connect(args.db)
  cursor = conn.cursor()

  # Projects: many repositories, and a monorepo with lots of subprojects
  project_ids = [BIG_PROJECT]
  nb_monorepo = args.projects // 3
  project_ids += [f"monorepo/algo/sub{i:03d}" for i in range(nb_monorepo)]
  project_ids += [f"group{i % 40}/repo{i:03d}" for i in range(args.projects - len(project_ids))]
  projects = []
  for project_id in project_ids:
    root = 'monorepo/algo' if project_id.startswith('monorepo/') else project_id
    data = {
      "git": git_payload(root, rng),
      "qatools_config": qaboard_config(project_id, rng),
      "qatools_metrics": qaboard_metrics(rng),
      "milestones": {f"m{i}": {"commit": f"{rng.getrandbits(160):040x}", "label": f"milestone {i}", "owners": [{"user_name": "alice"}]} for i in range(3)},
    }
    projects.append((project_id, json.dumps(data), now.isoformat()))
  copy_rows(cursor, 'projects', ['id', 'data', 'latest_output_datetime'], projects)

  test_inputs = [(i + 1, f"/data/raw", f"scenes/scene_{i:04d}.raw", json.dumps({"metadata": {"lux": rng.randint(1, 1000)}})) for i in range(300)]
  copy_rows(cursor, 'test_inputs', ['id', 'database', 'path', 'data'], test_inputs)

  committers = [f"{f} {l}" for f in first_names for l in last_names][:300]
  feature_branches = [f"feature/{rng.choice(words)}-{rng.choice(words)}-{i}" for i in range(1500)]
  commit_id, batch_id, output_id = 0, 0, 0
  commits, batches, outputs = [], [], []
  commit_dirs = {}

  def add_commit(project_id, authored, branch, data):
    nonlocal commit_id
    commit_id += 1
    hexsha = f"{rng.getrandbits(160):040x}"
    # the CLI tells us where it saves artifacts and outputs
    commit_dirs[commit_id] = f"/mnt/qaboard/{project_id}/{hexsha[:2]}/{hexsha[2:8]}"
    message = f"{rng.choice(words).capitalize()} {' '.join(rng.choices(words, k=rng.randint(2, 10)))}"
    commits.append((commit_id, hexsha, project_id, json.dumps(data), authored.isoformat(),
                    rng.choice(committers), message, branch, '[]', 'git', authored.isoformat(), 'false', commit_dirs[commit_id]))
    return commit_id

  def add_batch(ci_commit_id, label, created, nb_outputs):
    nonlocal batch_id, output_id
    batch_id += 1
    batches.append((batch_id, created.isoformat(), '{}', ci_commit_id, label))
    for _ in range(nb_outputs):
      output_id += 1
      failed = rng.random() < 0.03
      pending = not failed and rng.random() < 0.01
      metrics = {} if failed else {m: round(rng.gauss(10, 3), 4) for m in METRICS}
      if metrics and rng.random() < 0.05:
        metrics['psnr'] = None
      if metrics:
        metrics['status'] = 'ok' # not numeric: not aggregated
        metrics['is_bit_accurate'] = rng.random() < 0.5
      outputs.append((output_id, batch_id, rng.randint(1, len(test_inputs)), created.isoformat(), 'false', 'slam/6dof', 'linux',
                      '["base"]', '{}', str(pending).lower(), 'false', str(failed).lower(), json.dumps(metrics), '{"user": "ci"}',
                      f"{commit_dirs[ci_commit_id]}/output/{label}/{output_id}"))

  def flush(final=False):
    if final or len(outputs) > 200_000:
      copy_rows(cursor, 'ci_commits', ['id', 'hexsha', 'project_id', 'data', 'authored_datetime', 'committer_name', 'message', 'branch', 'parents', 'commit_type', 'latest_output_datetime', 'deleted', 'commit_dir_override'], commits)
      copy_rows(cursor, 'batches', ['id', 'created_date', 'data', 'ci_commit_id', 'label'], batches)
      copy_rows(cursor, 'outputs', ['id', 'batch_id', 'test_input_id', 'created_date', 'deleted', 'output_type', 'platform', 'configurations', 'extra_parameters', 'is_pending', 'is_running', 'is_failed', 'metrics', 'data', 'output_dir_override'], outputs)
      commits.clear(); batches.clear(); outputs.clear()

  # The big project: commits over the last 60 days, ~1/3 on master, ~10% without results
  big_data = {"qatools_config": qaboard_config(BIG_PROJECT, rng), "qatools_metrics": qaboard_metrics(rng), "git": {"path_with_namespace": "monorepo/algo"}}
  for i in range(args.commits):
    authored = now - datetime.timedelta(days=60) * (i / args.commits) - datetime.timedelta(minutes=rng.randint(0, 30))
    branch = 'master' if rng.random() < 0.35 else rng.choice(feature_branches)
    if rng.random() < 0.2:
      branch = f"origin/{branch}"
    cid = add_commit(BIG_PROJECT, authored, branch, big_data)
    if rng.random() < 0.1:
      continue
    labels = ['default', *[f"tuning-{rng.choice(words)}-{j}" for j in range(args.batches - 1)]]
    for label in labels:
      add_batch(cid, label, authored + datetime.timedelta(minutes=5), args.outputs)
    flush()

  # The other projects: up to a few hundred commits over the last year, one small batch each
  for project_id in project_ids[1:]:
    data = {"qatools_config": qaboard_config(project_id, rng), "qatools_metrics": qaboard_metrics(rng)}
    for i in range(rng.randint(1, 200)):
      authored = now - datetime.timedelta(days=rng.random() * 365)
      cid = add_commit(project_id, authored, 'master' if rng.random() < 0.6 else rng.choice(feature_branches[:50]), data)
      add_batch(cid, 'default', authored, rng.randint(1, 10))
    flush()
  flush(final=True)
  for table in ['ci_commits', 'batches', 'outputs', 'test_inputs']:
    cursor.execute(f"SELECT setval(pg_get_serial_sequence('{table}', 'id'), (SELECT max(id) FROM {table}))")
  conn.commit()
  conn.autocommit = True
  cursor.execute("VACUUM ANALYZE")
  print(f"Seeded {len(project_ids)} projects, {commit_id} commits, {batch_id} batches, {output_id} outputs in {time.time() - start:.0f}s", file=sys.stderr)


def sync_indexes(engine, metadata):
  """Make the indexes on our tables match the models of the backend we test."""
  from sqlalchemy import text
  tables = ['projects', 'ci_commits', 'batches', 'outputs']
  wanted = {index.name: index for name in tables for index in metadata.tables[name].indexes}
  changed = []
  with engine.connect() as conn:
    existing = conn.execute(text("""
      SELECT i.relname FROM pg_index x
      JOIN pg_class i ON i.oid = x.indexrelid JOIN pg_class t ON t.oid = x.indrelid
      WHERE t.relname = ANY(:tables) AND NOT EXISTS (SELECT 1 FROM pg_constraint c WHERE c.conindid = x.indexrelid)
    """), {"tables": tables}).scalars().all()
    for name in existing:
      if name not in wanted:
        conn.execute(text(f'DROP INDEX "{name}"'))
        changed.append(f"-{name}")
    for name, index in wanted.items():
      if name not in existing:
        index.create(conn)
        changed.append(f"+{name}")
    if changed:
      conn.execute(text("ANALYZE"))
    conn.commit()
  if changed:
    print(f"Indexes: {' '.join(changed)}", file=sys.stderr)


# ---------------------------------------------------------------------------
# Timing
# ---------------------------------------------------------------------------
def cases():
  now = datetime.datetime.now(datetime.timezone.utc)
  iso = lambda d: d.strftime('%Y-%m-%dT%H:%M:%S.%f')[:-3] + '000Z'
  # what the webapp sends: the last 3 days, and the main metrics
  day_start = now.replace(hour=0, minute=0, second=0, microsecond=0)
  default_range = {'from': iso(day_start - datetime.timedelta(days=3)), 'to': iso(day_start + datetime.timedelta(hours=23, minutes=59))}
  metrics = json.dumps({m: 0 for m in METRICS[:4]})
  project = {'project': BIG_PROJECT}
  return [
    ('projects', '/api/v1/projects', {}),
    ('projects?summary', '/api/v1/projects', {'summary': 'true'}),
    ('commits: last 3 days', '/api/v1/commits', {**project, **default_range}),
    ('commits: last 3 days + metrics', '/api/v1/commits', {**project, **default_range, 'metrics': metrics}),
    ('commits: page 1 (50)', '/api/v1/commits', {**project, **default_range, 'metrics': metrics, 'limit': 50}),
    ('commits: page 3 (50)', '/api/v1/commits', {**project, **default_range, 'metrics': metrics, 'limit': 50, 'offset': 100}),
    ('commits: search "speed"', '/api/v1/commits', {**project, 'metrics': metrics, 'q': 'speed', 'limit': 50}),
    ('commits: search qualifiers', '/api/v1/commits', {**project, 'metrics': metrics, 'q': 'branch:feature committer:alice -wip', 'limit': 50}),
    ('commits: search rare', '/api/v1/commits', {**project, 'metrics': metrics, 'q': 'zzzz-no-match', 'limit': 50}),
    ('commits: branch master', '/api/v1/commits/master', {**project, **default_range, 'metrics': metrics}),
    ('commits: history (outputs)', '/api/v1/commits/master', {**project, **default_range, 'metrics': json.dumps({m: 0 for m in METRICS[:6]}), 'with_outputs': 'true', 'only_ci_batches': 'true'}),
    ('commit: latest on master', '/api/v1/commit/', {**project, 'branch': 'master'}),
    ('branches', '/api/v1/project/branches', project),
    ('branches?q&limit', '/api/v1/project/branches', {**project, 'q': 'speed', 'limit': 50}),
  ]


def run(args):
  import backend
  from backend import app
  from backend.database import engine, Base
  from sqlalchemy import event
  if not args.keep_indexes:
    sync_indexes(engine, Base.metadata)

  nb_queries = 0
  def count(*_args, **_kwargs):
    nonlocal nb_queries
    nb_queries += 1
  event.listen(engine, "before_cursor_execute", count)

  client = app.test_client()
  results = []
  print(f"{'case':<34} {'median':>9} {'min':>9} {'queries':>8} {'items':>6} {'size':>9}  has-more", file=sys.stderr)
  for name, url, params in cases():
    if args.only and args.only not in name:
      continue
    full_url = f"{url}?{urlencode(params)}" if params else url
    timings = []
    for i in range(args.repeat + 1): # the first run warms caches
      nb_queries = 0
      start = time.perf_counter()
      response = client.get(full_url)
      elapsed = time.perf_counter() - start
      if response.status_code != 200:
        raise RuntimeError(f"{name}: {response.status_code} {response.data[:500]}")
      if i:
        timings.append(elapsed)
    body = response.get_json()
    result = {
      'case': name, 'url': full_url,
      'median_ms': round(1000 * statistics.median(timings), 1), 'min_ms': round(1000 * min(timings), 1),
      'queries': nb_queries, 'items': len(body), 'bytes': len(response.data),
      'has_more': response.headers.get('X-Has-More'),
    }
    results.append(result)
    print(f"{name:<34} {result['median_ms']:>7.1f}ms {result['min_ms']:>7.1f}ms {nb_queries:>8} {len(body):>6} {len(response.data) / 1e6:>7.2f}MB  {result['has_more'] or ''}", file=sys.stderr)
  if args.json:
    args.json.write_text(json.dumps(results, indent=2))


if __name__ == '__main__':
  args = parse_args()
  setup_environment(args)
  if args.seed:
    reset_database(args)
    import backend # creates the tables
    seed(args)
  run(args)
