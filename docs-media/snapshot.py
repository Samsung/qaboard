#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["boto3>=1.34", "zstandard>=0.22"]
# ///
"""
Saves and restores the demo stack's data (the database and the seeded results) as snapshots in R2.

  uv run docs-media/snapshot.py key                    # the snapshot key of this checkout
  uv run docs-media/snapshot.py save                   # the running demo stack -> snapshots/<key>.tar.zst
  uv run docs-media/snapshot.py restore                # snapshots/<key>.tar.zst -> a fresh demo stack
  uv run docs-media/snapshot.py restore --latest       # the most recent snapshot, whatever its key
  uv run docs-media/snapshot.py list | info [KEY] | delete KEY

- The key is a hash of what the data depends on: examples/**, docs-media/seed.py, backend/backend/models/** and
  qaboard/** (git-tracked and untracked files, not ignored ones). When it changes, the stories must be seeded again.
- In R2 (bucket qaboard-ci, $R2_BUCKET): snapshots/<key>.tar.zst, and its metadata snapshots/<key>.json
  (key, T0, projects and their commits' shas, app version, images...). R2_ACCOUNT_ID, R2_ACCESS_KEY_ID and
  R2_SECRET_ACCESS_KEY come from the environment.
- The archive holds metadata.json, db.sql (pg_dump), and results/: the seeded commits' folders and .qaboard-demo/,
  relative to the results storage. It restores at the same path ($QABOARD_DEMO_RESULTS, default /mnt/qaboard),
  since the database has absolute paths.
- Archives are cached in ~/.cache/qaboard-demo/snapshots (--cache-dir).
"""
import os
import io
import sys
import json
import time
import shutil
import tarfile
import hashlib
import argparse
import datetime
import subprocess
import tempfile
import urllib.parse
import urllib.request
from pathlib import Path
from typing import Dict, List, Optional

sys.path.insert(0, str(Path(__file__).resolve().parent / 'demo'))
import stack  # noqa: E402
from stack import log, REPO  # noqa: E402

KEY_PATHS = ['examples', 'docs-media/seed.py', 'backend/backend/models', 'qaboard']
BUCKET = os.environ.get('R2_BUCKET', 'qaboard-ci')
PREFIX = 'snapshots/'


def snapshot_key() -> str:
  """A hash of the files the demo data depends on"""
  files = subprocess.run(
    ['git', 'ls-files', '-z', '--cached', '--others', '--exclude-standard', '--', *KEY_PATHS],
    cwd=REPO, capture_output=True, check=True,
  ).stdout.decode().split('\0')
  digest = hashlib.sha256()
  for rel in sorted(set(f for f in files if f)):
    path = REPO / rel
    if not path.is_file():   # deleted but still in the index
      continue
    digest.update(rel.encode() + b'\0' + hashlib.sha256(path.read_bytes()).digest())
  return digest.hexdigest()[:16]


def r2():
  import boto3
  missing = [v for v in ('R2_ACCOUNT_ID', 'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY') if not os.environ.get(v)]
  if missing:
    raise SystemExit(f"ERROR: set {', '.join(missing)} to use R2")
  return boto3.client(
    's3',
    endpoint_url=f"https://{os.environ['R2_ACCOUNT_ID']}.r2.cloudflarestorage.com",
    aws_access_key_id=os.environ['R2_ACCESS_KEY_ID'],
    aws_secret_access_key=os.environ['R2_SECRET_ACCESS_KEY'],
    region_name='auto',
  )


def git_info() -> Dict:
  def git(*args):
    r = subprocess.run(['git', *args], cwd=REPO, capture_output=True, text=True)
    return r.stdout.strip() if r.returncode == 0 else None
  return {
    'sha': git('rev-parse', 'HEAD'),
    'branch': git('rev-parse', '--abbrev-ref', 'HEAD'),
    'dirty': bool(git('status', '--porcelain', '--', *KEY_PATHS)),
  }


