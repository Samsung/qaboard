#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["psycopg2-binary>=2.9"]
# ///
"""
A local QA-Board development server, without docker compose: PostgreSQL, the backend from this checkout, a small
proxy in place of nginx, the jobs worker and the web app's dev server; and a small dataset made with the real `qa`.

  uv run scripts/dev.py up        # starts what isn't running (idempotent), prints the URLs and the admin's login
  uv run scripts/dev.py seed      # 2 projects, commits on main and a branch, batches with metrics, images, files
  uv run scripts/dev.py status    # what runs, URLs, credentials       (--json for scripts)
  uv run scripts/dev.py env       # shell exports: qa against this server, psql, the backend's integration tests
  uv run scripts/dev.py logs backend
  uv run scripts/dev.py down      # stops everything, keeps the data
  uv run scripts/dev.py reset     # down, then deletes the database and the results

  up --no-web --no-worker         # only the database, the backend and the proxy
  up --port 5161 --web-port 3010  # next to another checkout's server
  up --postgres docker            # PostgreSQL in a container (default: the local binaries if found, else docker)

  http://localhost:3000   the web app (Vite; proxies /api and /s/ to :5151)
  http://localhost:5151   the server, as nginx serves it: the API (flask, on :5152), and the runs' files under /s/

Everything lives in .dev/ at the repository's root (gitignored; QABOARD_DEV_DIR to change it): state.json (ports, this
server's id), postgres/, data/ (QABOARD_DATA_DIR), results/ (uploads), logs/, pids/, seed/ (the seeded git repos).
It never talks to another database: seed checks that the database is the one `up` made (its comment holds this
server's id), that the server is on this machine, and that it knows this server's token.
Agents: .claude/skills/dev-server/SKILL.md.
"""
import argparse
import hashlib
import http.client
import json
import os
import re
import shutil
import signal
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from http.cookiejar import CookieJar
from pathlib import Path
from typing import Dict, List, Optional

REPO = Path(__file__).resolve().parents[1]
STATE_DIR = Path(os.environ.get('QABOARD_DEV_DIR') or REPO / '.dev')
SEED_TEMPLATES = Path(__file__).resolve().parent / 'dev_seed'
FILESERVER = REPO / 'docs-media' / 'demo' / 'local-stack' / 'fileserver.py'

DB_USER, DB_PASSWORD, DB_NAME = 'qaboard', 'password', 'qaboard'
ADMIN_USER, ADMIN_PASSWORD = 'admin', 'qaboard-dev'
DOCKER_IMAGE = 'postgres:12-alpine'   # like docker-compose.yml
MARKER_PREFIX = 'qaboard-dev '
SERVICES = ('redis', 'backend', 'proxy', 'jobs-worker', 'webapp')
# Variables that point `qa` or the backend somewhere else, or say they run in a CI: never inherited
SCRUBBED_ENV = re.compile(r'^(QABOARD_.*|QA_.*|CI|CI_.*|GITHUB_.*|GITLAB_.*|GIT_.*|JENKINS_.*|BUILD_URL|REDIS_.*|FLASK_.*|'
                          r'SECRET_KEY|SENTRY_.*|VIRTUAL_ENV.*|REACT_APP_.*|MLFLOW_.*|WANDB_.*|DATABASE_URL|PG.*)$')
LOOPBACK = {'localhost', '127.0.0.1', '::1'}
LOG_SEPARATOR = '=== dev.py:'


def log(message: str, color: str = ''):
  codes = {'red': '31', 'green': '32', 'yellow': '33', 'dim': '2', 'bold': '1'}
  if color and sys.stderr.isatty():
    message = f"\033[{codes[color]}m{message}\033[0m"
  print(f"[dev] {message}", file=sys.stderr, flush=True)


def fail(message: str, hint: str = ''):
  log(f"ERROR: {message}", 'red')
  if hint:
    log(f"  hint: {hint}", 'yellow')
  sys.exit(1)


# ------------------------------------------------------------------------------------------------ pure helpers

def clean_env(base: Dict[str, str], **extra: str) -> Dict[str, str]:
  """The environment without what points to another server or database, plus `extra`"""
  env = {k: v for k, v in base.items() if not SCRUBBED_ENV.match(k)}
  no_proxy = ','.join(sorted(LOOPBACK))
  env.update({'NO_PROXY': no_proxy, 'no_proxy': no_proxy, 'PYTHONUNBUFFERED': '1'})
  env.update(extra)
  return env


def is_loopback_url(url: str) -> bool:
  return (urllib.parse.urlsplit(url).hostname or '').lower() in LOOPBACK


def marker(server_id: str) -> str:
  return f"{MARKER_PREFIX}{server_id}"


def refusal(state: Optional[dict], db_comment: Optional[str], server_url: str) -> Optional[str]:
  """Why seed must not write to this server, else None"""
  if not state or not state.get('id'):
    return f"no development server in {STATE_DIR}: run `uv run scripts/dev.py up` first"
  if not is_loopback_url(server_url):
    return f"{server_url} isn't on this machine: dev.py only seeds the server it started"
  if db_comment != marker(state['id']):
    return (f"the database on 127.0.0.1:{state['postgres']['port']} isn't the one dev.py made for {STATE_DIR} "
            f"(its comment is {db_comment!r}, expected {marker(state['id'])!r})")
  return None


def last_start(text: str, lines: int) -> str:
  """The last `lines` lines of a log, since the service last started"""
  since = text.rsplit(LOG_SEPARATOR, 1)[-1] if LOG_SEPARATOR in text else text
  if LOG_SEPARATOR in text:
    since = LOG_SEPARATOR + since
  return '\n'.join(since.splitlines()[-lines:])


def proxy_route(method: str, path: str) -> str:
  """Where the proxy sends a request: 'files' (the runs' files, GET /s/...), 'backend', or 'webapp' (the app's pages)"""
  path = urllib.parse.urlsplit(path).path
  if path.startswith('/s/') and method in ('GET', 'HEAD'):
    return 'files'
  # Vite proxies /iiif/ and /docs/ here: redirecting them to the web app would loop. No IIIF server, no docs: 404s
  if path.startswith(('/api/', '/s/', '/webhook', '/iiif/', '/docs/')) or method not in ('GET', 'HEAD'):
    return 'backend'
  return 'webapp'


