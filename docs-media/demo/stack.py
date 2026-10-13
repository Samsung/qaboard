"""
The demo stack: docker-compose.yml + docs-media/compose.demo.yml, project `qaboard-demo`.
Shared by seed.py and snapshot.py (standard library only).
"""
import os
import sys
import json
import time
import shutil
import subprocess
import urllib.request
from pathlib import Path
from typing import Dict, List, Optional


REPO = Path(__file__).resolve().parents[2]
COMPOSE_FILES = [REPO / 'docker-compose.yml', REPO / 'docs-media' / 'compose.demo.yml']
# QABOARD_DEMO_PROJECT runs a second stack next to the first, with its own QABOARD_DEMO_PORT and QABOARD_DEMO_RESULTS
PROJECT = os.environ.get('QABOARD_DEMO_PROJECT', 'qaboard-demo')
# Where seed.py writes what it seeded (T0, the stories' shas...), inside the results storage, so that it is part of
# snapshots. Served at http://localhost:5151/s/<results>/.qaboard-demo/
DEMO_DIR_NAME = '.qaboard-demo'


def log(message: str, color: str = ''):
  colors = {'red': '31', 'green': '32', 'yellow': '33', 'blue': '34', 'cyan': '36', 'dim': '2', 'bold': '1'}
  if color and sys.stderr.isatty():
    message = f"\033[{colors[color]}m{message}\033[0m"
  print(message, file=sys.stderr, flush=True)


def image() -> str:
  """
  Where the images come from: $QABOARD_IMAGE; in GitHub Actions, the repository owner's ghcr.io/<owner>/qaboard,
  so that forks use the images they publish; else the official images, ghcr.io/samsung/qaboard.
  """
  if os.environ.get('QABOARD_IMAGE'):
    return os.environ['QABOARD_IMAGE']
  owner = os.environ.get('GITHUB_REPOSITORY_OWNER')
  if owner:
    return f"ghcr.io/{owner.lower()}/qaboard"
  return 'ghcr.io/samsung/qaboard'


def service_image(service: str) -> str:
  """A service's image, as compose.demo.yml picks it: $QABOARD_DEMO_<SERVICE>_IMAGE, else $QABOARD_IMAGE:<service>"""
  override = os.environ.get(f"QABOARD_DEMO_{service.upper()}_IMAGE")
  if override:
    return override
  version = os.environ.get('QABOARD_VERSION')
  return f"{image()}:{service}{'-' + version if version else ''}"


def results_root() -> Path:
  return Path(os.environ.get('QABOARD_DEMO_RESULTS', '/mnt/qaboard'))


def port() -> int:
  return int(os.environ.get('QABOARD_DEMO_PORT', 5151))


def server_url() -> str:
  return f"http://localhost:{port()}"


def demo_dir() -> Path:
  return results_root() / DEMO_DIR_NAME


def compose_env() -> Dict[str, str]:
  return {
    **os.environ,
    'QABOARD_IMAGE': image(),
    'QABOARD_DEMO_RESULTS': str(results_root()),
    'QABOARD_DEMO_PORT': str(port()),
  }


def compose(*args: str, check=True, capture=False, input: Optional[bytes] = None, stdout=None) -> subprocess.CompletedProcess:
  command = ['docker', 'compose', '-p', PROJECT, '--project-directory', str(REPO)]
  for f in COMPOSE_FILES:
    command += ['-f', str(f)]
  command += list(args)
  return subprocess.run(
    command,
    check=check,
    input=input,
    stdout=stdout if stdout is not None else (subprocess.PIPE if capture else None),
    stderr=subprocess.PIPE if capture else None,
    env=compose_env(),
  )