def image_digests() -> Dict[str, str]:
  digests = {}
  for service in ('backend', 'frontend', 'proxy', 'cantaloupe'):
    tag = f"{stack.image()}:{service}{'-' + os.environ['QABOARD_VERSION'] if os.environ.get('QABOARD_VERSION') else ''}"
    r = subprocess.run(['docker', 'image', 'inspect', '--format', '{{json .RepoDigests}}', tag], capture_output=True, text=True)
    try:
      repo_digests = json.loads(r.stdout) if r.returncode == 0 else []
    except ValueError:
      repo_digests = []
    digests[service] = repo_digests[0] if repo_digests else tag
  return digests


def human(n: float) -> str:
  for unit in ('B', 'KB', 'MB', 'GB'):
    if n < 1024:
      return f"{n:.1f} {unit}"
    n /= 1024
  return f"{n:.1f} TB"


# ------------------------------------------------------------------------------------------------ save

def results_paths(demo: Dict) -> List[Path]:
  """What the snapshot keeps from the results storage: the stories' commit folders, and .qaboard-demo/"""
  root = stack.results_root()
  paths = [stack.demo_dir()]
  for project in demo.get('projects', {}).values():
    for commit in project['commits'].values():
      sha = commit['sha']
      path = root / project['id'] / sha[:2] / sha[2:16]
      if path.exists():
        paths.append(path)
  return paths


def check_projects(demo: Dict):
  """The database must only have the stories' commits: no leftovers from tests"""
  for name, project in demo.get('projects', {}).items():
    if not project.get('complete'):
      raise SystemExit(f"ERROR: {name} was seeded with --until: seed it completely before saving a snapshot")
    shas = {c['sha'] for c in project['commits'].values()}
    rows = stack.psql(f"SELECT hexsha FROM ci_commits WHERE project_id = '{project['id']}'").split()
    extra = set(rows) - shas
    if extra:
      raise SystemExit(f"ERROR: {project['id']} has {len(extra)} commits that aren't in its story (e.g. {sorted(extra)[0]}). Seed it again.")
  ids = {p['id'] for p in demo.get('projects', {}).values()}
  others = [p for p in stack.psql("SELECT id FROM projects").split() if p not in ids]
  if others:
    log(f"WARNING: the database has projects that weren't seeded: {others}. They are in the snapshot.", 'yellow')