def pick_ports(port: int, web_port: int) -> Dict[str, int]:
  """The proxy (what clients call "the server") on `port`, flask right after it, the web app on `web_port`"""
  return {'server': port, 'backend': port + 1, 'web': web_port}


def postgres_bin_dirs(root: Path = Path('/usr/lib/postgresql')) -> List[Path]:
  """Debian/Ubuntu's /usr/lib/postgresql/<major>/bin, newest first"""
  dirs = [p for p in root.glob('*/bin') if p.parent.name.isdigit() and (p / 'initdb').exists()]
  return sorted(dirs, key=lambda p: int(p.parent.name), reverse=True)


# Each project's history: commits in order, `flags` merged into the previous commit's (build/flags.json), `branch`
# starts a branch at the commit before (merge-base: the main commit before it). Times are hours before seeding.
STORIES = {
  'image-pipeline': {
    'project': 'dev/image-pipeline',
    'commits': [
      dict(branch='main', hours=150, author='Noor Haddad', message='Box denoise and unsharp mask',
           flags={'denoise': 'box', 'strength': 1.0, 'sharpen': 0.8}, batches=['ci']),
      dict(branch='main', hours=100, author='Lin Okafor', message='sharpen: lower the default boost (halos)',
           flags={'sharpen': 0.5}, batches=['ci']),
      dict(branch='main', hours=50, author='Noor Haddad', message='denoise: bilateral filter on luma (+1.2 dB in low light)',
           flags={'denoise': 'bilateral'}, batches=['ci']),
      dict(branch='feat/stronger-denoise', hours=26, author='Lin Okafor', message='denoise: double the strength in low light',
           flags={'strength': 2.0}, batches=['ci', 'tune-strength']),
      dict(branch='feat/stronger-denoise', hours=3, author='Lin Okafor', message='sharpen: clamp the boost near strong edges',
           flags={'sharpen': 0.3}, batches=['ci']),
    ],
  },
  'test-suite': {
    'project': 'dev/test-suite',
    'commits': [
      dict(branch='main', hours=120, author='Sam Ferreira', message="Add the codec's unit and integration tests",
           flags={}, batches=['ci']),
      dict(branch='main', hours=72, author='Sam Ferreira', message='client: retry uploads with backoff',
           flags={'flaky': ['test_upload_resume']}, batches=['ci']),
      dict(branch='perf/table-varint', hours=20, author='Lin Okafor', message='decoder: table-driven varint decode (-40% time)',
           flags={'slowdown': 0.6, 'broken': ['test_unicode_names']}, batches=['ci']),
    ],
  },
}


def plan(story: dict) -> List[dict]:
  """The story's commits with their effective flags (the previous commit's on the same line, plus their own)"""
  effective, out, main_flags = {}, [], {}
  for commit in story['commits']:
    base = main_flags if commit['branch'] == 'main' else effective
    if commit['branch'] != 'main' and (not out or out[-1]['branch'] == 'main'):
      base = main_flags
    effective = {**base, **commit['flags']}
    if commit['branch'] == 'main':
      main_flags = effective
    out.append({**commit, 'effective_flags': effective})
  return out


def email_of(name: str) -> str:
  return f"{name.split()[0].lower()}@example.com"


# ------------------------------------------------------------------------------------------------ state, processes

def state_path() -> Path:
  return STATE_DIR / 'state.json'


def load_state() -> Optional[dict]:
  try:
    return json.loads(state_path().read_text())
  except (FileNotFoundError, json.JSONDecodeError):
    return None


def write_private(path: Path, text: str):
  """Writes a file only its owner can read, from the start: chmod after writing leaves a moment others can read it"""
  path.parent.mkdir(parents=True, exist_ok=True)
  fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | getattr(os, 'O_NOFOLLOW', 0), 0o600)
  with os.fdopen(fd, 'w') as f:
    os.fchmod(f.fileno(), 0o600)  # it may exist with other permissions
    f.write(text)


def save_state(state: dict):
  STATE_DIR.mkdir(parents=True, exist_ok=True)
  state_path().write_text(json.dumps(state, indent=2) + '\n')


def process_start(pid: int) -> Optional[str]:
  """When the process started (Linux), to tell our process from another one that got its pid; None if it's a zombie"""
  try:
    fields = Path(f'/proc/{pid}/stat').read_text().rsplit(')', 1)[1].split()
  except (OSError, IndexError):
    return ''
  return None if fields[0] == 'Z' else fields[19]


def pid_of(name: str) -> Optional[int]:
  """The pid of the service we started, if it still runs"""
  try:
    pid, *started = (STATE_DIR / 'pids' / f'{name}.pid').read_text().split()
    pid = int(pid)
    os.kill(pid, 0)
  except (FileNotFoundError, ValueError, ProcessLookupError, PermissionError):
    return None
  now = process_start(pid)
  if now is None or (started and now and started[0] != now):
    return None
  return pid


def spawn(name: str, args: List[str], cwd: Path, env: Dict[str, str]):
  if pid_of(name):
    log(f"{name} is running (pid {pid_of(name)})", 'dim')
    return
  for d in ('logs', 'pids'):
    (STATE_DIR / d).mkdir(parents=True, exist_ok=True)
  log_file = (STATE_DIR / 'logs' / f'{name}.log').open('ab')
  log_file.write(f"{LOG_SEPARATOR} {name} started at {time.strftime('%Y-%m-%d %H:%M:%S')}\n".encode())
  log_file.flush()
  process = subprocess.Popen(args, cwd=cwd, env=env, stdout=log_file, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                             start_new_session=True)
  (STATE_DIR / 'pids' / f'{name}.pid').write_text(f"{process.pid} {process_start(process.pid) or ''}".strip())
  log(f"started {name} (pid {process.pid}), logs: {STATE_DIR / 'logs' / f'{name}.log'}")


def stop(name: str):
  pid = pid_of(name)
  if pid:
    try:
      os.killpg(pid, signal.SIGTERM)
    except OSError:
      os.kill(pid, signal.SIGTERM)
    for _ in range(50):
      if not pid_of(name):
        break
      time.sleep(0.1)
    else:
      try:
        os.killpg(pid, signal.SIGKILL)
      except OSError:
        pass
    log(f"stopped {name}")
  (STATE_DIR / 'pids' / f'{name}.pid').unlink(missing_ok=True)


def port_in_use(port: int) -> bool:
  with socket.socket() as s:
    s.settimeout(0.5)
    return s.connect_ex(('127.0.0.1', port)) == 0


