#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""
A QA-Board stack without Docker: Postgres and Redis from the installed binaries, the Flask backend and the jobs
worker from backend/ (uv), the web app's Vite dev server (npm start), and fileserver.py in place of nginx's /s/.

  uv run docs-media/demo/local-stack/stack.py up        # starts what isn't running, creates the user and its token
  uv run docs-media/demo/local-stack/stack.py status
  uv run docs-media/demo/local-stack/stack.py down      # stops everything (keeps the data)
  uv run docs-media/demo/local-stack/stack.py reset     # down, then deletes the database and the results

  http://localhost:3000       the web app (Vite proxies /api to the backend, /s/ to the file server)
  http://localhost:5152       the backend (flask run)
  http://localhost:5151/s/... the runs' files

Everything lives in $QABOARD_LOCAL_STACK (default: $TMPDIR/qaboard-local-stack): pgdata/, redis/, data/ (QABOARD_DATA_DIR),
logs/, pids/, token. The runs' files go to $QABOARD_LOCAL_RESULTS (default /mnt/qaboard, the product's default
storage): runs without a shared storage upload their files there (QABOARD_UPLOAD_ROOT).
"""
import json
import re
import os
import shutil
import signal
import subprocess
import tempfile
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from http.cookiejar import CookieJar
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
HERE = Path(__file__).resolve().parent
DEFAULT_STACK = str(Path(tempfile.gettempdir()) / 'qaboard-local-stack')
STACK = Path(os.environ.get('QABOARD_LOCAL_STACK', DEFAULT_STACK))
RESULTS = Path(os.environ.get('QABOARD_LOCAL_RESULTS', '/mnt/qaboard'))
PG_PORT = int(os.environ.get('QABOARD_LOCAL_PG_PORT', 5432))
REDIS_PORT = int(os.environ.get('QABOARD_LOCAL_REDIS_PORT', 6379))
BACKEND_PORT, FILES_PORT, WEBAPP_PORT = 5152, 5151, 3000
WEB_URL = f'http://localhost:{WEBAPP_PORT}'
USER = os.environ.get('QABOARD_LOCAL_USER', 'maya')
PASSWORD = os.environ.get('QABOARD_LOCAL_PASSWORD', 'qaboard-demo')
FULL_NAME = os.environ.get('QABOARD_LOCAL_FULL_NAME', 'Maya Chen')
EMAIL = os.environ.get('QABOARD_LOCAL_EMAIL', 'maya@example.com')

LOGS, PIDS, DATA = STACK / 'logs', STACK / 'pids', STACK / 'data'
# Postgres refuses to run as root, and its user can't reach every folder (e.g. under a 0700 root parent, and the
# harness resets them): its folder, <stack>/postgres, is bind-mounted where it can.
PG_DIR = STACK / 'postgres'
PG_MOUNT = Path(os.environ.get('QABOARD_LOCAL_PG_MOUNT', '/var/lib/postgresql/qaboard-local-stack'))
PGDATA = PG_MOUNT / 'pgdata'
TOKEN_FILE = STACK / 'token'


def log(message):
  print(f"[stack] {message}", file=sys.stderr, flush=True)


def pg_bin(name):
  versions = sorted(Path('/usr/lib/postgresql').glob('*/bin'), key=lambda p: int(p.parent.name))
  if not versions:
    sys.exit("Postgres isn't installed (/usr/lib/postgresql/*/bin)")
  return str(versions[-1] / name)


def as_postgres(args, **kwargs):
  """Postgres refuses to run as root"""
  if os.geteuid() == 0:
    args = ['runuser', '-u', 'postgres', '--', *args]
  return subprocess.run(args, check=True, **kwargs)


def backend_env():
  env = {k: v for k, v in os.environ.items() if not k.startswith('VIRTUAL_ENV')}
  env.update({
    'FLASK_APP': 'backend',
    'FLASK_DEBUG': '1',
    'QABOARD_DB_HOST': '127.0.0.1',
    'QABOARD_DB_PORT': str(PG_PORT),
    'QABOARD_DB_USER': 'qaboard',
    'QABOARD_DB_PASSWORD': 'password',
    'QABOARD_DB_NAME': 'qaboard',
    'REDIS_HOST': '127.0.0.1',
    'REDIS_PORT': str(REDIS_PORT),
    'QABOARD_DATA_DIR': str(DATA),
    'QABOARD_LOGIN_TYPE': 'LOCAL',
    'QABOARD_UPLOAD_ROOT': str(RESULTS),
    'QABOARD_STORAGE_ROOTS': str(RESULTS),
    # links in the server's answers (e.g. what `qa` prints) go to the web app
    'QABOARD_URL': WEB_URL,
    'QABOARD_HOST': f'localhost:{WEBAPP_PORT}',
    'QABOARD_SETUP': 'off',
    'NO_PROXY': '127.0.0.1,localhost',
    'no_proxy': '127.0.0.1,localhost',
    'PYTHONUNBUFFERED': '1',
  })
  return env


def pid_alive(name):
  pid_file = PIDS / f'{name}.pid'
  if not pid_file.exists():
    return None
  pid = int(pid_file.read_text())
  try:
    os.kill(pid, 0)
    return pid
  except OSError:
    return None


def spawn(name, args, cwd, env):
  if pid_alive(name):
    log(f"{name} is running (pid {pid_alive(name)})")
    return
  log_file = (LOGS / f'{name}.log').open('ab')
  process = subprocess.Popen(args, cwd=cwd, env=env, stdout=log_file, stderr=subprocess.STDOUT, stdin=subprocess.DEVNULL,
                             start_new_session=True)
  (PIDS / f'{name}.pid').write_text(str(process.pid))
  log(f"started {name} (pid {process.pid}), logs: {LOGS / f'{name}.log'}")


def http(url, data=None, headers=None, timeout=10, opener=None):
  opener = opener or urllib.request.build_opener(urllib.request.ProxyHandler({}))
  request = urllib.request.Request(url, data=data, headers=headers or {})
  with opener.open(request, timeout=timeout) as response:
    return response.status, response.read()


def wait_for(url, name, timeout=180):
  start = time.time()
  while time.time() - start < timeout:
    try:
      http(url, timeout=5)
      log(f"{name} is up: {url}")
      return
    except urllib.error.HTTPError as e:
      if e.code < 500:
        log(f"{name} is up: {url}")
        return
    except Exception:
      pass
    time.sleep(1)
  sys.exit(f"{name} didn't start in {timeout}s: see {LOGS}")


def mount_postgres_dir():
  PG_DIR.mkdir(parents=True, exist_ok=True)
  shutil.chown(PG_DIR, 'postgres', 'postgres')
  PG_MOUNT.mkdir(parents=True, exist_ok=True)
  if subprocess.run(['mountpoint', '-q', str(PG_MOUNT)]).returncode != 0:
    subprocess.run(['mount', '--bind', str(PG_DIR), str(PG_MOUNT)], check=True)
  shutil.chown(PG_MOUNT, 'postgres', 'postgres')


def postgres_up():
  mount_postgres_dir()
  if not (PGDATA / 'PG_VERSION').exists():
    if PGDATA.exists():
      shutil.rmtree(PGDATA)  # a failed initdb
    PGDATA.mkdir(parents=True)
    shutil.chown(PGDATA, 'postgres', 'postgres')
    pw = PG_MOUNT / '.pgpass-init'
    pw.write_text('password\n')
    shutil.chown(pw, 'postgres', 'postgres')
    as_postgres([pg_bin('initdb'), '-D', str(PGDATA), '-U', 'qaboard', '--pwfile', str(pw), '-A', 'md5', '-E', 'UTF8'],
                stdout=subprocess.DEVNULL)
    pw.unlink()
  status = subprocess.run(['runuser', '-u', 'postgres', '--', pg_bin('pg_ctl'), '-D', str(PGDATA), 'status'],
                          capture_output=True)
  if status.returncode != 0:
    socket_dir = PG_MOUNT / 'socket'
    socket_dir.mkdir(exist_ok=True)
    shutil.chown(socket_dir, 'postgres', 'postgres')
    pg_log = PG_MOUNT / 'postgres.log'
    pg_log.touch()
    shutil.chown(pg_log, 'postgres', 'postgres')
    as_postgres([pg_bin('pg_ctl'), '-D', str(PGDATA), '-l', str(pg_log), '-w', 'start',
                 '-o', f"-p {PG_PORT} -k {socket_dir} -c listen_addresses=127.0.0.1"], stdout=subprocess.DEVNULL)
    log(f"started postgres on 127.0.0.1:{PG_PORT}")
  else:
    log("postgres is running")
  env = {**os.environ, 'PGPASSWORD': 'password'}
  exists = subprocess.run(['psql', '-h', '127.0.0.1', '-p', str(PG_PORT), '-U', 'qaboard', '-d', 'postgres', '-tAc',
                           "SELECT 1 FROM pg_database WHERE datname='qaboard'"], env=env, capture_output=True, text=True, check=True)
  if exists.stdout.strip() != '1':
    subprocess.run(['createdb', '-h', '127.0.0.1', '-p', str(PG_PORT), '-U', 'qaboard', 'qaboard'], env=env, check=True)
    log("created the qaboard database")


def redis_up():
  if pid_alive('redis'):
    log("redis is running")
    return
  (STACK / 'redis').mkdir(exist_ok=True)
  spawn('redis', ['redis-server', '--port', str(REDIS_PORT), '--bind', '127.0.0.1', '--dir', str(STACK / 'redis'),
                  '--save', '', '--appendonly', 'no'], cwd=STACK, env=os.environ.copy())


def migrate(env):
  """What backend/migrate.sh does: importing the app creates the tables, then alembic stamps or upgrades"""
  backend = REPO / 'backend'
  subprocess.run(['uv', 'run', 'flask', 'routes'], cwd=backend, env=env, check=True, stdout=subprocess.DEVNULL)
  current = subprocess.run(['uv', 'run', '--project', str(backend), 'alembic', 'current'], cwd=backend / 'backend', env=env,
                           capture_output=True, text=True)
  if re.search(r'^[0-9a-f]{12}', current.stdout, re.M):
    subprocess.run(['uv', 'run', '--project', str(backend), 'alembic', 'upgrade', 'head'], cwd=backend / 'backend', env=env, check=True)
  else:
    subprocess.run(['uv', 'run', '--project', str(backend), 'alembic', 'stamp', 'head'], cwd=backend / 'backend', env=env, check=True)


def ensure_user_and_token(env):
  backend = REPO / 'backend'
  create = subprocess.run(['uv', 'run', 'qaboard-admin', 'create-admin', USER, '--password', '--full-name', FULL_NAME,
                           '--email', EMAIL], cwd=backend, env=env, input=PASSWORD + '\n', text=True, capture_output=True)
  if create.returncode != 0:
    sys.exit(f"Could not create {USER}: {create.stdout}{create.stderr}")
  if TOKEN_FILE.exists():
    token = TOKEN_FILE.read_text().strip()
    try:
      http(f'http://127.0.0.1:{BACKEND_PORT}/api/v1/user/me/', headers={'Authorization': f'Bearer {token}'})
      log(f"token for {USER}: {TOKEN_FILE}")
      return
    except urllib.error.HTTPError:
      pass
  opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPCookieProcessor(CookieJar()))
  base = f'http://127.0.0.1:{BACKEND_PORT}'
  origin = {'Origin': base}
  http(f'{base}/api/v1/user/auth/', data=urllib.parse.urlencode({'username': USER, 'password': PASSWORD}).encode(),
       headers={**origin, 'Content-Type': 'application/x-www-form-urlencoded'}, opener=opener)
  # the legacy endpoint: a token valid a year with the scopes `qa` needs (runs, uploads)
  _, body = http(f'{base}/api/v1/user/token/', data=b'{}', headers={**origin, 'Content-Type': 'application/json'}, opener=opener)
  TOKEN_FILE.write_text(json.loads(body)['token'] + '\n')
  TOKEN_FILE.chmod(0o600)
  log(f"created a token for {USER}: {TOKEN_FILE}")


def up():
  for folder in (STACK, LOGS, PIDS, DATA, RESULTS):
    folder.mkdir(parents=True, exist_ok=True)
  # postgres runs as its own user: it must reach its folders
  pass
  postgres_up()
  redis_up()
  env = backend_env()
  backend = REPO / 'backend'
  if not pid_alive('backend'):
    migrate(env)
  spawn('backend', ['uv', 'run', 'flask', 'run', '--host', '127.0.0.1', '--port', str(BACKEND_PORT), '--with-threads'],
        cwd=backend, env=env)
  # the server's jobs (Admin > Storage): deletions, retention rules, silent runs...
  spawn('jobs-worker', ['uv', 'run', 'qaboard-admin', 'jobs', 'worker'], cwd=backend, env=env)
  spawn('fileserver', ['uv', 'run', '--script', str(HERE / 'fileserver.py'), '--port', str(FILES_PORT),
                       '--backend', f'http://127.0.0.1:{BACKEND_PORT}', '--root', str(RESULTS)], cwd=HERE, env=env)
  webapp_env = {**os.environ,
                'REACT_APP_QABOARD_API_HOST': f'http://127.0.0.1:{BACKEND_PORT}',
                'REACT_APP_QABOARD_HOST': f'http://127.0.0.1:{FILES_PORT}',
                'HOST': '0.0.0.0',
                'NO_PROXY': '127.0.0.1,localhost', 'no_proxy': '127.0.0.1,localhost',
                'HTTP_PROXY': '', 'http_proxy': '', 'HTTPS_PROXY': '', 'https_proxy': ''}
  if not (REPO / 'webapp' / 'node_modules').exists():
    subprocess.run(['npm', 'install'], cwd=REPO / 'webapp', check=True)
  spawn('webapp', ['npm', 'start'], cwd=REPO / 'webapp', env=webapp_env)
  wait_for(f'http://127.0.0.1:{BACKEND_PORT}/api/v1/health', 'backend')
  wait_for(f'http://127.0.0.1:{FILES_PORT}/s/', 'file server')
  wait_for(f'http://127.0.0.1:{WEBAPP_PORT}/', 'web app')
  ensure_user_and_token(env)
  print(json.dumps({'web': WEB_URL, 'user': USER, 'password': PASSWORD, 'token_file': str(TOKEN_FILE),
                    'results': str(RESULTS), 'logs': str(LOGS)}, indent=2))


def down():
  for name in ('webapp', 'fileserver', 'jobs-worker', 'backend', 'redis'):
    pid = pid_alive(name)
    if pid:
      try:
        os.killpg(pid, signal.SIGTERM)
      except OSError:
        os.kill(pid, signal.SIGTERM)
      log(f"stopped {name}")
    (PIDS / f'{name}.pid').unlink(missing_ok=True)
  if subprocess.run(['mountpoint', '-q', str(PG_MOUNT)]).returncode == 0 and (PGDATA / 'PG_VERSION').exists():
    subprocess.run(['runuser', '-u', 'postgres', '--', pg_bin('pg_ctl'), '-D', str(PGDATA), '-m', 'fast', 'stop'],
                   capture_output=True)
    log("stopped postgres")
    subprocess.run(['umount', str(PG_MOUNT)], capture_output=True)


def status():
  for name in ('redis', 'backend', 'jobs-worker', 'fileserver', 'webapp'):
    pid = pid_alive(name)
    print(f"{name:12} {'running, pid ' + str(pid) if pid else 'stopped'}")
  pg = subprocess.run(['mountpoint', '-q', str(PG_MOUNT)])
  if pg.returncode == 0:
    pg = subprocess.run(['runuser', '-u', 'postgres', '--', pg_bin('pg_ctl'), '-D', str(PGDATA), 'status'], capture_output=True)
  print(f"{'postgres':12} {'running' if pg.returncode == 0 else 'stopped'}")


def reset():
  down()
  for path in (PG_DIR, DATA, STACK / 'redis', TOKEN_FILE):
    if path.is_dir():
      shutil.rmtree(path)
    else:
      path.unlink(missing_ok=True)
  for child in RESULTS.iterdir() if RESULTS.exists() else []:
    shutil.rmtree(child) if child.is_dir() else child.unlink()
  log("deleted the database, the server's data and the results")


if __name__ == '__main__':
  command = sys.argv[1] if len(sys.argv) > 1 else 'up'
  {'up': up, 'down': down, 'status': status, 'reset': reset}[command]()