def save(args):
  demo_path = stack.demo_dir() / 'demo.json'
  if not demo_path.exists():
    raise SystemExit(f"ERROR: {demo_path} doesn't exist: seed the stack first (docs-media/seed.py)")
  demo = json.loads(demo_path.read_text())
  if args.only:
    demo['projects'] = {k: v for k, v in demo['projects'].items() if k in args.only}
  check_projects(demo)
  key = args.key or snapshot_key()
  client = r2() if not args.no_upload else None
  if client and not args.force:
    try:
      client.head_object(Bucket=BUCKET, Key=f"{PREFIX}{key}.tar.zst")
      raise SystemExit(f"ERROR: snapshots/{key}.tar.zst already exists in {BUCKET} (use --force to replace it)")
    except client.exceptions.ClientError as e:
      if e.response['Error']['Code'] not in ('404', 'NoSuchKey', 'NotFound'):
        raise
  metadata = {
    'key': key,
    'created_at': datetime.datetime.now(datetime.timezone.utc).isoformat(),
    't0': demo['t0'],
    'results_root': str(stack.results_root()),
    'app_version': stack.backend_version(),
    'images': image_digests(),
    'git': git_info(),
    'projects': {
      name: {k: v for k, v in p.items() if k != 'users'}
      for name, p in demo['projects'].items()
    },
    'users': next(iter(demo['projects'].values()), {}).get('users', {}),
    'key_paths': KEY_PATHS,
  }
  if metadata['git']['dirty']:
    log("WARNING: the checkout has uncommitted changes in the files the key depends on", 'yellow')

  cache = Path(args.cache_dir)
  cache.mkdir(parents=True, exist_ok=True)
  archive = cache / f"{key}.tar.zst"
  start = time.time()
  log(f"Dumping the database...", 'blue')
  with tempfile.TemporaryDirectory() as tmp:
    dump = Path(tmp) / 'db.sql'
    with dump.open('wb') as f:
      stack.compose('exec', '-T', 'db', 'pg_dump', '-U', 'qaboard', '--no-owner', '--no-privileges', 'qaboard', stdout=f)
    root = stack.results_root()
    paths = results_paths(demo)
    log(f"Archiving the database ({human(dump.stat().st_size)}) and {len(paths)} folders of results to {archive}...", 'blue')
    import zstandard
    files = 0
    with archive.open('wb') as raw, zstandard.ZstdCompressor(level=args.level, threads=-1).stream_writer(raw) as zst, \
         tarfile.open(fileobj=zst, mode='w|') as tar:
      data = json.dumps(metadata, indent=2).encode()
      info = tarfile.TarInfo('metadata.json')
      info.size, info.mtime, info.mode = len(data), int(time.time()), 0o644
      tar.addfile(info, io.BytesIO(data))
      tar.add(dump, arcname='db.sql')
      for path in paths:
        tar.add(path, arcname=f"results/{path.relative_to(root)}")
        files += sum(1 for _ in path.rglob('*')) if path.is_dir() else 1
  metadata['size_bytes'] = archive.stat().st_size
  metadata['files'] = files
  log(f"{archive.name}: {human(metadata['size_bytes'])}, {files} files ({time.time() - start:.0f}s)", 'green')
  if client:
    log(f"Uploading to {BUCKET}/{PREFIX}{key}.tar.zst...", 'blue')
    start = time.time()
    from boto3.s3.transfer import TransferConfig
    client.upload_file(str(archive), BUCKET, f"{PREFIX}{key}.tar.zst",
                       ExtraArgs={'ContentType': 'application/zstd', 'Metadata': {'t0': metadata['t0']}},
                       Config=TransferConfig(multipart_chunksize=64 * 2**20, max_concurrency=4))
    client.put_object(Bucket=BUCKET, Key=f"{PREFIX}{key}.json", Body=json.dumps(metadata, indent=2).encode(),
                      ContentType='application/json')
    log(f"Uploaded in {time.time() - start:.0f}s", 'green')
  print(json.dumps({k: metadata[k] for k in ('key', 't0', 'app_version', 'size_bytes')}))


# ------------------------------------------------------------------------------------------------ restore

def latest_key(client) -> str:
  objects = []
  for page in client.get_paginator('list_objects_v2').paginate(Bucket=BUCKET, Prefix=PREFIX):
    objects += [o for o in page.get('Contents', []) if o['Key'].endswith('.tar.zst')]
  if not objects:
    raise SystemExit(f"ERROR: no snapshot in {BUCKET}/{PREFIX}")
  newest = max(objects, key=lambda o: o['LastModified'])
  return newest['Key'][len(PREFIX):-len('.tar.zst')]


def fetch(args) -> Path:
  if args.file:
    return Path(args.file)
  client = None
  key = args.key
  if args.latest:
    client = r2()
    key = latest_key(client)
  key = key or snapshot_key()
  archive = Path(args.cache_dir) / f"{key}.tar.zst"
  if archive.exists():
    log(f"Using the cached {archive}", 'dim')
    return archive
  client = client or r2()
  archive.parent.mkdir(parents=True, exist_ok=True)
  log(f"Downloading {BUCKET}/{PREFIX}{key}.tar.zst...", 'blue')
  partial = archive.with_suffix('.partial')
  try:
    client.download_file(BUCKET, f"{PREFIX}{key}.tar.zst", str(partial))
  except client.exceptions.ClientError as e:
    if e.response['Error']['Code'] in ('404', 'NoSuchKey', 'NotFound'):
      raise SystemExit(f"ERROR: no snapshot {key} in {BUCKET}. Seed and save one, or use --latest.")
    raise
  partial.rename(archive)
  return archive


def members(archive: Path):
  import zstandard
  with archive.open('rb') as raw, zstandard.ZstdDecompressor().stream_reader(raw) as zst, tarfile.open(fileobj=zst, mode='r|') as tar:
    for member in tar:
      yield tar, member


def read_metadata(archive: Path) -> Dict:
  for tar, member in members(archive):
    if member.name == 'metadata.json':
      return json.loads(tar.extractfile(member).read())
    break
  raise SystemExit(f"ERROR: {archive} has no metadata.json")