def free_port() -> int:
  with socket.socket() as s:
    s.bind(('127.0.0.1', 0))
    return s.getsockname()[1]


def fetch(url: str, data: Optional[bytes] = None, headers: Optional[dict] = None, timeout=10, opener=None, method=None):
  opener = opener or urllib.request.build_opener(urllib.request.ProxyHandler({}))
  request = urllib.request.Request(url, data=data, headers=headers or {}, method=method)
  with opener.open(request, timeout=timeout) as response:
    return response.status, response.read()


def wait_for(url: str, name: str, timeout: float, log_name: str):
  start = time.time()
  while time.time() - start < timeout:
    try:
      fetch(url, timeout=5)
      return
    except urllib.error.HTTPError as e:
      if e.code < 500:
        return
    except Exception:
      pass
    if log_name and not pid_of(log_name):
      break
    time.sleep(0.5)
  log_file = STATE_DIR / 'logs' / f'{log_name}.log'
  tail = last_start(log_file.read_text(errors='replace'), 25) if log_file.exists() else ''
  fail(f"{name} didn't answer at {url}\n{tail}", f"full logs: uv run scripts/dev.py logs {log_name}")


# ------------------------------------------------------------------------------------------------ postgres

def run_as_postgres(args: List[str], **kwargs) -> subprocess.CompletedProcess:
  """PostgreSQL refuses to run as root: as root, we run it as the `postgres` user the package creates"""
  if os.geteuid() == 0:
    args = ['runuser', '-u', 'postgres', '--', *args]
  return subprocess.run(args, **kwargs)


def postgres_dir(state: dict) -> Path:
  return Path(state['postgres']['dir'])


def choose_postgres_dir() -> Path:
  """<state>/postgres, unless `postgres` (when we're root) can't reach it, e.g. under a 0700 home folder"""
  wanted = STATE_DIR / 'postgres'
  if os.geteuid() != 0:
    return wanted
  wanted.mkdir(parents=True, exist_ok=True)
  shutil.chown(wanted, 'postgres', 'postgres')
  if run_as_postgres(['test', '-w', str(wanted)]).returncode == 0:
    return wanted
  fallback = Path('/var/tmp') / f"qaboard-dev-{hashlib.sha1(str(STATE_DIR).encode()).hexdigest()[:8]}" / 'postgres'
  log(f"the postgres user can't reach {wanted}: its data goes to {fallback}", 'yellow')
  return fallback


def docker_works() -> bool:
  if not shutil.which('docker'):
    return False
  try:
    return subprocess.run(['docker', 'info'], capture_output=True, timeout=10).returncode == 0
  except subprocess.TimeoutExpired:
    return False


def choose_postgres_mode(wanted: str) -> str:
  if wanted in ('local', 'docker'):
    return wanted
  if postgres_bin_dirs() or shutil.which('initdb'):
    return 'local'
  if docker_works():
    return 'docker'
  fail("PostgreSQL isn't installed, and docker can't start containers here.",
       "apt-get install -y postgresql-16 (Debian/Ubuntu; dev.py runs it, no service needed), or start the docker daemon")


def pg_bin(name: str) -> str:
  dirs = postgres_bin_dirs()
  if dirs:
    return str(dirs[0] / name)
  found = shutil.which(name)
  if not found:
    fail(f"no `{name}` (PostgreSQL's server binaries)", "apt-get install -y postgresql-16, or: up --postgres docker")
  return found


def postgres_up(state: dict):
  pg = state['postgres']
  if pg['mode'] == 'docker':
    return docker_postgres_up(state)
  directory = postgres_dir(state)
  data = directory / 'data'
  directory.mkdir(parents=True, exist_ok=True)
  if os.geteuid() == 0:
    shutil.chown(directory, 'postgres', 'postgres')
    if directory.parent.name.startswith('qaboard-dev-'):  # the fallback of choose_postgres_dir()
      shutil.chown(directory.parent, 'postgres', 'postgres')
  if not (data / 'PG_VERSION').exists():
    if data.exists():
      shutil.rmtree(data)  # a failed initdb
    password_file = directory / '.pwfile'
    password_file.write_text(DB_PASSWORD + '\n')
    if os.geteuid() == 0:
      shutil.chown(password_file, 'postgres', 'postgres')
    started = time.time()
    result = run_as_postgres([pg_bin('initdb'), '-D', str(data), '-U', DB_USER, '--pwfile', str(password_file),
                              '-A', 'scram-sha-256', '-E', 'UTF8', '--no-sync'], capture_output=True, text=True)
    password_file.unlink()
    if result.returncode != 0:
      fail(f"initdb failed:\n{result.stdout}{result.stderr}")
    log(f"created a PostgreSQL cluster in {data} ({time.time() - started:.1f}s)")
  status = run_as_postgres([pg_bin('pg_ctl'), '-D', str(data), 'status'], capture_output=True)
  if status.returncode == 0:
    log(f"postgres is running on 127.0.0.1:{pg['port']}", 'dim')
  else:
    if port_in_use(pg['port']):
      fail(f"port {pg['port']} (this server's postgres) is used by another program",
           f"stop it, or delete {state_path()} to pick another port (the data stays in {directory})")
    result = run_as_postgres([pg_bin('pg_ctl'), '-D', str(data), '-l', str(directory / 'postgres.log'), '-w', 'start', '-o',
                              f"-p {pg['port']} -k {directory} -c listen_addresses=127.0.0.1 -c fsync=off"],
                             capture_output=True, text=True)
    if result.returncode != 0:
      log_tail = (directory / 'postgres.log').read_text(errors='replace')[-2000:] if (directory / 'postgres.log').exists() else ''
      fail(f"postgres didn't start:\n{result.stdout}{result.stderr}{log_tail}")
    log(f"started postgres on 127.0.0.1:{pg['port']}")
  ensure_database(state)