def ensure_results_root():
  root = results_root()
  try:
    root.mkdir(parents=True, exist_ok=True)
  except PermissionError:
    # e.g. in GitHub Actions, sudo doesn't ask for a password
    sudo = shutil.which('sudo') and subprocess.run(['sudo', '-n', 'true'], capture_output=True).returncode == 0
    if sudo:
      subprocess.run(['sudo', '-n', 'mkdir', '-p', str(root)], check=True)
      subprocess.run(['sudo', '-n', 'chown', f"{os.getuid()}:{os.getgid()}", str(root)], check=True)
    else:
      log(f"ERROR: Can't create the results storage {root}. Create it with:", 'red')
      log(f"  sudo mkdir -p {root} && sudo chown $USER {root}", 'red')
      sys.exit(1)
  if not os.access(root, os.W_OK):
    log(f"ERROR: Can't write in the results storage {root}: sudo chown $USER {root}", 'red')
    sys.exit(1)


def services_running() -> List[str]:
  r = compose('ps', '--services', '--status', 'running', check=False, capture=True)
  return r.stdout.decode().split() if r.returncode == 0 else []


def http_ok(url: str, timeout=5) -> bool:
  # never through a proxy: it may not reach localhost
  opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
  try:
    with opener.open(url, timeout=timeout) as r:
      return 200 <= r.status < 300
  except Exception:
    return False


def wait_until(predicate, timeout: float, what: str, every=2.0):
  start = time.time()
  while not predicate():
    if time.time() - start > timeout:
      log(f"ERROR: timed out after {timeout:.0f}s waiting for {what}", 'red')
      sys.exit(1)
    time.sleep(every)


def wait_healthy(timeout=300):
  wait_until(lambda: http_ok(f"{server_url()}/api/v1/health"), timeout, f"the backend ({server_url()}/api/v1/health)")
  wait_until(lambda: http_ok(f"{server_url()}/"), timeout, f"the web app ({server_url()}/)")


def up(*services: str, pull=False):
  """Starts the stack (or some services) and waits until the web app answers."""
  ensure_results_root()
  overrides = [f"{s}: {os.environ[f'QABOARD_DEMO_{s.upper()}_IMAGE']}" for s in ('backend', 'frontend', 'proxy', 'cantaloupe')
               if os.environ.get(f"QABOARD_DEMO_{s.upper()}_IMAGE")]
  log(f"Starting the demo stack ({image()}:<service>{', ' + ', '.join(overrides) if overrides else ''}, "
      f"results in {results_root()}, {server_url()})", 'blue')
  if pull:
    compose('pull', '--quiet', '--ignore-buildable', *services)
  compose('up', '-d', '--remove-orphans', *services)
  if not services or 'proxy' in services:
    wait_healthy()


def down(volumes=False):
  compose('down', '--remove-orphans', *(['--volumes'] if volumes else []))


def is_up() -> bool:
  return http_ok(f"{server_url()}/api/v1/health")


def psql(sql: str, *, check=True) -> str:
  """Runs SQL in the stack's database, returns the rows as text (fields separated by |)."""
  r = compose(
    'exec', '-T', 'db', 'psql', '-U', 'qaboard', '-d', 'qaboard', '-v', 'ON_ERROR_STOP=1', '-q', '-A', '-t', '-f', '-',
    input=sql.encode(), capture=True, check=False,
  )
  if check and r.returncode != 0:
    raise RuntimeError(f"SQL failed: {r.stderr.decode()}\n{sql}")
  return r.stdout.decode().strip()


def backend_version() -> str:
  """The backend's qaboard version, plus the git sha its image was built from if known, e.g. 1.1.1+78813fe"""
  r = compose('exec', '-T', 'backend', 'python', '-c', 'import importlib.metadata as m; print(m.version("qaboard"))', capture=True, check=False)
  version = r.stdout.decode().strip() if r.returncode == 0 else 'unknown'
  inspect = subprocess.run(
    ['docker', 'inspect', '--format', '{{json .Config.Labels}}', service_image('backend')],
    capture_output=True, text=True,
  )
  try:
    labels = json.loads(inspect.stdout) or {}
  except ValueError:
    labels = {}
  # CI labels the images with their commit; else the tag may say it (QABOARD_VERSION=<sha>, like CI's builds)
  revision = labels.get('org.opencontainers.image.revision') or os.environ.get('QABOARD_VERSION')
  return f"{version}+{revision[:7]}" if revision else version


def docker_available() -> bool:
  return shutil.which('docker') is not None