def restore(args):
  archive = fetch(args)
  metadata = read_metadata(archive)
  root = stack.results_root()
  if metadata['results_root'] != str(root):
    raise SystemExit(f"ERROR: the snapshot's results are in {metadata['results_root']}: QABOARD_DEMO_RESULTS={metadata['results_root']}")
  log(f"Restoring snapshot {metadata['key']} (T0 {metadata['t0']}, {', '.join(metadata['projects'])}) into a fresh demo stack", 'blue')
  start = time.time()
  stack.ensure_results_root()
  stack.down(volumes=True)
  stack.up('db')
  stack.wait_until(lambda: stack.compose('exec', '-T', 'db', 'pg_isready', '-U', 'qaboard', '-d', 'qaboard', check=False, capture=True).returncode == 0,
                   120, 'the database')
  # The commits' folders and .qaboard-demo/ are replaced, the rest of the results storage is left alone
  for project in metadata['projects'].values():
    for commit in project['commits'].values():
      shutil.rmtree(root / project['id'] / commit['sha'][:2] / commit['sha'][2:16], ignore_errors=True)
  shutil.rmtree(stack.demo_dir(), ignore_errors=True)
  for tar, member in members(archive):
    if member.name == 'db.sql':
      log("Restoring the database...", 'blue')
      process = subprocess.Popen(
        ['docker', 'compose', '-p', stack.PROJECT, '--project-directory', str(REPO), *sum((['-f', str(f)] for f in stack.COMPOSE_FILES), []),
         'exec', '-T', 'db', 'psql', '-q', '-v', 'ON_ERROR_STOP=1', '-U', 'qaboard', '-d', 'qaboard'],
        stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, env=stack.compose_env(),
      )
      shutil.copyfileobj(tar.extractfile(member), process.stdin)
      process.stdin.close()
      if process.wait() != 0:
        raise SystemExit("ERROR: could not restore the database")
    elif member.name.startswith('results/'):
      member.name = member.name[len('results/'):]
      if not member.name:
        continue
      tar.extract(member, root, filter=keep_modes)
  # tarfile sets directories' mtimes before their content is extracted in streaming mode: set them again
  fix_directory_mtimes(archive, root)
  log("Starting the stack...", 'blue')
  stack.up()
  verify(metadata)
  # The captures read the demo facts there: the app is now the restored stack's
  demo_path = stack.demo_dir() / 'demo.json'
  demo = json.loads(demo_path.read_text())
  demo.update({'app_version': stack.backend_version(), 'base_url': stack.server_url(), 'storage': str(root), 'snapshot': metadata['key']})
  demo_path.write_text(json.dumps(demo, indent=2, sort_keys=True) + '\n')
  log(f"  demo facts: {demo_path} (T0 {demo['t0']}, app {demo['app_version']})", 'green')
  log(f"Restored in {time.time() - start:.0f}s: {stack.server_url()}", 'green')


def keep_modes(member: tarfile.TarInfo, path: str) -> tarfile.TarInfo:
  """tarfile's `tar` filter (no absolute paths, no links out of the folder...), but `qa` makes results writable by all"""
  safe = tarfile.tar_filter(member, path)
  return safe.replace(mode=member.mode & 0o777, deep=False) if safe.mode is not None else safe


def fix_directory_mtimes(archive: Path, root: Path):
  for _, member in members(archive):
    if member.isdir() and member.name.startswith('results/') and member.name != 'results':
      path = root / member.name[len('results/'):]
      try:
        os.utime(path, (member.mtime, member.mtime))
      except OSError:
        pass


def api(path: str, **params):
  url = f"{stack.server_url()}{path}" + (f"?{urllib.parse.urlencode(params)}" if params else '')
  opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
  with opener.open(url, timeout=120) as r:
    return r.status, r.read()