def docker_postgres_up(state: dict):
  pg = state['postgres']
  name = pg['container']
  inspect = subprocess.run(['docker', 'inspect', '-f', '{{.State.Running}}', name], capture_output=True, text=True)
  if inspect.returncode != 0:
    result = subprocess.run(['docker', 'run', '-d', '--name', name, '-e', f'POSTGRES_USER={DB_USER}',
                             '-e', f'POSTGRES_PASSWORD={DB_PASSWORD}', '-e', 'POSTGRES_DB=postgres',
                             '-p', f"127.0.0.1:{pg['port']}:5432", '-v', f'{name}:/var/lib/postgresql/data', DOCKER_IMAGE],
                            capture_output=True, text=True)
    if result.returncode != 0:
      fail(f"could not start {DOCKER_IMAGE}: {result.stderr.strip()}", "is the image reachable? Else: up --postgres local")
    log(f"started postgres in the container {name}, on 127.0.0.1:{pg['port']}")
  elif inspect.stdout.strip() != 'true':
    subprocess.run(['docker', 'start', name], check=True, capture_output=True)
    log(f"restarted the container {name}")
  else:
    log(f"postgres is running in the container {name}", 'dim')
  deadline = time.time() + 60
  while True:
    try:
      connect('postgres', state).close()
      break
    except Exception:
      if time.time() > deadline:
        fail(f"postgres in {name} didn't accept connections in 60s", f"docker logs {name}")
      time.sleep(1)
  ensure_database(state)


def connect(database: str, state: dict):
  import psycopg2
  return psycopg2.connect(host='127.0.0.1', port=state['postgres']['port'], user=DB_USER, password=DB_PASSWORD,
                          dbname=database, connect_timeout=5)


def ensure_database(state: dict):
  """Creates the qaboard database, and marks it as this server's (its comment)"""
  connection = connect('postgres', state)
  connection.autocommit = True
  try:
    cursor = connection.cursor()
    cursor.execute("SELECT 1 FROM pg_database WHERE datname = %s", (DB_NAME,))
    if cursor.fetchone() is None:
      cursor.execute(f'CREATE DATABASE "{DB_NAME}"')
      cursor.execute(f'COMMENT ON DATABASE "{DB_NAME}" IS %s', (marker(state['id']),))
      log(f"created the database {DB_NAME}")
  finally:
    connection.close()


def database_comment(state: dict) -> Optional[str]:
  try:
    connection = connect('postgres', state)
  except Exception:
    return None
  try:
    cursor = connection.cursor()
    cursor.execute("SELECT shobj_description(oid, 'pg_database') FROM pg_database WHERE datname = %s", (DB_NAME,))
    row = cursor.fetchone()
    return row[0] if row else None
  finally:
    connection.close()


def postgres_running(state: dict) -> bool:
  pg = state['postgres']
  if pg['mode'] == 'docker':
    inspect = subprocess.run(['docker', 'inspect', '-f', '{{.State.Running}}', pg['container']], capture_output=True, text=True)
    return inspect.stdout.strip() == 'true'
  data = postgres_dir(state) / 'data'
  if not (data / 'PG_VERSION').exists():
    return False
  return run_as_postgres([pg_bin('pg_ctl'), '-D', str(data), 'status'], capture_output=True).returncode == 0


def postgres_down(state: dict):
  pg = state['postgres']
  if pg['mode'] == 'docker':
    if subprocess.run(['docker', 'stop', pg['container']], capture_output=True).returncode == 0:
      log(f"stopped the container {pg['container']}")
    return
  if postgres_running(state):
    run_as_postgres([pg_bin('pg_ctl'), '-D', str(postgres_dir(state) / 'data'), '-m', 'fast', '-w', 'stop'], capture_output=True)
    log("stopped postgres")


# ------------------------------------------------------------------------------------------------ the server

def urls(state: dict) -> dict:
  ports = state['ports']
  return {
    'web': f"http://localhost:{ports['web']}",
    'server': f"http://localhost:{ports['server']}",
    'backend': f"http://127.0.0.1:{ports['backend']}",
  }


def backend_env(state: dict) -> Dict[str, str]:
  ports = state['ports']
  env = {
    'FLASK_APP': 'backend',
    'FLASK_DEBUG': '1',
    'QABOARD_DB_HOST': '127.0.0.1',
    'QABOARD_DB_PORT': str(state['postgres']['port']),
    'QABOARD_DB_USER': DB_USER,
    'QABOARD_DB_PASSWORD': DB_PASSWORD,
    'QABOARD_DB_NAME': DB_NAME,
    'QABOARD_DATA_DIR': str(STATE_DIR / 'data'),
    # runs without a shared storage upload their files here; the file browser lists it
    'QABOARD_UPLOAD_ROOT': str(STATE_DIR / 'results'),
    'QABOARD_STORAGE_ROOTS': str(STATE_DIR / 'results'),
    'QABOARD_LOGIN_TYPE': 'LOCAL',
    # creates the admin when the server starts without one (backend/first_admin.py)
    'QABOARD_ADMIN_USER': ADMIN_USER,
    'QABOARD_ADMIN_PASSWORD': ADMIN_PASSWORD,
    # the links in the server's answers (what `qa` prints) go to the web app
    'QABOARD_URL': urls(state)['web'],
    'QABOARD_HOST': f"localhost:{ports['web']}",
    # audit() refuses actions missing from backend/audit_actions.py, as in the integration tests
    'QABOARD_AUDIT_STRICT': '1',
  }
  if state.get('redis_port'):
    env.update({'REDIS_HOST': '127.0.0.1', 'REDIS_PORT': str(state['redis_port'])})
  else:
    # nothing listens there: the cache is skipped at once (backend/hybrid_cache.py)
    env.update({'REDIS_HOST': '127.0.0.1', 'REDIS_PORT': '1'})
  return clean_env(os.environ, **env)


def uv_backend(*args: str) -> List[str]:
  return ['uv', 'run', '--project', str(REPO / 'backend'), '--quiet', *args]


