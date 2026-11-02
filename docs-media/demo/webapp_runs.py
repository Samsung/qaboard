#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""
Lets the demo stack list and run the examples' tests from the web app (Available Tests, Run Tests / Tuning).

  uv run docs-media/demo/webapp_runs.py link --project detection-eval     # the server sees the example's inputs
  uv run docs-media/demo/webapp_runs.py build --project detection-eval    # ...and runs them (a few minutes, once)
  uv run docs-media/demo/webapp_runs.py unlink --project detection-eval   # back to the restored snapshot
  uv run docs-media/demo/webapp_runs.py delete-batch --project detection-eval --commit int8-percentile --label int8-nms

The examples' qaboard.yaml say `inputs.database: inputs`, a folder of the project: relative to the commit's artifacts
folder, where the server lists a batch's tests and where the batches started from the web app run (`qa save-artifacts`
doesn't save the inputs). The snapshot's artifacts folders don't have them, so the tuning forms showed "0 total runs".

- link: copies the example to <results>/.qaboard-demo-runs/<repo>, gets its inputs (qa/fetch_inputs.py, when it has
  one), and links inputs/ and inputs.lock.yaml there from the artifacts folder of each of the story's commits.
  To list a batch's tests, the server imports the commit's entrypoint, as root in the backend's container: the
  detector's qa/main.py downloads its inputs when imported. With the inputs already there, it doesn't: the listing is
  quick, and leaves no files the runs started here can't write.
- build: also what the runs need, in the backend's container (QABOARD_TUNING_RUNNER=local, compose.demo.yml): the
  example's qa/build.py (inputs fetched, models built), its requirements.txt installed for the backend's Python, and
  <results>/<project id>/.envrc, which the backend's `qa batch` sources: that Python path, the example's environment,
  and the API from inside the container. Cached: a second build does nothing.