def verify(metadata: Dict):
  """The restored data is served: projects, commits, batches, and an image through IIIF"""
  status, body = api('/api/v1/projects')
  projects = json.loads(body)
  for name, project in metadata['projects'].items():
    pid = project['id']
    if pid not in projects:
      raise SystemExit(f"ERROR: {pid} isn't in /api/v1/projects after the restore")
    commits = project['commits']
    last_id, last = max(commits.items(), key=lambda kv: kv[1]['at'])
    status, body = api(f"/api/v1/commit/{last['sha']}", project=pid)
    commit = json.loads(body)
    outputs = [o for b in commit['batches'].values() for o in b.get('outputs', {}).values()]
    image = next((o for c in sorted(commits.values(), key=lambda c: c['at']) for o in commit_outputs(pid, c['sha'])
                  if not o['is_failed'] and not o['is_pending']), None)
    checked = ''
    if image:
      manifest = json.loads(api(f"/api/v1/output/{image['id']}/manifest")[1])
      png = next((f for f in manifest if f.endswith('.png')), None)
      if png:
        identifier = f"{image['output_dir_url'][3:]}/{png}".replace('/', '%2F')
        status, body = api(f"/iiif/2/{identifier}/full/64,/0/default.png")
        if status != 200 or not body.startswith(b'\x89PNG'):
          raise SystemExit(f"ERROR: /iiif/2/ doesn't serve {png}")
        checked = f", {png} served by /iiif/2/"
    n = stack.psql(f"SELECT count(*) FROM ci_commits WHERE project_id = '{pid}'")
    log(f"  {pid}: {n} commits, {len(commit['batches'])} batches and {len(outputs)} runs on {last_id}{checked}", 'green')


def commit_outputs(pid: str, sha: str):
  status, body = api(f"/api/v1/commit/{sha}", project=pid)
  for batch in json.loads(body)['batches'].values():
    yield from batch.get('outputs', {}).values()


# ------------------------------------------------------------------------------------------------ CLI

def main():
  parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
  parser.add_argument('command', choices=['key', 'save', 'restore', 'list', 'info', 'delete'])
  parser.add_argument('key_arg', nargs='?', help="info, delete: the snapshot's key (info: default to this checkout's)")
  parser.add_argument('--key', help="save/restore: another key than this checkout's")
  parser.add_argument('--latest', action='store_true', help="restore: the most recent snapshot")
  parser.add_argument('--file', help="restore: from this archive instead of R2")
  parser.add_argument('--force', action='store_true', help="save: replace an existing snapshot")
  parser.add_argument('--no-upload', action='store_true', help="save: only create the archive in the cache")
  parser.add_argument('--only', nargs='+', help="save: only these projects (e.g. image-quality)")
  parser.add_argument('--level', type=int, default=10, help="save: zstd level (default: %(default)s)")
  parser.add_argument('--cache-dir', default=str(Path.home() / '.cache' / 'qaboard-demo' / 'snapshots'))
  args = parser.parse_args()

  if args.command == 'key':
    print(snapshot_key())
  elif args.command == 'save':
    save(args)
  elif args.command == 'restore':
    restore(args)
  elif args.command == 'list':
    client = r2()
    for page in client.get_paginator('list_objects_v2').paginate(Bucket=BUCKET, Prefix=PREFIX):
      for o in page.get('Contents', []):
        if o['Key'].endswith('.tar.zst'):
          print(f"{o['Key'][len(PREFIX):-8]}  {o['LastModified']:%Y-%m-%d %H:%M}  {human(o['Size'])}")
  elif args.command == 'info':
    # exits with 1 when there is no such snapshot (the docs-media workflow seeds then)
    key = args.key_arg or args.key or snapshot_key()
    client = r2()
    try:
      body = client.get_object(Bucket=BUCKET, Key=f"{PREFIX}{key}.json")['Body'].read()
    except client.exceptions.NoSuchKey:
      log(f"No snapshot {key} in {BUCKET}", 'yellow')
      sys.exit(1)
    print(body.decode())
  elif args.command == 'delete':
    if not args.key_arg:
      raise SystemExit("ERROR: give the key of the snapshot to delete")
    client = r2()
    for suffix in ('.tar.zst', '.json'):
      client.delete_object(Bucket=BUCKET, Key=f"{PREFIX}{args.key_arg}{suffix}")
    log(f"Deleted {PREFIX}{args.key_arg}", 'green')


if __name__ == '__main__':
  main()