def migrate(state: dict):
  """What backend/migrate.sh does: importing the app creates the missing tables, then alembic upgrades or stamps"""
  env = backend_env(state)
  started = time.time()
  sync = subprocess.run(['uv', 'sync', '--project', str(REPO / 'backend'), '--quiet'], cwd=REPO / 'backend', env=env,
                        capture_output=True, text=True)
  if sync.returncode != 0:
    fail(f"uv sync in backend/ failed:\n{sync.stderr[-3000:]}",
         "it compiles lxml, xmlsec, python-ldap: apt-get install -y libldap2-dev libsasl2-dev libxmlsec1-dev "
         "libxml2-dev libxslt1-dev libpq-dev pkg-config (backend/tests/TESTING.md)")
  log(f"backend dependencies ready ({time.time() - started:.1f}s)")
  started = time.time()
  script = (
    "import re, sys\n"
    "import backend\n"   # creates the missing tables (Base.metadata.create_all)
    "from pathlib import Path\n"
    "from alembic.config import Config\n"
    "from alembic import command\n"
    "from alembic.runtime.migration import MigrationContext\n"
    "from backend.database import engine\n"
    "with engine.connect() as connection:\n"
    "  current = MigrationContext.configure(connection).get_current_revision()\n"
    "config = Config(str(Path(backend.__file__).parent / 'alembic.ini'))\n"
    "config.set_main_option('script_location', str(Path(backend.__file__).parent / 'alembic'))\n"
    "if current:\n"
    "  command.upgrade(config, 'head')\n"
    "else:\n"
    "  command.stamp(config, 'head')\n"
    "print('migrated' if current else 'stamped')\n"
  )
  result = subprocess.run(uv_backend('python', '-c', script), cwd=REPO / 'backend', env=env, capture_output=True, text=True)
  if result.returncode != 0:
    fail(f"the migrations failed:\n{(result.stdout + result.stderr)[-4000:]}")
  log(f"database schema ready ({result.stdout.strip().splitlines()[-1] if result.stdout.strip() else 'ok'}, {time.time() - started:.1f}s)")


def up(args):
  state = load_state()
  if state is None:
    ports = pick_ports(args.port, args.web_port)
    mode = choose_postgres_mode(args.postgres)
    server_id = uuid.uuid4().hex[:12]
    state = {
      'id': server_id,
      'ports': ports,
      'postgres': {'mode': mode, 'port': free_port()},
    }
    if mode == 'docker':
      state['postgres']['container'] = f"qaboard-dev-{server_id}"
    else:
      state['postgres']['dir'] = str(choose_postgres_dir())
    save_state(state)
    log(f"new development server {server_id} in {STATE_DIR}")
  else:
    changed = {k: v for k, v in pick_ports(args.port, args.web_port).items() if args.ports_given and v != state['ports'][k]}
    if changed:
      state['ports'].update(changed)
      save_state(state)
  started = time.time()
  for d in ('logs', 'pids', 'data', 'results'):
    (STATE_DIR / d).mkdir(parents=True, exist_ok=True)

  ports = state['ports']
  for name, key in (('proxy', 'server'), ('backend', 'backend'), ('webapp', 'web')):
    if key == 'web' and args.no_web:
      continue
    if not pid_of(name) and port_in_use(ports[key]):
      fail(f"port {ports[key]} ({name}) is used by another program",
           f"another checkout's server? `uv run scripts/dev.py up --port {ports['server'] + 10} --web-port {ports['web'] + 10}`")

  postgres_up(state)
  if shutil.which('redis-server') and not args.no_redis:
    if not state.get('redis_port'):
      state['redis_port'] = free_port()
      save_state(state)
    (STATE_DIR / 'redis').mkdir(exist_ok=True)
    spawn('redis', ['redis-server', '--port', str(state['redis_port']), '--bind', '127.0.0.1', '--dir', str(STATE_DIR / 'redis'),
                    '--save', '', '--appendonly', 'no'], cwd=STATE_DIR, env=clean_env(os.environ))
  elif not state.get('redis_port'):
    log("no redis-server: the backend runs without its cache (slower, fine for development)", 'dim')

  env = backend_env(state)
  if not pid_of('backend'):
    migrate(state)
  spawn('backend', uv_backend('flask', 'run', '--host', '127.0.0.1', '--port', str(ports['backend']), '--with-threads'),
        cwd=REPO / 'backend', env=env)
  spawn('proxy', [sys.executable, str(Path(__file__).resolve()), '_proxy', '--port', str(ports['server']),
                  '--backend-port', str(ports['backend']), '--root', str(STATE_DIR / 'results'), '--web-url', urls(state)['web']],
        cwd=REPO, env=clean_env(os.environ, QABOARD_DEV_DIR=str(STATE_DIR)))
  if not args.no_worker:
    # the server's jobs (Admin > Storage): deletions, retention rules, silent runs...
    spawn('jobs-worker', uv_backend('qaboard-admin', 'jobs', 'worker'), cwd=REPO / 'backend', env=env)
  else:
    stop('jobs-worker')
  if not args.no_web:
    webapp = REPO / 'webapp'
    if not (webapp / 'node_modules').exists():
      log("installing the web app's packages (npm install, ~1 min)...")
      if subprocess.run(['npm', 'install', '--no-audit', '--no-fund'], cwd=webapp).returncode != 0:
        fail("npm install failed in webapp/", "check the network or the npm registry; or: up --no-web")
    web_env = clean_env(os.environ, REACT_APP_QABOARD_HOST=f"http://127.0.0.1:{ports['server']}", HOST='127.0.0.1')
    for name in ('HTTP_PROXY', 'http_proxy', 'HTTPS_PROXY', 'https_proxy'):
      web_env.pop(name, None)  # Vite's proxy to the server is local
    spawn('webapp', ['npm', 'start', '--', '--port', str(ports['web'])], cwd=webapp, env=web_env)

  wait_for(f"http://127.0.0.1:{ports['backend']}/api/v1/health", 'the backend', 120, 'backend')
  wait_for(f"http://127.0.0.1:{ports['server']}/api/v1/health", 'the proxy', 30, 'proxy')
  ensure_token(state)
  if not args.no_web:
    wait_for(f"http://127.0.0.1:{ports['web']}/", 'the web app', 120, 'webapp')
  log(f"up in {time.time() - started:.1f}s", 'green')
  print_summary(state)


def ensure_token(state: dict):
  """A token of the admin, for `qa` and scripts: <state>/token"""
  token_file = STATE_DIR / 'token'
  base = f"http://127.0.0.1:{state['ports']['backend']}"
  if token_file.exists():
    if token_ok(state, token_file.read_text().strip()):
      return
  opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPCookieProcessor(CookieJar()))
  origin = {'Origin': base}
  try:
    fetch(f'{base}/api/v1/user/auth/', data=urllib.parse.urlencode({'username': ADMIN_USER, 'password': ADMIN_PASSWORD}).encode(),
         headers={**origin, 'Content-Type': 'application/x-www-form-urlencoded'}, opener=opener)
    _, body = fetch(f'{base}/api/v1/user/tokens', data=json.dumps({'name': 'scripts/dev.py', 'scopes': ['read', 'ingest', 'act', 'admin']}).encode(),
                   headers={**origin, 'Content-Type': 'application/json'}, opener=opener)
  except urllib.error.HTTPError as e:
    fail(f"could not sign in as {ADMIN_USER} to create a token: HTTP {e.code} {e.read()[:500]!r}",
         "a database from before dev.py made the admin? `uv run scripts/dev.py reset`")
  write_private(token_file, json.loads(body)['token'] + '\n')
  log(f"created a token for {ADMIN_USER}: {token_file}")