- unlink: removes the links and the .envrc (not the cache), so that nothing of it ends up in a snapshot.
- delete-batch: deletes a batch a capture started (as the commit's author), and its folder, which the backend's
  container wrote (as root).
Paths are the same on the host and in the backend's container: the results storage is mounted at the same path.
"""
import os
import sys
import json
import shutil
import hashlib
import argparse
import subprocess
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import stack  # noqa: E402
from stack import log, REPO  # noqa: E402

# What an example's runs need in their environment, besides its Python packages. {cache}: its folder in the cache
ENVIRONMENT = {
  'detection-eval': {'DETECTOR_MODELS_DIR': '{cache}/models'},
}
LINKS = ['inputs', 'inputs.lock.yaml']


def cache_dir(repo: str) -> Path:
  return stack.results_root() / '.qaboard-demo-runs' / repo


def demo_project(project: str) -> dict:
  demo = json.loads((stack.demo_dir() / 'demo.json').read_text())
  if project not in demo['projects']:
    raise SystemExit(f"ERROR: {project} isn't in the demo data ({', '.join(demo['projects'])})")
  return demo['projects'][project]


def commit_dirs(info: dict):
  root = stack.results_root() / info['id']
  for commit in info['commits'].values():
    path = root / commit['sha'][:2] / commit['sha'][2:16]
    if path.is_dir():
      yield path


def writable(cache: Path):
  """Files the backend's container wrote in the cache (as root) are given back to us"""
  if cache.exists() and any(not os.access(p, os.W_OK) for p in [cache, *cache.rglob('*')] if not p.is_symlink()):
    log(f"{cache}: some files belong to another user, the backend's container gives them back", 'yellow')
    stack.compose('exec', '-T', 'backend', 'chown', '-R', f"{os.getuid()}:{os.getgid()}", str(cache))


def link(project: str) -> Path:
  info = demo_project(project)
  cache = cache_dir(info['id'].split('/')[-1])
  log(f"{project}: the example's inputs in {cache}, linked from its commits' artifacts", 'blue')
  writable(cache)
  shutil.copytree(REPO / 'examples' / project, cache, dirs_exist_ok=True,
                  ignore=shutil.ignore_patterns('.venv', 'output', 'models', 'target', '__pycache__', '*.pyc', '.git'))
  # before the server lists tests: see the docstring (does nothing once the inputs are there)
  if (cache / 'qa' / 'fetch_inputs.py').exists():
    subprocess.run(['uv', 'run', '-q', 'qa/fetch_inputs.py'], cwd=cache, check=True,
                   env={k: v for k, v in os.environ.items() if k != 'VIRTUAL_ENV'})
  for path in commit_dirs(info):
    for name in LINKS:
      target, source = path / name, cache / name
      if source.exists() and (target.is_symlink() or not target.exists()):
        target.unlink(missing_ok=True)
        target.symlink_to(source)
  return cache


def backend_python() -> tuple[str, str]:
  """The (version, platform) of the backend container's Python, for `uv pip install --python-version --python-platform`"""
  r = stack.compose('exec', '-T', 'backend', 'python', '-c',
                    'import sys, platform; print(f"{sys.version_info[0]}.{sys.version_info[1]} {platform.machine()}")', capture=True)
  version, machine = r.stdout.decode().split()
  return version, f"{machine}-manylinux_2_28"


def build(project: str):
  cache = link(project)
  info = demo_project(project)
  requirements = cache / 'requirements.txt'
  # the example's own build step, like the seeder's, with its dependencies
  python = ['uv', 'run', '-q', '--no-project', '--python', '3.12', *(['--with-requirements', str(requirements)] if requirements.exists() else []), 'python']
  env = {**{k: v for k, v in os.environ.items() if k not in ('VIRTUAL_ENV',)}, **{k: v.format(cache=cache) for k, v in ENVIRONMENT.get(project, {}).items()}}
  log(f"{project}: fetching its inputs" + (", building it (qa/build.py)" if (cache / 'qa' / 'build.py').exists() else ''), 'blue')
  subprocess.run([*python, '-c', "import sys; sys.path.insert(0, 'qa'); import main"], cwd=cache, env=env, check=True)
  if (cache / 'qa' / 'build.py').exists():
    subprocess.run([*python, 'qa/build.py'], cwd=cache, env=env, check=True)

  # its Python packages, for the backend's Python
  version, python_platform = backend_python()
  packages = cache.parent / f"python{version}-{project}"
  stamp = packages / '.requirements'
  wanted = hashlib.sha256((requirements.read_text() if requirements.exists() else '').encode()).hexdigest()
  if requirements.exists() and (not stamp.exists() or stamp.read_text() != wanted):
    log(f"{project}: installing requirements.txt for the backend's Python {version} in {packages}", 'blue')
    subprocess.run(['uv', 'pip', 'install', '-q', '--target', str(packages), '--python-version', version,
                    '--python-platform', python_platform, '-r', str(requirements)], check=True)
    stamp.write_text(wanted)

  # sourced by the `qa batch` the backend starts (backend/api/tuning.py), from the folders above the artifacts
  exports = {
    'PYTHONPATH': str(packages),
    **{k: v.format(cache=cache) for k, v in ENVIRONMENT.get(project, {}).items()},
    # the API from inside the backend's container (its uWSGI's http-socket); links keep QABOARD_URL
    'QABOARD_API_PREFIX': 'http://localhost:3001/api/v1',
  }
  envrc = stack.results_root() / info['id'] / '.envrc'
  envrc.write_text('# The demo runs started from the web app: docs-media/demo/webapp_runs.py\n'
                   + ''.join(f"export {k}={v}\n" for k, v in exports.items()))
  log(f"{project}: ready to run from the web app ({envrc})", 'green')


def unlink(project: str):
  info = demo_project(project)
  cache = cache_dir(info['id'].split('/')[-1])
  for path in commit_dirs(info):
    for name in LINKS:
      target = path / name
      if target.is_symlink() and str(os.readlink(target)).startswith(str(cache)):
        target.unlink()
  (stack.results_root() / info['id'] / '.envrc').unlink(missing_ok=True)


def delete_batch(project: str, commit: str, label: str):
  import http.cookiejar
  import urllib.parse
  import urllib.request
  info = demo_project(project)
  entry = info['commits'][commit]
  opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
  url = stack.server_url()
  with opener.open(f"{url}/api/v1/commit/{entry['sha']}?{urllib.parse.urlencode({'project': info['id']})}") as r:
    batch = json.load(r).get('batches', {}).get(label)
  if batch:
    opener.open(f"{url}/api/v1/user/auth/", urllib.parse.urlencode({'username': entry['author'], 'password': 'kitefin-demo'}).encode())
    opener.open(urllib.request.Request(f"{url}/api/v1/batch/{batch['id']}/", method='DELETE'))
    log(f"{project}: deleted the {label} batch of {commit}", 'dim')
  # what's left: the logs of the `qa batch` the backend started
  folder = stack.results_root() / info['id'] / entry['sha'][:2] / entry['sha'][2:16] / 'output' / label
  if folder.exists():
    stack.compose('exec', '-T', 'backend', 'rm', '-rf', str(folder))


def main():
  parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
  parser.add_argument('action', choices=['link', 'build', 'unlink', 'delete-batch'])
  parser.add_argument('--project', required=True, help='an example, e.g. detection-eval')
  parser.add_argument('--commit', help='delete-batch: a story commit id')
  parser.add_argument('--label', help='delete-batch: the batch')
  args = parser.parse_args()
  if args.action == 'delete-batch':
    if not args.commit or not args.label:
      parser.error('delete-batch needs --commit and --label')
    delete_batch(args.project, args.commit, args.label)
  else:
    {'link': link, 'build': build, 'unlink': unlink}[args.action](args.project)


if __name__ == '__main__':
  main()