def token_ok(state: dict, token: str) -> bool:
  try:
    status, body = fetch(f"http://127.0.0.1:{state['ports']['backend']}/api/v1/user/me/", headers={'Authorization': f'Bearer {token}'})
    return status == 200 and json.loads(body).get('user_name') == ADMIN_USER
  except Exception:
    return False


def print_summary(state: dict):
  u = urls(state)
  web_up = bool(pid_of('webapp'))
  lines = [
    f"Web app:   {u['web']}" + ('' if web_up else '   (not started: up without --no-web)'),
    f"Server:    {u['server']}   (API and /s/ files; flask on {u['backend']})",
    f"Sign in:   {ADMIN_USER} / {ADMIN_PASSWORD}   (admin; token for qa/scripts in {STATE_DIR / 'token'})",
    f"Database:  postgresql://{DB_USER}:{DB_PASSWORD}@127.0.0.1:{state['postgres']['port']}/{DB_NAME}",
    f"Logs:      {STATE_DIR / 'logs'}   (uv run scripts/dev.py logs backend)",
  ]
  seeded = state.get('seeded')
  if seeded:
    lines.append("Seeded:")
    lines += [f"  {name}: {url}" for name, url in seeded['urls'].items()]
  else:
    lines.append("Data:      none yet: uv run scripts/dev.py seed")
  print('\n'.join(lines))


def status(args):
  state = load_state()
  if state is None:
    if args.json:
      print(json.dumps({'state_dir': str(STATE_DIR), 'exists': False}))
    else:
      print(f"No development server in {STATE_DIR}: uv run scripts/dev.py up")
    return
  services = {name: pid_of(name) for name in SERVICES}
  services['postgres'] = postgres_running(state)
  health = False
  try:
    health = fetch(f"http://127.0.0.1:{state['ports']['server']}/api/v1/health", timeout=3)[0] == 200
  except Exception:
    pass
  if args.json:
    print(json.dumps({'state_dir': str(STATE_DIR), 'exists': True, 'id': state['id'], 'services': services, 'healthy': health,
                      'urls': urls(state), 'user': ADMIN_USER, 'password': ADMIN_PASSWORD,
                      'token_file': str(STATE_DIR / 'token'), 'postgres': state['postgres'],
                      'seeded': state.get('seeded')}, indent=2))
    return
  for name, value in services.items():
    print(f"{name:12} {('running' + (f', pid {value}' if value is not True else '')) if value else 'stopped'}")
  print(f"{'health':12} {'ok' if health else 'no answer'}")
  print_summary(state)


def env_command(args):
  state = load_state()
  if state is None:
    fail(f"no development server in {STATE_DIR}", "uv run scripts/dev.py up")
  token_file = STATE_DIR / 'token'
  pg = state['postgres']
  print(f"# qa and SDK runs against the development server (eval \"$(uv run scripts/dev.py env)\")")
  print(f"export QABOARD_URL=http://localhost:{state['ports']['server']}")
  if token_file.exists():
    print(f"export QABOARD_TOKEN=$(cat {token_file})")
  print("export NO_PROXY=localhost,127.0.0.1 no_proxy=localhost,127.0.0.1")
  print(f"# psql")
  print(f"export PGHOST=127.0.0.1 PGPORT={pg['port']} PGUSER={DB_USER} PGPASSWORD={DB_PASSWORD} PGDATABASE={DB_NAME}")
  print(f"# backend integration tests (they create and drop their own database next to it): cd backend && uv run pytest integration_tests/<file>")
  print(f"export BACKEND_TEST_MODE=no-mock QABOARD_TEST_DATABASE_URL=postgresql://{DB_USER}:{DB_PASSWORD}@127.0.0.1:{pg['port']}/postgres")


def logs(args):
  log_file = STATE_DIR / 'logs' / f'{args.service}.log'
  if args.service == 'postgres':
    state = load_state()
    if state and state['postgres']['mode'] == 'docker':
      os.execvp('docker', ['docker', 'logs', '--tail', str(args.lines), state['postgres']['container']])
    log_file = postgres_dir(state) / 'postgres.log' if state else log_file
  if not log_file.exists():
    fail(f"no log file {log_file}")
  print('\n'.join(log_file.read_text(errors='replace').splitlines()[-args.lines:]))


def down(args):
  for name in reversed(SERVICES):
    stop(name)
  state = load_state()
  if state:
    postgres_down(state)


def reset(args):
  state = load_state()
  down(args)
  if state and state['postgres']['mode'] == 'docker':
    subprocess.run(['docker', 'rm', '-f', '-v', state['postgres']['container']], capture_output=True)
    subprocess.run(['docker', 'volume', 'rm', state['postgres']['container']], capture_output=True)
  if state and state['postgres'].get('dir'):
    shutil.rmtree(state['postgres']['dir'], ignore_errors=True)
  if STATE_DIR.exists():
    if not (STATE_DIR / 'state.json').exists() and any(STATE_DIR.iterdir()):
      fail(f"{STATE_DIR} has no state.json: not deleting a folder dev.py didn't make")
    shutil.rmtree(STATE_DIR)
  log(f"deleted {STATE_DIR}: the database, the server's data, the results and the seeded repositories")


# ------------------------------------------------------------------------------------------------ seed

def git(workdir: Path, *args: str, env: Optional[Dict[str, str]] = None) -> str:
  result = subprocess.run(['git', *args], cwd=workdir, capture_output=True, text=True,
                          env={**clean_env(os.environ), 'GIT_CONFIG_GLOBAL': '/dev/null', 'GIT_CONFIG_NOSYSTEM': '1', **(env or {})})
  if result.returncode != 0:
    fail(f"git {' '.join(args)} failed in {workdir}: {result.stderr.strip()}")
  return result.stdout.strip()


def make_repository(name: str, story: dict, workdir: Path, now: float) -> List[dict]:
  """A git repository with the story's commits: [{**commit, sha}]"""
  if workdir.exists():
    shutil.rmtree(workdir)
  shutil.copytree(SEED_TEMPLATES / name, workdir, ignore=shutil.ignore_patterns('__pycache__', 'output'))
  (workdir / '.gitignore').write_text('output/\n__pycache__/\n')
  git(workdir, 'init', '-q', '-b', 'main')
  commits = []
  for commit in plan(story):
    if commit['branch'] != 'main' and (not commits or commits[-1]['branch'] != commit['branch']):
      git(workdir, 'checkout', '-q', '-b', commit['branch'])
    (workdir / 'build').mkdir(exist_ok=True)
    (workdir / 'build' / 'flags.json').write_text(json.dumps(commit['effective_flags'], indent=2, sort_keys=True) + '\n')
    git(workdir, 'add', '-A')
    date = time.strftime('%Y-%m-%dT%H:%M:%S+0000', time.gmtime(now - commit['hours'] * 3600))
    who = {'GIT_AUTHOR_NAME': commit['author'], 'GIT_AUTHOR_EMAIL': email_of(commit['author']),
           'GIT_COMMITTER_NAME': commit['author'], 'GIT_COMMITTER_EMAIL': email_of(commit['author']),
           'GIT_AUTHOR_DATE': date, 'GIT_COMMITTER_DATE': date}
    git(workdir, 'commit', '-q', '--allow-empty', '-m', commit['message'], env=who)
    commits.append({**commit, 'sha': git(workdir, 'rev-parse', 'HEAD')})
  return commits


def qa_python() -> str:
  """The interpreter of the repository's venv, with this checkout's qaboard (uv sync once)"""
  result = subprocess.run(['uv', 'run', '--project', str(REPO), '--quiet', 'python', '-c', 'import sys; print(sys.executable)'],
                          cwd=REPO, capture_output=True, text=True, env=clean_env(os.environ))
  if result.returncode != 0:
    fail(f"could not set up the repository's venv for qa:\n{result.stderr[-2000:]}", "uv sync --extra dev")
  return result.stdout.strip().splitlines()[-1]


def run_batches(python: str, workdir: Path, commit: dict, server: str, token: str, verbose: bool, project: str):
  git(workdir, 'checkout', '-q', commit['sha'])
  env = clean_env(os.environ, QABOARD_URL=server, QABOARD_TOKEN=token,
                  # as a CI job: runs go to the batch they name, for the commit and branch given
                  CI='true', GIT_COMMIT=commit['sha'], GIT_BRANCH=commit['branch'], USER='ci', LOGNAME='ci')
  # `qa batch` starts `qa run`s
  env['PATH'] = f"{Path(python).parent}{os.pathsep}{env.get('PATH', '')}"
  for batch in commit['batches']:
    started = time.time()
    # the CI's batch is labeled "default" (shown as CI), the others by their name, like tuning batches
    label = [] if batch == 'ci' else ['--label', batch]
    result = subprocess.run([python, '-m', 'qaboard', *label, 'batch', batch], cwd=workdir, env=env, capture_output=True, text=True)
    output = result.stdout + result.stderr
    if verbose or result.returncode != 0:
      print(output[-6000:], file=sys.stderr)
    if result.returncode != 0:
      fail(f"qa batch {batch} failed for {commit['branch']} {commit['sha'][:8]} in {workdir}",
           "the server's side: uv run scripts/dev.py logs backend")
    log(f"  {project:18} {commit['branch']:22} {commit['sha'][:8]}  {batch:14} ({time.time() - started:.1f}s)  {commit['message'][:50]}")


def seed(args):
  state = load_state()
  server = f"http://127.0.0.1:{state['ports']['server']}" if state else ''
  problem = refusal(state, database_comment(state) if state else None, server)
  if problem:
    fail(f"refusing to seed: {problem}")
  token_file = STATE_DIR / 'token'
  token = token_file.read_text().strip() if token_file.exists() else ''
  if not token_ok(state, token):
    fail(f"the server on {server} doesn't know this server's token ({token_file})",
         "is it this checkout's server? `uv run scripts/dev.py status`, then `up`")
  if state.get('seeded') and not args.force:
    log("already seeded (seed --force runs everything again; reset starts from an empty database)", 'dim')
    print_summary(state)
    return
  started = time.time()
  python = qa_python()
  log(f"qa ready ({time.time() - started:.1f}s)")
  # the same commit dates, so the same shas, when seeding again: `seed --force` updates the same batches
  now = state.setdefault('seed_anchor', int(time.time()))
  save_state(state)
  web = urls(state)['web']
  seeded = {'projects': {}, 'urls': {}}

  def seed_project(name: str, story: dict) -> List[dict]:
    workdir = STATE_DIR / 'seed' / name
    commits = make_repository(name, story, workdir, now)
    log(f"{story['project']}: {len(commits)} commits in {workdir}")
    for commit in commits:
      run_batches(python, workdir, commit, server, token, args.verbose, story['project'])
    return commits

  # the projects at the same time: most of the time goes to starting `qa` processes
  from concurrent.futures import ThreadPoolExecutor
  with ThreadPoolExecutor(len(STORIES)) as pool:
    futures = {name: pool.submit(seed_project, name, story) for name, story in STORIES.items()}
    results = {name: future.result() for name, future in futures.items()}
  for name, story in STORIES.items():
    commits = results[name]
    main = [c for c in commits if c['branch'] == 'main']
    branch = [c for c in commits if c['branch'] != 'main']
    project = urllib.parse.quote(story['project'], safe='/')
    seeded['projects'][story['project']] = {c['sha']: f"{c['branch']}: {c['message']}" for c in commits}
    seeded['urls'][f"{story['project']} commits"] = f"{web}/{project}/commits"
    if branch:
      seeded['urls'][f"{story['project']} {branch[-1]['branch']}"] = (
        f"{web}/{project}/commit/{branch[-1]['sha']}?reference={main[-1]['sha']}")
  state['seeded'] = seeded
  save_state(state)
  log(f"seeded in {time.time() - started:.1f}s", 'green')
  print_summary(state)


# ------------------------------------------------------------------------------------------------ the proxy

def proxy(args):
  """nginx's job in docker-compose.yml: the runs' files under /s/ (fileserver.py), everything else to flask"""
  import importlib.util
  from http.server import ThreadingHTTPServer
  spec = importlib.util.spec_from_file_location('fileserver', FILESERVER)
  fileserver = importlib.util.module_from_spec(spec)
  spec.loader.exec_module(fileserver)
  hop_by_hop = {'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailers',
                'transfer-encoding', 'upgrade'}

  class Body:
    """At most `length` bytes of the request, for http.client"""
    def __init__(self, rfile, length):
      self.rfile, self.left = rfile, length
    def read(self, size=-1):
      if self.left <= 0:
        return b''
      size = self.left if size is None or size < 0 else min(size, self.left)
      chunk = self.rfile.read(size)
      self.left -= len(chunk)
      return chunk

  class Handler(fileserver.Handler):
    def do_GET(self):
      where = proxy_route(self.command, self.path)
      if where == 'files':
        return super().do_GET()
      if where == 'webapp':
        # the app's pages, e.g. the links `qa` prints: nginx serves the app there, here it's Vite's dev server
        self.send_response(302)
        self.send_header('Location', f"{args.web_url}{self.path}")
        self.send_header('Content-Length', '0')
        self.end_headers()
        return
      self.forward()

    def do_HEAD(self):
      self.do_GET()

    do_POST = do_PUT = do_PATCH = do_DELETE = do_OPTIONS = lambda self: self.forward()

    def read_chunked(self) -> bytes:
      body = b''
      while True:
        size = int(self.rfile.readline().split(b';')[0].strip() or b'0', 16)
        if size == 0:
          while self.rfile.readline() not in (b'\r\n', b'\n', b''):
            pass
          return body
        body += self.rfile.read(size)
        self.rfile.readline()

    def forward(self):
      headers = {k: v for k, v in self.headers.items() if k.lower() not in hop_by_hop}
      headers.setdefault('X-Forwarded-Host', self.headers.get('Host', ''))
      headers.setdefault('X-Forwarded-Proto', 'http')
      headers['X-Forwarded-For'] = self.client_address[0]
      if 'chunked' in self.headers.get('Transfer-Encoding', '').lower():
        body = self.read_chunked()
        headers['Content-Length'] = str(len(body))
      else:
        length = int(self.headers.get('Content-Length') or 0)
        body = Body(self.rfile, length) if length else None
      connection = http.client.HTTPConnection('127.0.0.1', Handler.backend_port, timeout=900)
      try:
        connection.request(self.command, self.path, body=body, headers=headers)
        response = connection.getresponse()
      except OSError as e:
        return self.error(502, f"the backend (127.0.0.1:{Handler.backend_port}) doesn't answer: {e}")
      self.send_response_only(response.status, response.reason)
      length = response.getheader('Content-Length')
      for key, value in response.getheaders():
        if key.lower() not in hop_by_hop:
          self.send_header(key, value)
      if length is None:
        self.send_header('Connection', 'close')
        self.close_connection = True
      self.end_headers()
      try:
        while self.command != 'HEAD':
          chunk = response.read1(1 << 16) if hasattr(response, 'read1') else response.read(1 << 16)
          if not chunk:
            break
          self.wfile.write(chunk)
      except (BrokenPipeError, ConnectionResetError):
        self.close_connection = True
      finally:
        connection.close()

  Handler.roots = [Path(os.path.realpath(r)) for r in args.root]
  Handler.backend = f"http://127.0.0.1:{args.backend_port}"
  Handler.backend_port = args.backend_port
  server = ThreadingHTTPServer(('127.0.0.1', args.port), Handler)
  server.daemon_threads = True
  print(f"proxy on http://127.0.0.1:{args.port}: /s/ from {', '.join(map(str, Handler.roots))}, the rest to {Handler.backend}", flush=True)
  server.serve_forever()


# ------------------------------------------------------------------------------------------------ main

def main(argv=None):
  parser = argparse.ArgumentParser(description=__doc__.split('\n\n')[0], formatter_class=argparse.RawDescriptionHelpFormatter,
                                   epilog=__doc__.split('\n', 2)[2])
  commands = parser.add_subparsers(dest='command', required=True)
  p = commands.add_parser('up', help="start (or reuse) the development server")
  p.add_argument('--port', type=int, default=None, help="the server's port: the API and /s/ (default 5151, flask on port+1)")
  p.add_argument('--web-port', type=int, default=None, help="the web app's port (default 3000)")
  p.add_argument('--postgres', choices=['auto', 'local', 'docker'], default='auto',
                 help="auto: the local binaries if installed, else docker (only chosen on the first up)")
  p.add_argument('--no-web', action='store_true', help="don't start the web app (npm start)")
  p.add_argument('--no-worker', action='store_true', help="don't start the jobs worker")
  p.add_argument('--no-redis', action='store_true', help="don't start redis-server, even if installed")
  p.set_defaults(func=up)
  p = commands.add_parser('seed', help="send a small dataset to the development server, with qa")
  p.add_argument('--force', action='store_true', help="seed again, even if already seeded")
  p.add_argument('--verbose', '-v', action='store_true', help="show qa's output")
  p.set_defaults(func=seed)
  p = commands.add_parser('status', help="what runs, the URLs, the credentials")
  p.add_argument('--json', action='store_true')
  p.set_defaults(func=status)
  p = commands.add_parser('env', help="shell exports for qa, psql and the backend's integration tests")
  p.set_defaults(func=env_command)
  p = commands.add_parser('logs', help="the end of a service's log")
  p.add_argument('service', choices=[*SERVICES, 'postgres'])
  p.add_argument('-n', '--lines', type=int, default=60)
  p.set_defaults(func=logs)
  p = commands.add_parser('down', help="stop everything, keep the data")
  p.set_defaults(func=down)
  p = commands.add_parser('reset', help="stop everything, delete the database, the results and the seeded repositories")
  p.set_defaults(func=reset)
  p = commands.add_parser('_proxy')  # started by up
  p.add_argument('--port', type=int, required=True)
  p.add_argument('--backend-port', type=int, required=True)
  p.add_argument('--web-url', required=True)
  p.add_argument('--root', action='append', required=True)
  p.set_defaults(func=proxy)
  args = parser.parse_args(argv)
  if args.command == 'up':
    args.ports_given = args.port is not None or args.web_port is not None
    args.port = args.port or 5151
    args.web_port = args.web_port or 3000
  args.func(args)


if __name__ == '__main__':
  main()
