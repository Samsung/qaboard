#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["pyyaml>=6", "requests>=2.31", "jsonschema>=4.21", "psutil>=5.9"]
# ///
"""
Replays an example's history (examples/<project>/story.yaml, see examples/STORY.md) into the demo stack, with the
real `qa` CLI and fake CI environment variables, then checks the story's claims.

  uv run docs-media/seed.py --project image-quality            # starts the stack if needed (compose.demo.yml)
  uv run docs-media/seed.py --project image-quality --until merge-bilateral
  uv run docs-media/seed.py --project image-quality --resume    # after a fix, continue where it stopped
  uv run docs-media/seed.py --project image-quality --checks-only
  uv run docs-media/seed.py --story docs-media/tests/fixture/story.yaml   # the seeder's own test story
  uv run docs-media/seed.py up | down [--volumes]              # the demo stack only

How it works, per commit, in story order:
- The example is copied to a workspace (--workspace, default /tmp/kitefin/<repo>), with a venv that has the repository's
  qaboard and the example's dependencies; an example with compiled code builds it there once with its qa/build.py.
  Each commit writes its effective flags to build/flags.json, its patched
  YAML files, and points the workspace's git HEAD at the commit's sha (sha1("<project id>:<commit id>")).
- The commit is created with POST /api/v1/commit (branch, committer, date, message, parents, and the configuration
  the CLI would send), like CI tools that know the commit do. The `qa` calls that follow find it.
- Each run is a real `qa batch` (`qa save-artifacts` first, like CI). via ci: CI=true GITHUB_SHA GITHUB_REF;
  via local: `qa --share` as the user; via webapp/tuning/optimize: the environment QA-Board's backend gives the
  `qa batch` it starts (CI=true GIT_COMMIT QABOARD_TUNING...), and the batch records the submission like the backend.
- Failures: `bug` is checked; `oom`, `timeout` and `lsf-memlimit` are enforced by a watchdog that kills the run when
  it goes over its batch's `lsf: {max_memory: <MB>}` (default 2048) or `local: {timeout: <s>}` (default 60), like LSF
  does. `qa batch` enforces `local: {timeout}` too, and may kill the run first. `lsf-memlimit` then writes log.lsf.txt from a template, with the run's measured peak memory.
- Times: the backend stamps batches and outputs with now(). After each batch, `simulate_times()` moves them (SQL on
  the stack's database: batches.created_date, outputs.created_date, the commands' dates in batches.data, the commits'
  and project's latest_output_datetime) and the files' mtimes to the batch's simulated start, keeping real durations.
- A batch with `progress` runs its finished share, then starts the rest and kills `qa batch` once `running` runs
  started: the others stay pending, as at T0.
- Then milestones (as their owner, through the API), then the checks. A failing check exits with an error.

What was seeded (T0, shas...) goes to <results>/.qaboard-demo/demo.json, which snapshots include.
"""
import os
import re
import sys
import json
import time
import uuid
import fnmatch
import shutil
import signal
import hashlib
import argparse
import datetime
import importlib.util
import statistics
import subprocess
import threading
from copy import deepcopy
from pathlib import Path
from dataclasses import dataclass, field
from typing import Any, Dict, List, Optional, Tuple

import yaml
import psutil
import requests
import jsonschema

sys.path.insert(0, str(Path(__file__).resolve().parent / 'demo'))
import stack  # noqa: E402
from stack import log, REPO  # noqa: E402

UTC = datetime.timezone.utc
EXAMPLES = REPO / 'examples'
DEMO_PASSWORD = 'kitefin-demo'   # every persona's password in the demo stack
# Environment variables that tell `qa` it runs in a CI, or about a commit: never inherited from our own environment
SCRUBBED_ENV = re.compile(r'^(CI|CI_.*|GITHUB_.*|GITLAB_.*|GIT_.*|gitlab.*|CIRCLE.*|TRAVIS.*|BUILD_URL|JENKINS_.*|QA_.*|QABOARD_.*|RUNNER_.*)$')


# ------------------------------------------------------------------------------------------------ the demo world

def people() -> Dict[str, Dict[str, str]]:
  """Personas from examples/README.md's table: handle -> name, email, hours"""
  personas = {}
  for line in (EXAMPLES / 'README.md').read_text().splitlines():
    m = re.match(r'^\| `([a-z]+)` \| ([^|]+?) \| [^|]+ \| [^|]+ \| ([^|]+?) \|$', line)
    if m:
      handle, name, hours = m.groups()
      personas[handle] = {'name': name.strip(), 'email': f"{handle}@kitefin.example", 'hours': hours.strip()}
  if not personas:
    raise SystemExit("ERROR: could not read the people of the demo world in examples/README.md")
  return personas


def avatar_color(name: str) -> int:
  """avatarColor() in webapp/src/components/avatars.tsx: FNV-1a over the lowercased name's UTF-16 code units, 12 colors"""
  data = name.strip().lower().encode('utf-16-le')
  h = 0x811c9dc5
  for i in range(0, len(data), 2):
    h ^= int.from_bytes(data[i:i + 2], 'little')
    h = (h * 0x01000193) & 0xffffffff
  return h % 12


# ------------------------------------------------------------------------------------------------ time

def default_t0(now: Optional[datetime.datetime] = None) -> datetime.datetime:
  """The last Thursday at 16:00 UTC before now"""
  now = now or datetime.datetime.now(UTC)
  t0 = now.replace(hour=16, minute=0, second=0, microsecond=0) - datetime.timedelta(days=(now.weekday() - 3) % 7)
  return t0 if t0 < now else t0 - datetime.timedelta(days=7)


def parse_t0(value: str) -> datetime.datetime:
  t0 = datetime.datetime.fromisoformat(value.replace('Z', '+00:00'))
  if t0.tzinfo is None:
    t0 = t0.replace(tzinfo=UTC)
  t0 = t0.astimezone(UTC)
  if t0.weekday() != 3 or (t0.hour, t0.minute, t0.second) != (16, 0, 0):
    log(f"WARNING: T0 should be a Thursday at 16:00 UTC, not {t0:%A %H:%M}", 'yellow')
  return t0


def parse_duration(value: str) -> datetime.timedelta:
  m = re.fullmatch(r'(?:(\d+)h)?(?:(\d+)m)?', value)
  if not m or not value:
    raise ValueError(f"Invalid duration: {value}")
  return datetime.timedelta(hours=int(m.group(1) or 0), minutes=int(m.group(2) or 0))


def parse_offset(value: str, t0: datetime.datetime) -> datetime.datetime:
  m = re.fullmatch(r'-(\d+)d (\d\d):(\d\d)', value)
  if m:
    days, hours, minutes = map(int, m.groups())
    return (t0 - datetime.timedelta(days=days)).replace(hour=hours, minute=minutes, second=0, microsecond=0)
  return t0 - parse_duration(value[1:])


def iso(t: datetime.datetime) -> str:
  return t.astimezone(UTC).isoformat()


# ------------------------------------------------------------------------------------------------ JSON merge patch

MISSING = object()

def merge_patch(target: Any, patch: Any) -> Any:
  """RFC 7386"""
  if not isinstance(patch, dict):
    return deepcopy(patch)
  result = deepcopy(target) if isinstance(target, dict) else {}
  for key, value in patch.items():
    if value is None:
      result.pop(key, None)
    else:
      result[key] = merge_patch(result.get(key), value)
  return result


def merge_heads(base: dict, ours: dict, theirs: dict, own_patch: dict, what: str) -> dict:
  """
  A merge commit: for each top-level key, the merged branch's value if it changed since the merge base, else the
  first parent's. Keys both sides changed differently are an error, unless the merge commit's own patch sets them.
  """
  result = {}
  for key in sorted(set(base) | set(ours) | set(theirs)):
    b, o, t = base.get(key, MISSING), ours.get(key, MISSING), theirs.get(key, MISSING)
    theirs_changed, ours_changed = t != b, o != b
    if theirs_changed and ours_changed and t != o and key not in own_patch:
      raise SystemExit(f"ERROR: {what}: both branches changed `{key}` differently ({o} vs {t}). Set it in the merge commit.")
    value = t if theirs_changed else o
    if value is not MISSING:
      result[key] = deepcopy(value)
  return merge_patch(result, own_patch)


# ------------------------------------------------------------------------------------------------ the story

@dataclass
class Run:
  index: int
  batch: str
  via: str
  label: str
  platform: str
  user: str
  after: datetime.timedelta
  tuning: Optional[dict] = None
  sample: Optional[int] = None
  optimize: Optional[str] = None
  progress: Optional[dict] = None
  start: Optional[datetime.datetime] = None   # simulated

  @property
  def db_label(self) -> str:
    """The batch label QA-Board records: `qa --share` from a terminal prefixes it with the user"""
    return f"@{self.user}| {self.label}" if self.via == 'local' else self.label


@dataclass
class Commit:
  id: str
  branch: str
  parents: List[str]
  at: datetime.datetime
  author: str
  message: str
  flags_patch: dict
  patches: dict
  runs: List[Run]
  failures: List[dict]
  sha: str = ''
  flags: dict = field(default_factory=dict)        # effective flags
  files: Dict[str, Any] = field(default_factory=dict)  # effective content of the patched YAML files


class Story:
  def __init__(self, path: Path, t0: datetime.datetime):
    self.path = path.resolve()
    self.example = self.path.parent
    self.text = self.path.read_text()
    self.data = yaml.safe_load(self.text)
    self.t0 = t0
    self.validate_schema()
    self.project = self.data['project']
    self.id = self.data['id']
    self.seed = self.data['seed']
    self.people = people()
    self.base_files = {}
    for rel in ('qaboard.yaml', 'qa/metrics.yaml', 'qa/batches.yaml'):
      p = self.example / rel
      self.base_files[rel] = yaml.safe_load(p.read_text()) if p.exists() else {}
    self.commits: Dict[str, Commit] = {}
    self.order: List[str] = []
    self.build_commits()
    self.milestones = self.data.get('milestones', [])
    self.checks = self.data.get('checks', [])
    self.validate_semantics()

  @property
  def is_fixture(self) -> bool:
    return not self.example.is_relative_to(EXAMPLES)

  @property
  def repo_name(self) -> str:
    return self.id.split('/')[-1]

  @property
  def sha256(self) -> str:
    return hashlib.sha256(self.text.encode()).hexdigest()

  def validate_schema(self):
    schema = json.loads((EXAMPLES / 'story.schema.json').read_text())
    if not self.example.is_relative_to(EXAMPLES):
      # Test stories (docs-media/tests/) have their own project
      schema['properties']['project'] = {'type': 'string'}
      schema['properties']['id'] = {'type': 'string'}
    errors = sorted(jsonschema.Draft202012Validator(schema).iter_errors(self.data), key=lambda e: list(e.path))
    if errors:
      for e in errors:
        log(f"ERROR: {self.path.name}: /{'/'.join(map(str, e.path))}: {e.message}", 'red')
      raise SystemExit(1)

  def sha_of(self, commit_id: str) -> str:
    return hashlib.sha1(f"{self.id}:{commit_id}".encode()).hexdigest()

  def build_commits(self):
    defaults = self.data.get('defaults', {})
    default_runs = defaults.get('runs') or [{'batch': 'ci'}]
    last_on_branch: Dict[str, str] = {}
    for c in self.data['commits']:
      if c['id'] in self.commits:
        raise SystemExit(f"ERROR: duplicate commit id {c['id']}")
      parents = c.get('parents')
      if parents is None:
        if c['branch'] in last_on_branch:
          parents = [last_on_branch[c['branch']]]
        elif self.commits:
          raise SystemExit(f"ERROR: {c['id']} is the first commit on {c['branch']}: give its `parents`")
        else:
          parents = []
      for p in parents:
        if p not in self.commits:
          raise SystemExit(f"ERROR: {c['id']}: its parent {p} must be listed before it")
      commit = Commit(
        id=c['id'], branch=c['branch'], parents=parents, at=parse_offset(c['at'], self.t0), author=c['author'],
        message=c['message'].strip(), flags_patch=c.get('flags', {}), patches=c.get('patches', {}),
        runs=[], failures=c.get('failures', []),
      )
      commit.sha = self.sha_of(commit.id)
      for i, r in enumerate(c['runs'] if 'runs' in c else default_runs):
        via = r.get('via', 'ci')
        run = Run(
          index=i, batch=r['batch'], via=via, label=r.get('label', 'default'), platform=r.get('platform', 'linux'),
          user=r.get('user', 'ci' if via == 'ci' else commit.author),
          after=parse_duration(r.get('after', '6m' if via == 'ci' else '1h')),
          tuning=r.get('tuning'), sample=r.get('sample'), optimize=r.get('optimize'), progress=r.get('progress'),
        )
        run.start = commit.at + run.after
        commit.runs.append(run)
      self.compute_effective(commit, defaults.get('flags', {}))
      self.commits[commit.id] = commit
      self.order.append(commit.id)
      last_on_branch[commit.branch] = commit.id

  def ancestors(self, commit_id: str) -> set:
    seen, todo = set(), [commit_id]
    while todo:
      c = todo.pop()
      if c not in seen:
        seen.add(c)
        todo.extend(self.commits[c].parents)
    return seen

  def merge_base(self, a: str, b: str) -> Optional[str]:
    common = self.ancestors(a) & self.ancestors(b)
    # the newest common ancestor
    return max(common, key=self.order.index) if common else None

  def compute_effective(self, commit: Commit, default_flags: dict):
    files_patches = commit.patches
    if not commit.parents:
      commit.flags = merge_patch(merge_patch({}, default_flags), commit.flags_patch)
      commit.files = {rel: merge_patch(doc, files_patches.get(rel, {})) for rel, doc in self.base_files.items()}
    elif len(commit.parents) == 1:
      parent = self.commits[commit.parents[0]]
      commit.flags = merge_patch(parent.flags, commit.flags_patch)
      commit.files = {rel: merge_patch(doc, files_patches.get(rel, {})) for rel, doc in parent.files.items()}
    else:
      ours, theirs = (self.commits[p] for p in commit.parents)
      base_id = self.merge_base(ours.id, theirs.id)
      base = self.commits[base_id] if base_id else None
      commit.flags = merge_heads(base.flags if base else {}, ours.flags, theirs.flags, commit.flags_patch, f"{commit.id}: flags")
      commit.files = {
        rel: merge_heads(base.files[rel] if base else {}, ours.files[rel], theirs.files[rel], files_patches.get(rel, {}), f"{commit.id}: {rel}")
        for rel in self.base_files
      }
    for milestone in self.data.get('milestones', []):
      if milestone.get('kind') == 'config' and (milestone['commit'] == commit.id or milestone['commit'] in self.ancestors_of_parents(commit)):
        project = commit.files['qaboard.yaml'].setdefault('project', {})
        milestones = project.setdefault('milestones', [])
        if milestone['branch'] not in milestones:
          milestones.append(milestone['branch'])

  def ancestors_of_parents(self, commit: Commit) -> set:
    result = set()
    for p in commit.parents:
      result |= self.ancestors(p)
    return result

  def batches(self, commit: Commit) -> dict:
    return commit.files.get('qa/batches.yaml') or {}

  def validate_semantics(self):
    warnings = []
    for commit_id in self.order:
      c = self.commits[commit_id]
      if c.author not in self.people:
        raise SystemExit(f"ERROR: {c.id}: unknown author {c.author}")
      for p in c.parents:
        if self.commits[p].at >= c.at:
          raise SystemExit(f"ERROR: {c.id} ({c.at:%Y-%m-%d %H:%M}) must be after its parent {p} ({self.commits[p].at:%Y-%m-%d %H:%M})")
      if c.at >= self.t0:
        raise SystemExit(f"ERROR: {c.id} is after T0")
      if c.at.weekday() >= 5:
        warnings.append(f"{c.id} is on a {c.at:%A}")
      hours = self.people[c.author]['hours']
      m = re.match(r'(\d\d):(\d\d)-(\d\d):(\d\d)', hours)
      if m:
        start, end = int(m[1]) * 60 + int(m[2]), int(m[3]) * 60 + int(m[4])
        minute = c.at.hour * 60 + c.at.minute
        if not start <= minute <= end:
          warnings.append(f"{c.id} at {c.at:%H:%M} UTC is outside {c.author}'s hours ({hours})")
      batches = self.batches(c)
      for run in c.runs:
        if batches and run.batch not in batches and run.batch not in (batches.get('aliases') or batches.get('groups') or {}):
          raise SystemExit(f"ERROR: {c.id}: no batch named {run.batch} in qa/batches.yaml")
        if run.start >= self.t0:
          raise SystemExit(f"ERROR: {c.id}: the {run.batch} batch starts after T0")
        if not run.progress and run.start > self.t0 - datetime.timedelta(minutes=15):
          warnings.append(f"{c.id}: the {run.batch} batch starts at {run.start:%H:%M}, its results must be done 10 minutes before T0")
        if run.user != 'ci' and run.user not in self.people:
          raise SystemExit(f"ERROR: {c.id}: unknown user {run.user}")
      labels = [(r.db_label, r.platform, r.batch, str(r.tuning), r.optimize) for r in c.runs]
      if len(labels) != len(set(labels)):
        warnings.append(f"{c.id}: the same batch runs twice with the same label")
      for f in c.failures:
        if not any(self.failure_matches_run(f, r) for r in c.runs):
          raise SystemExit(f"ERROR: {c.id}: the failure {f} matches none of its runs")
    for m in self.data.get('milestones', []):
      if m['commit'] not in self.commits:
        raise SystemExit(f"ERROR: milestone {m['label']}: unknown commit {m['commit']}")
    for check in self.data.get('checks', []):
      for key in ('commit', 'vs'):
        ref = check.get(key)
        if ref and ref != 'parent' and not ref.startswith('milestone:') and ref not in self.commits:
          raise SystemExit(f"ERROR: check '{check['name']}': unknown commit {ref}")
    # people who share a project must get different avatar colors in the web app
    names = {self.people[c.author]['name'] for c in self.commits.values()}
    colors: Dict[int, List[str]] = {}
    for name in names:
      colors.setdefault(avatar_color(name), []).append(name)
    for same in colors.values():
      if len(same) > 1:
        raise SystemExit(f"ERROR: {' and '.join(sorted(same))} would get the same avatar color: change a display name in examples/README.md")
    for w in warnings:
      log(f"WARNING: {w}", 'yellow')

  @staticmethod
  def failure_matches_run(failure: dict, run: Run) -> bool:
    return (
      failure['batch'] == run.batch
      and failure.get('label', 'default') == run.label
      and failure.get('platform', run.platform) == run.platform
    )


def glob_matches(pattern: Optional[str], path: str) -> bool:
  """inputs globs match like .gitignore patterns: without a /, against the file name"""
  if not pattern:
    return True
  path = path.lstrip('/')
  if '/' not in pattern.strip('/'):
    return fnmatch.fnmatch(Path(path).name, pattern) or fnmatch.fnmatch(path, pattern)
  return fnmatch.fnmatch(path, pattern.lstrip('/'))


# ------------------------------------------------------------------------------------------------ the server

class Server:
  def __init__(self, url: str):
    self.url = url.rstrip('/')
    self.http = requests.Session()
    self.http.trust_env = False   # never through a proxy
    self.sessions: Dict[str, requests.Session] = {}

  def get(self, path: str, **params):
    r = self.http.get(f"{self.url}{path}", params=params, timeout=120)
    r.raise_for_status()
    return r.json()

  def post(self, path: str, data: dict, session: Optional[requests.Session] = None):
    r = (session or self.http).post(f"{self.url}{path}", json=data, timeout=120)
    if r.status_code >= 400:
      raise RuntimeError(f"POST {path}: {r.status_code} {r.text[:500]}")
    return r

  def ensure_user(self, handle: str, person: dict):
    r = self.http.post(f"{self.url}/api/v1/user/signup/", data={
      'user_name': handle, 'password': DEMO_PASSWORD, 'full_name': person['name'], 'email': person['email'],
    }, timeout=60)
    if r.status_code not in (200, 409):
      raise RuntimeError(f"Could not create the user {handle}: {r.status_code} {r.text[:300]}")

  def login(self, handle: str) -> requests.Session:
    if handle not in self.sessions:
      s = requests.Session()
      s.trust_env = False
      r = s.post(f"{self.url}/api/v1/user/auth/", data={'username': handle, 'password': DEMO_PASSWORD}, timeout=60)
      if r.status_code != 200:
        raise RuntimeError(f"Could not log in as {handle}: {r.status_code} {r.text[:300]}")
      self.sessions[handle] = s
    return self.sessions[handle]

  def batch(self, project_id: str, sha: str, label: str) -> Optional[dict]:
    r = self.http.get(f"{self.url}/api/v1/commit/{sha}", params={'project': project_id, 'batch': label}, timeout=300)
    if r.status_code == 404:
      return None
    r.raise_for_status()
    return r.json().get('batches', {}).get(label)


def sql_str(value: str) -> str:
  return "'" + str(value).replace("'", "''") + "'"


def sql_json(value: Any) -> str:
  text = json.dumps(value)
  tag = '$j$'
  assert tag not in text
  return f"{tag}{text}{tag}::jsonb"


def db_now() -> datetime.datetime:
  """The database's clock (naive UTC, like the backend's utcnow() defaults)"""
  return datetime.datetime.fromisoformat(stack.psql("SELECT to_char(now() at time zone 'utc', 'YYYY-MM-DD\"T\"HH24:MI:SS.US')"))


# ------------------------------------------------------------------------------------------------ the workspace

class Workspace:
  """A copy of the example, where `qa` runs. It keeps its inputs, venv and build outputs between seeds."""
  IGNORE = staticmethod(shutil.ignore_patterns('.venv', 'build', 'target', '__pycache__', 'output', '*.pyc', '.git', '.seed-state.json'))

  def __init__(self, story: Story, root: Path, server: str, jobs: int, verbose: bool):
    self.story = story
    self.dir = root / story.repo_name
    self.server = server
    self.jobs = jobs
    self.verbose = verbose
    self.venv = self.dir / '.venv'
    self.current: Optional[Commit] = None
    self.job_counter = 0

  def prepare(self):
    self.dir.mkdir(parents=True, exist_ok=True)
    shutil.copytree(self.story.example, self.dir, ignore=self.IGNORE, dirs_exist_ok=True, copy_function=copy_if_changed)
    if not (self.dir / '.git').exists():
      subprocess.run(['git', 'init', '-q', '-b', 'main', str(self.dir)], check=True)
    self.ensure_venv()
    # Examples with compiled code build it once, like a CI job's build step, before any run (and its log) starts
    if (self.dir / 'qa' / 'build.py').exists():
      log(f"Building {self.story.project} (qa/build.py)", 'blue')
      subprocess.run([str(self.venv / 'bin' / 'python'), 'qa/build.py'], cwd=self.dir, check=True)

  def dependencies(self) -> List[str]:
    requirements = self.story.example / 'requirements.txt'
    pyproject = self.story.example / 'pyproject.toml'
    if pyproject.exists():
      import tomllib
      return tomllib.loads(pyproject.read_text()).get('project', {}).get('dependencies', [])
    if requirements.exists():
      return ['-r', str(requirements)]   # uv understands its comments, options...
    return []

  def ensure_venv(self):
    deps = self.dependencies()
    stamp = self.venv / '.seed-stamp'
    requirements = self.story.example / 'requirements.txt'
    wanted = json.dumps({
      'deps': deps,
      'requirements': hashlib.sha256(requirements.read_bytes()).hexdigest() if requirements.exists() else None,
      'qaboard': hashlib.sha256((REPO / 'pyproject.toml').read_bytes()).hexdigest(),
    })
    if stamp.exists() and stamp.read_text() == wanted:
      return
    log(f"Installing qaboard (from {REPO}) and the example's dependencies ({' '.join(deps) or 'none'}) in {self.venv}", 'blue')
    subprocess.run(['uv', 'venv', '-q', '--allow-existing', '--python', '3.12', str(self.venv)], check=True)
    subprocess.run(['uv', 'pip', 'install', '-q', '--python', str(self.venv / 'bin' / 'python'), '-e', str(REPO), *deps], check=True)
    stamp.write_text(wanted)

  def checkout(self, commit: Commit):
    """The workspace as of this commit: flags, patched YAML files, git HEAD"""
    self.current = commit
    for rel, doc in commit.files.items():
      original = self.story.example / rel
      if rel == 'qaboard.yaml':
        # results go to the demo stack's storage
        storage = str(stack.results_root())
        if doc.get('storage') not in (storage, {'linux': storage}):
          doc = {**doc, 'storage': {'linux': storage}}
      if original.exists() and doc == self.story.base_files[rel]:
        shutil.copy2(original, self.dir / rel)   # with its comments
      elif doc or original.exists():
        (self.dir / rel).parent.mkdir(parents=True, exist_ok=True)
        (self.dir / rel).write_text(yaml.safe_dump(doc, sort_keys=False, allow_unicode=True))
    build = self.dir / 'build'
    build.mkdir(exist_ok=True)
    (build / 'flags.json').write_text(json.dumps(commit.flags, indent=2, sort_keys=True) + '\n')
    git = self.dir / '.git'
    (git / 'HEAD').write_text(f"ref: refs/heads/{commit.branch}\n")
    ref = git / 'refs' / 'heads' / commit.branch
    ref.parent.mkdir(parents=True, exist_ok=True)
    ref.write_text(commit.sha + '\n')

  def env(self, commit: Commit, via: str, user: str, run: Optional[Run] = None) -> Dict[str, str]:
    env = {k: v for k, v in os.environ.items() if not SCRUBBED_ENV.match(k)}
    no_proxy = ','.join(filter(None, [os.environ.get('NO_PROXY', ''), 'localhost', '127.0.0.1']))
    env.update({
      'PATH': f"{self.venv / 'bin'}:{env.get('PATH', '')}",
      'VIRTUAL_ENV': str(self.venv),
      'QABOARD_URL': self.server,
      'NO_PROXY': no_proxy, 'no_proxy': no_proxy,
      'QA_USER': user,
      'QA_SEED': str(self.story.seed),
      'QA_BATCH_RUNNER': 'local',
      'TZ': 'UTC',
      'LC_ALL': 'C.UTF-8', 'LANG': 'C.UTF-8',
      'PYTHONUNBUFFERED': '1',
      'MPLBACKEND': 'agg',
      'QA_NO_CHECK_FOR_UPDATES': '1',   # no "a new version is available" in the logs
    })
    local_config = (commit.files['qaboard.yaml'].get('runners') or {}).get('local') or {}
    if 'concurrency' not in local_config:
      env['QA_BATCH_CONCURRENCY'] = str(self.jobs)
    if via == 'ci':
      self.job_counter += 1
      env.update({
        'CI': 'true',
        'GITHUB_SHA': commit.sha,
        'GITHUB_REF': f"refs/heads/{commit.branch}",
        # links to the CI job: the only thing CI would add
        'CI_JOB_URL': f"https://ci.kitefin.example/{self.story.id}/-/jobs/{int(commit.sha[:6], 16) % 90000 + 10000 + self.job_counter}",
      })
    elif via in ('webapp', 'tuning', 'optimize'):
      # what QA-Board's backend gives the `qa batch` it starts (backend/api/tuning.py)
      env.update({
        'CI': 'true',
        'GIT_COMMIT': commit.sha,
        'QABOARD_TUNING': 'true',
        'QA_OUTPUTS_COMMIT': str(self.outputs_commit(commit)),
      })
    return env

  def outputs_commit(self, commit: Commit) -> Path:
    return stack.results_root() / self.story.id / commit.sha[:2] / commit.sha[2:16]

  def qa(self, args: List[str], env: Dict[str, str], *, watchdog: Optional['Watchdog'] = None, tee: Optional[Path] = None,
         check=False, quiet=False, kill_when=None, stdout_only=False) -> Tuple[int, str]:
    """Runs `qa` in the workspace, prints and returns its output (with stdout_only, stderr isn't returned)"""
    command = [str(self.venv / 'bin' / 'qa'), *args]
    if self.verbose:
      log(f"  $ qa {' '.join(args)}", 'dim')
    process = subprocess.Popen(command, cwd=self.dir, env=env, stdout=subprocess.PIPE,
                               stderr=subprocess.DEVNULL if stdout_only else subprocess.STDOUT,
                               text=True, errors='replace', start_new_session=True)
    if watchdog:
      watchdog.start(process.pid)
    killer = None
    if kill_when:
      killer = threading.Thread(target=kill_when, args=(process,), daemon=True)
      killer.start()
    lines = []
    tee_file = tee.open('a') if tee else None
    assert process.stdout
    for line in process.stdout:
      lines.append(line)
      if tee_file:
        tee_file.write(line)
      if self.verbose and not quiet:
        sys.stderr.write(f"    {line}")
    process.wait()
    if tee_file:
      tee_file.close()
    if watchdog:
      watchdog.stop()
    output = ''.join(lines)
    if check and process.returncode != 0:
      raise SeedError(f"`qa {' '.join(args)}` failed ({process.returncode}):\n{tail(output)}")
    return process.returncode, output

  def cli_config(self, commit: Commit) -> dict:
    """What `qa` sends the server about the project's configuration, from the CLI's own code"""
    code = (
      "import json; from copy import deepcopy; from qaboard.config import config, _metrics;"
      "from qaboard.api import serialize_paths;"
      "print(json.dumps({'qaboard_config': serialize_paths(deepcopy(config)), 'qaboard_metrics': _metrics}))"
    )
    r = subprocess.run([str(self.venv / 'bin' / 'python'), '-c', code], cwd=self.dir, env=self.env(commit, 'local', commit.author),
                       capture_output=True, text=True)
    if r.returncode != 0:
      raise SeedError(f"Could not read the project's configuration:\n{r.stderr}")
    return json.loads(r.stdout.strip().splitlines()[-1])


class SeedError(Exception):
  pass


def without_batch_name(args: List[str], extra: List[str], batch: str) -> List[str]:
  """`qa [options] batch <name> [extra]` without the batch's name, for `qa batch --runs-file`. Only that argument goes:
  the label can be the same string (`qa --label nightly batch nightly`)."""
  i = len(args) - len(extra) - 1
  if i < 1 or args[i] != batch or args[i - 1] != 'batch':
    raise SeedError(f"can't find the batch's name {batch!r} in: qa {' '.join(args)}")
  return args[:i] + args[i + 1:]


def tail(text: str, n=40) -> str:
  return '\n'.join(text.rstrip().splitlines()[-n:])


def failed_gate_check(check: dict) -> str:
  """A failed check of `qa gate --json`, for the checks' log: a metric's rule, or a rule without a metric
  (max_failed_runs, require_bit_accuracy), named by its kind"""
  name = check.get('metric') or check.get('kind')
  if check.get('message'):
    return f"{name}: {check['message']}"
  if check.get('new') is not None and check.get('limit') is not None:
    return f"{name}: {check['new']} (limit {check['limit']})"
  return f"{name}: {check.get('status')}"


# ------------------------------------------------------------------------------------------------ failures

@dataclass
class Limit:
  kind: str             # oom | timeout | lsf-memlimit
  inputs: Optional[str]
  memory_mb: float
  timeout_s: float


class Watchdog:
  """
  Kills the runs (`qa run` processes) that go over their memory or time limit, like LSF or the kernel would.
  Memory is the resident memory of the run's processes, checked every 100 ms.
  """
  def __init__(self, limits: List[Limit]):
    self.limits = limits
    self.runs: Dict[int, dict] = {}   # pid -> {input, peak_mb, started, killed, limit}
    self._stop = threading.Event()
    self._thread: Optional[threading.Thread] = None

  def start(self, root_pid: int):
    self.root = psutil.Process(root_pid)
    self._thread = threading.Thread(target=self.loop, daemon=True)
    self._thread.start()

  def stop(self):
    self._stop.set()
    if self._thread:
      self._thread.join()

  @staticmethod
  def run_input(cmdline: List[str]) -> Optional[str]:
    """The input of a `qa ... run --input X` process"""
    if len(cmdline) < 2 or not cmdline[1].endswith('/qa') or 'run' not in cmdline or '--input' not in cmdline:
      return None
    return cmdline[cmdline.index('--input') + 1].strip('"')

  def loop(self):
    while not self._stop.is_set():
      try:
        children = self.root.children(recursive=True)
      except psutil.Error:
        break
      for p in children:
        try:
          info = self.runs.get(p.pid)
          if info is None:
            run_input = self.run_input(p.cmdline())
            if run_input is None:
              continue
            limit = next((l for l in self.limits if glob_matches(l.inputs, run_input)), None)
            if limit is None:
              continue
            info = self.runs[p.pid] = {'input': run_input, 'peak_mb': 0.0, 'started': time.time(), 'killed': None,
                                       'limit': limit, 'process': p, 'cpu_s': 0.0, 'processes': 1, 'threads': 1}
          if info['killed']:
            continue
          tree = [p, *p.children(recursive=True)]
          rss = 0
          cpu = 0.0
          threads = 0
          for q in tree:
            try:
              rss += q.memory_info().rss
              t = q.cpu_times()
              cpu += t.user + t.system
              threads += q.num_threads()
            except psutil.Error:
              pass
          info['peak_mb'] = max(info['peak_mb'], rss / 2**20)
          info['cpu_s'] = max(info['cpu_s'], cpu)
          info['processes'] = max(info['processes'], len(tree))
          info['threads'] = max(info['threads'], threads)
          limit = info['limit']
          over_memory = limit.kind in ('oom', 'lsf-memlimit') and rss / 2**20 > limit.memory_mb
          over_time = limit.kind == 'timeout' and time.time() - info['started'] > limit.timeout_s
          if over_memory or over_time:
            info['killed'] = time.time()
            for q in reversed(tree):
              try:
                q.send_signal(signal.SIGKILL)
              except psutil.Error:
                pass
        except psutil.Error:
          continue
      time.sleep(0.1)


LSF_REPORT = """
------------------------------------------------------------
Sender: LSF System <lsfadmin@{host}>
Subject: Job {job_id}: <{job_name}> in cluster <kitefin> Exited

Job <{job_name}> was submitted from host <{submission_host}> by user <{user}> in cluster <kitefin> at {submitted}
Job was executed on host(s) <{host}>, in queue <normal>, as user <{user}> in cluster <kitefin> at {started}
</home/{user}> was used as the home directory.
<{cwd}> was used as the working directory.
Started at {started}
Terminated at {terminated}
Results reported at {terminated}

Your job looked like:

------------------------------------------------------------
# LSBATCH: User input
  LC_ALL=en_US.utf8 LANG=en_US.utf8 MPLBACKEND=agg {command}
------------------------------------------------------------

TERM_MEMLIMIT: job killed after reaching LSF memory usage limit.
Exited with exit code 137.

Resource usage summary:

    CPU time :                                   {cpu:.2f} sec.
    Max Memory :                                 {max_memory} MB
    Average Memory :                             {average_memory:.2f} MB
    Total Requested Memory :                     {requested:.2f} MB
    Delta Memory :                               {delta:.2f} MB
    Max Swap :                                   -
    Max Processes :                              {processes}
    Max Threads :                                {threads}
    Run time :                                   {run_time} sec.
    Turnaround time :                            {turnaround} sec.

The output (if any) is above this job summary.
"""


def lsf_date(t: datetime.datetime) -> str:
  return t.strftime('%a %b ') + f"{t.day:2d}" + t.strftime(' %H:%M:%S %Y')


# ------------------------------------------------------------------------------------------------ seeding

class Seeder:
  def __init__(self, story: Story, args):
    self.story = story
    self.args = args
    self.server = Server(args.server)
    self.ws = Workspace(story, Path(args.workspace), args.server, args.jobs, args.verbose)
    self.state_path = self.ws.dir / '.seed-state.json'
    self.state = {'t0': iso(story.t0), 'story_sha256': story.sha256, 'done': []}
    self.timings: Dict[str, float] = {}

  # -- state, for --resume
  def load_state(self):
    if not self.state_path.exists():
      raise SystemExit(f"ERROR: nothing to resume ({self.state_path} doesn't exist)")
    state = json.loads(self.state_path.read_text())
    if state['t0'] != iso(self.story.t0):
      raise SystemExit(f"ERROR: the seed to resume used T0={state['t0']}: use --t0 {state['t0']}")
    self.state = {**state, 'story_sha256': self.story.sha256}

  def save_state(self):
    self.state_path.write_text(json.dumps(self.state, indent=2))

  def done(self, step: str) -> bool:
    return step in self.state['done']

  def mark(self, step: str):
    self.state['done'].append(step)
    self.save_state()

  # -- setup
  def wipe(self):
    """Removes the project from the database, and the story's commits from the results storage"""
    pid = sql_str(self.story.id)
    stack.psql(f"""
      DELETE FROM outputs WHERE batch_id IN (SELECT b.id FROM batches b JOIN ci_commits c ON b.ci_commit_id = c.id WHERE c.project_id = {pid});
      DELETE FROM batches WHERE ci_commit_id IN (SELECT id FROM ci_commits WHERE project_id = {pid});
      DELETE FROM ci_commits WHERE project_id = {pid};
      DELETE FROM milestones WHERE project_id = {pid};
      DELETE FROM projects WHERE id = {pid};
    """)
    for commit in self.story.commits.values():
      remove_results(self.ws.outputs_commit(commit))

  def ensure_users(self):
    for handle, person in self.story.people.items():
      self.server.ensure_user(handle, person)

  # -- commits
  def create_commit(self, commit: Commit):
    person = self.story.people[commit.author]
    config = self.ws.cli_config(commit)
    self.server.post('/api/v1/commit/', {
      'project': self.story.id,
      'project_root': self.story.id,
      'commit_sha': commit.sha,
      'commit_branch': commit.branch,
      'commit_committer_name': person['name'],
      'commit_committer_email': person['email'],
      'commit_authored_datetime': iso(commit.at),
      'commit_parents': [self.story.commits[p].sha for p in commit.parents],
      'commit_message': commit.message,
      **config,
    })
    # latest_output_datetime defaults to the commit's date
    stack.psql(f"UPDATE ci_commits SET latest_output_datetime = {sql_str(iso(commit.at))} WHERE hexsha = {sql_str(commit.sha)} AND project_id = {sql_str(self.story.id)};")

  def list_runs(self, commit: Commit, run: Run, env: Dict[str, str], extra: List[str]) -> List[dict]:
    """The runs `qa batch` will do (qa batch --list)"""
    code, output = self.ws.qa(self.batch_args(run, extra) + ['--list'], env, quiet=True, stdout_only=True)
    if code != 0:
      _, errors = self.ws.qa(self.batch_args(run, extra) + ['--list'], env, quiet=True)
      raise SeedError(f"`qa batch {run.batch} --list` failed:\n{tail(errors)}")
    try:
      runs = json.loads(output[output.index('\n[') + 1:] if not output.startswith('[') else output)
    except ValueError:
      raise SeedError(f"Could not parse `qa batch --list`:\n{tail(output)}")
    return runs

  def batch_args(self, run: Run, extra: List[str]) -> List[str]:
    args = []
    if run.via == 'local':
      args.append('--share')
    if run.platform != 'linux':
      args += ['--platform', run.platform]
    if run.label != 'default':
      args += ['--label', run.label]
    if run.via == 'optimize':
      return args + ['optimize', '--batch', run.batch, *extra]
    return args + ['batch', run.batch, *extra]

  def tuning_search(self, commit: Commit, run: Run) -> Optional[str]:
    if run.via != 'tuning':
      return None
    if not run.sample:
      return json.dumps({'search_type': 'grid', 'parameter_search': run.tuning}, sort_keys=True)
    # A deterministic sample of the grid: QA-Board's "sampler" isn't seeded
    import itertools
    import random
    keys = sorted(run.tuning)
    grid = [dict(zip(keys, values)) for values in itertools.product(*(run.tuning[k] for k in keys))]
    rng = random.Random(f"{self.story.seed}:{commit.id}:{run.label}")
    chosen = rng.sample(grid, min(run.sample, len(grid)))
    return json.dumps({'search_type': 'grid', 'parameter_search': [{k: [v] for k, v in c.items()} for c in chosen]}, sort_keys=True)

  def limits(self, commit: Commit, run: Run) -> List[Limit]:
    batch = self.story.batches(commit).get(run.batch) or {}
    lsf, local = batch.get('lsf') or {}, batch.get('local') or {}
    limits = []
    for f in commit.failures:
      if f['kind'] in ('oom', 'timeout', 'lsf-memlimit') and Story.failure_matches_run(f, run):
        limits.append(Limit(
          kind=f['kind'], inputs=f.get('inputs'),
          memory_mb=float(lsf.get('max_memory') or local.get('max_memory') or 2048),
          timeout_s=float(local.get('timeout') or batch.get('timeout') or 60),
        ))
    return limits

  def run_batch(self, commit: Commit, run: Run):
    real_start = db_now()
    t = time.time()
    env = self.ws.env(commit, run.via, run.user, run)
    extra: List[str] = []
    search = self.tuning_search(commit, run)
    if search:
      extra += ['--tuning-search', search]
    batch_dir = self.batch_dir(commit, run)
    if run.via == 'optimize':
      # qa optimize resumes from its saved search: the story starts over each time
      checkpoint = batch_dir / 'optuna-journal.log'
      extra += ['--config-file', str(self.ws.dir / run.optimize), '--checkpoint', str(checkpoint)]
      if checkpoint.exists():
        checkpoint.unlink()
    started_from_app = run.via in ('webapp', 'tuning', 'optimize')
    command_id = str(uuid.uuid4())
    if started_from_app:
      env['QA_BATCH_COMMAND_ID'] = command_id
      extra += ['--action-on-existing', 'run']
    expected = self.list_runs(commit, run, env, extra) if run.via != 'optimize' else []
    limits = self.limits(commit, run)
    what = f"{commit.id}: {' '.join(self.batch_args(run, []))} ({run.via}{', ' + run.user if run.user != 'ci' else ''}, {len(expected) or '?'} runs)"
    log(f"  {what}", 'cyan')

    submission = None
    tee = None
    if started_from_app:
      # like backend/api/tuning.py: the batch's scripts and logs, in its folder
      log_dir = batch_dir / 'qaboard-batches' / f"{run.start.astimezone(UTC):%Y%m%d-%H%M%S}-{command_id[:8]}"
      log_dir.mkdir(parents=True, exist_ok=True)
      os.chmod(log_dir, 0o777)
      tee = log_dir / 'log.txt'
      command = ' '.join(['qa', *self.batch_args(run, extra)])
      (log_dir / 'qa_batch.sh').write_text('\n'.join([
        '#!/bin/bash', 'set -xe', f"cd {self.ws.dir}", 'export CI=true', f"export GIT_COMMIT={commit.sha}",
        'export QABOARD_TUNING=true', f"export QA_OUTPUTS_COMMIT={env['QA_OUTPUTS_COMMIT']}",
        f"export QA_BATCH_COMMAND_ID={command_id}", command, '',
      ]))
      submission = {'id': command_id, 'created_at': real_start.isoformat() + 'Z', 'user': run.user, 'runner': 'local',
                    'command': command, 'log_dir': str(log_dir), 'status': 'done'}

    if run.progress:
      self.run_in_progress(commit, run, env, extra, expected)
      code = 0
    else:
      watchdog = Watchdog(limits) if limits else None
      code, output = self.ws.qa(self.batch_args(run, extra), env, watchdog=watchdog, tee=tee)
      if submission:
        submission['exit_code'] = code
        submission['status'] = 'done' if code == 0 or commit.failures else 'failed'
      if run.via == 'optimize' and code != 0:
        raise SeedError(f"{what} failed:\n{tail(output)}")
      self.verify_runs(commit, run, expected, watchdog, code, output)
    if submission:
      self.server.post('/api/v1/batch/', {
        'project': self.story.id, 'commit_sha': commit.sha, 'batch_label': run.db_label,
        'data': {'submissions': {**self.batch_data(commit, run).get('submissions', {}), command_id: submission}},
      })
    real_end = db_now()
    elapsed = time.time() - t
    self.timings[f"{commit.id}: {' '.join(self.batch_args(run, []))}"] = elapsed
    self.state.setdefault('timings', {})[f"{commit.id}/{run.index}"] = round(elapsed, 1)
    log(f"    done in {elapsed:.0f}s", 'dim')
    self.simulate_times(commit, run, real_start, real_end)

  def batch_dir(self, commit: Commit, run: Run) -> Path:
    """Where the server says the batch's files go (it creates the batch if needed)"""
    self.server.post('/api/v1/batch/', {'project': self.story.id, 'commit_sha': commit.sha, 'batch_label': run.db_label})
    batch = self.server.batch(self.story.id, commit.sha, run.db_label)
    return Path(unquote_url(batch['batch_dir_url']))

  def batch_data(self, commit: Commit, run: Run) -> dict:
    rows = stack.psql(f"""
      SELECT b.data FROM batches b JOIN ci_commits c ON b.ci_commit_id = c.id
      WHERE c.project_id = {sql_str(self.story.id)} AND c.hexsha = {sql_str(commit.sha)} AND b.label = {sql_str(run.db_label)}
    """)
    return json.loads(rows) if rows else {}

  def outputs_by_dir(self, commit: Commit, run: Run) -> Dict[str, dict]:
    batch = self.server.batch(self.story.id, commit.sha, run.db_label) or {}
    return {unquote_url(o['output_dir_url']): o for o in batch.get('outputs', {}).values()}

  def expected_failure(self, commit: Commit, run: Run, rel_input: str, configurations: Optional[list] = None) -> Optional[dict]:
    for f in commit.failures:
      if Story.failure_matches_run(f, run) and glob_matches(f.get('inputs'), rel_input) and (
        not f.get('configs') or fnmatch.fnmatch(json.dumps(configurations or []), f['configs'])
      ):
        return f
    return None

  def verify_runs(self, commit: Commit, run: Run, expected: List[dict], watchdog: Optional[Watchdog], code: int, output: str):
    """Runs the story says fail must fail, the others must succeed"""
    if run.via == 'optimize':
      return
    outputs = self.outputs_by_dir(commit, run)
    errors = []
    for r in expected:
      output_dir = r['output_dir']
      rel_input = r['rel_input_path']
      o = outputs.get(output_dir)
      if o is None:
        errors.append(f"{rel_input} {r['configurations']}: no run in QA-Board for {output_dir}")
        continue
      failure = self.expected_failure(commit, run, rel_input, r['configurations'])
      if o['is_pending']:
        errors.append(f"{rel_input} {r['configurations']}: still pending")
        continue
      logs = read_logs(Path(output_dir))
      if failure and not o['is_failed']:
        errors.append(f"{rel_input} {r['configurations']}: the story says it fails ({failure['kind']}), it succeeded")
      elif not failure and o['is_failed']:
        errors.append(f"{rel_input} {r['configurations']}: failed, and the story doesn't say it should:\n{tail(logs, 25)}")
      elif failure:
        if failure['kind'] in ('oom', 'timeout', 'lsf-memlimit'):
          killed = [i for i in (watchdog.runs.values() if watchdog else []) if i['input'] == rel_input and i['killed']]
          # `qa batch` also enforces the batch's local timeout (qaboard/runners/local.py): it may kill the run first
          timed_out = failure['kind'] == 'timeout' and f"{rel_input}: killed after its timeout" in output
          if not killed and not timed_out:
            errors.append(f"{rel_input}: the story says it dies ({failure['kind']}), but it failed on its own:\n{tail(logs, 15)}")
          elif failure['kind'] == 'lsf-memlimit':
            self.write_lsf_report(commit, run, r, killed[0])
            logs = read_logs(Path(output_dir))
        if failure.get('log') and not re.search(failure['log'], logs):
          errors.append(f"{rel_input}: its log doesn't match /{failure['log']}/:\n{tail(logs, 15)}")
    if errors:
      raise SeedError(f"{commit.id}: unexpected results in `{run.batch}` ({run.db_label}):\n- " + '\n- '.join(errors))

  def write_lsf_report(self, commit: Commit, run: Run, r: dict, info: dict):
    """LSF's job report, at the end of log.lsf.txt after the job's output (what `qa run` printed)"""
    output_dir = Path(r['output_dir'])
    started = run.start + datetime.timedelta(seconds=5)
    duration = max(1, round(info['killed'] - info['started']))
    terminated = started + datetime.timedelta(seconds=duration)
    job_output = (output_dir / 'log.txt').read_text(errors='replace') if (output_dir / 'log.txt').exists() else ''
    command = r.get('command') or f"qa run --input \"{r['rel_input_path']}\""
    job_id = int(hashlib.sha1(f"{commit.sha}{r['output_dir']}".encode()).hexdigest()[:6], 16) % 900000 + 100000
    report = LSF_REPORT.format(
      host='k3-sim-07', submission_host='ci-runner-03', user=run.user if run.user != 'ci' else 'ci',
      job_id=job_id, job_name=f"{str(uuid.uuid5(uuid.NAMESPACE_URL, commit.sha))[:8]}_{r['rel_input_path'].split('/')[-1].split('.')[0][:12]}",
      submitted=lsf_date(run.start), started=lsf_date(started), terminated=lsf_date(terminated),
      cwd=self.ws.dir, command=command, cpu=info['cpu_s'], max_memory=round(info['peak_mb']),
      average_memory=info['peak_mb'] * 0.6, requested=info['limit'].memory_mb, delta=info['limit'].memory_mb - info['peak_mb'],
      processes=info['processes'], threads=info['threads'], run_time=duration, turnaround=duration + 5,
    )
    (output_dir / 'log.lsf.txt').write_text(job_output + 'Killed\n' + report)

  def run_in_progress(self, commit: Commit, run: Run, env: Dict[str, str], extra: List[str], expected: List[dict]):
    """The batch is still running at T0: its finished share is done, `running` runs started, the rest pending."""
    finished = round(run.progress['finished'] * len(expected))
    running = min(run.progress.get('running', 0), len(expected) - finished)
    files = self.ws.dir / 'build' / '.seed'
    files.mkdir(parents=True, exist_ok=True)
    def runs_file(name: str, runs: List[dict]) -> Path:
      path = files / name
      path.write_text(json.dumps({'runs': [{
        'input_path': r['rel_input_path'], 'database': r['database'], 'type': r['type'], 'platform': r['platform'],
        'configurations': r['configurations'], 'extra_parameters': r['extra_parameters'], 'batch': r.get('batch'),
      } for r in runs]}))
      return path
    batch_args = without_batch_name(self.batch_args(run, extra), extra, run.batch)
    if finished:
      code, output = self.ws.qa(batch_args + ['--runs-file', str(runs_file('finished.json', expected[:finished]))], env)
      if code != 0:
        raise SeedError(f"{commit.id}: the finished runs of `{run.batch}` failed:\n{tail(output)}")
    rest = expected[finished:]
    if not rest:
      return self.as_one_command(commit, run, extra)
    def kill_when_started(process):
      # `qa batch` tells QA-Board about all its runs (pending), then starts `running` of them at once.
      # We stop everything as soon as they say they're running: they must take more than a few 100ms.
      deadline = time.time() + 600
      while time.time() < deadline and process.poll() is None:
        outputs = self.outputs_by_dir(commit, run)
        mine = [outputs.get(r['output_dir']) for r in rest]
        started = [o for o in mine if o and o['is_running']]
        if all(o is not None for o in mine) and len(started) >= running:
          break
        time.sleep(0.1)
      try:
        os.killpg(process.pid, signal.SIGKILL)
      except ProcessLookupError:
        pass
    args = batch_args + ['--runs-file', str(runs_file('rest.json', rest)), '--local-concurrency', str(max(running, 1))]
    self.ws.qa(args, env, kill_when=kill_when_started)
    outputs = self.outputs_by_dir(commit, run)
    states = [outputs.get(r['output_dir']) for r in rest]
    if any(o is None or not o['is_pending'] for o in states):
      raise SeedError(f"{commit.id}: could not leave `{run.batch}` in progress, runs finished before we could stop them "
                      f"(pending: {[(o or {}).get('is_pending') for o in states]}). Do its runs take at least a second?")
    # with running=0, a run may have started before we stopped `qa batch`
    if running == 0:
      ids = [str(o['id']) for o in states if o['is_running']]
      if ids:
        stack.psql(f"UPDATE outputs SET is_running = false WHERE id IN ({','.join(ids)});")
    self.as_one_command(commit, run, extra)

  def as_one_command(self, commit: Commit, run: Run, extra: List[str]):
    """The CI starts one `qa batch`: the seeder's commands (the finished runs, then the rest) show as that one"""
    t0 = self.story.t0.astimezone(UTC).replace(tzinfo=None)
    data = self.batch_data(commit, run)
    commands = data.get('commands') or {}
    ours = {k: c for k, c in commands.items() if datetime.datetime.fromisoformat(c.get('command_created_at_datetime') or '1970-01-01') > t0}
    if not ours:
      return
    first = min(ours, key=lambda k: ours[k]['command_created_at_datetime'])
    argv0 = (ours[first].get('argv') or ['qa'])[0]
    ours[first]['argv'] = [argv0, *self.batch_args(run, [e for e in extra if e not in ('--action-on-existing', 'run')])]
    data['commands'] = {k: c for k, c in commands.items() if k not in ours or k == first}
    stack.psql(f"""
      UPDATE batches b SET data = {sql_json(data)} FROM ci_commits c
      WHERE b.ci_commit_id = c.id AND c.project_id = {sql_str(self.story.id)} AND c.hexsha = {sql_str(commit.sha)} AND b.label = {sql_str(run.db_label)};
    """)

  # -- simulated time
  def simulate_times(self, commit: Commit, run: Run, real_start: datetime.datetime, real_end: datetime.datetime):
    """
    The backend stamps batches and outputs with its clock. Simulated times are all before T0, so anything of this
    commit dated after T0 was just created for real: move it to the batch's simulated start, keeping real durations
    (what a failed attempt left goes to the start). The same for the dates of `qa batch` commands and submissions in
    batches.data, latest_output_datetime, and the files' modification times.
    """
    sim_start = run.start.astimezone(UTC).replace(tzinfo=None)
    t0 = self.story.t0.astimezone(UTC).replace(tzinfo=None)
    def simulated(t: datetime.datetime) -> datetime.datetime:
      return sim_start + max(datetime.timedelta(0), t - real_start)
    real = sql_str(real_start.isoformat())
    commit_filter = f"c.project_id = {sql_str(self.story.id)} AND c.hexsha = {sql_str(commit.sha)}"
    stack.psql(f"""
      UPDATE outputs o SET created_date = {sql_str(sim_start.isoformat())}::timestamp + GREATEST(interval '0', o.created_date - {real}::timestamp)
      FROM batches b JOIN ci_commits c ON b.ci_commit_id = c.id
      WHERE o.batch_id = b.id AND {commit_filter} AND o.created_date > {sql_str(t0.isoformat())};
      UPDATE batches b SET created_date = {sql_str(sim_start.isoformat())}::timestamp + GREATEST(interval '0', b.created_date - {real}::timestamp)
      FROM ci_commits c WHERE b.ci_commit_id = c.id AND {commit_filter} AND b.created_date > {sql_str(t0.isoformat())};
    """)
    rows = stack.psql(f"""
      SELECT b.id, b.data, coalesce(b.batch_dir_override, '') FROM batches b JOIN ci_commits c ON b.ci_commit_id = c.id WHERE {commit_filter}
    """)
    for line in rows.splitlines():
      batch_id, rest = line.split('|', 1)
      data, batch_dir = rest.rsplit('|', 1)
      data = json.loads(data)
      changed = False
      for key, field_name, suffix in (('commands', 'command_created_at_datetime', ''), ('submissions', 'created_at', 'Z')):
        for item in (data.get(key) or {}).values():
          value = item.get(field_name)
          if not value:
            continue
          t = datetime.datetime.fromisoformat(value.rstrip('Z')).replace(tzinfo=None)
          if t > t0:
            item[field_name] = simulated(t).isoformat() + suffix
            changed = True
            # `qa --share batch` saves its logs in qa-batch-logs/<date>-<id>/: their folder gets the simulated date
            log_path = item.get('log') or ''
            if key == 'commands' and re.match(r'^qa-batch-logs/\d{8}-\d{6}-', log_path):
              batch_dir = batch_dir or str(self.batch_dir(commit, run))
              old = Path(batch_dir) / Path(log_path).parent
              new_name = f"{simulated(t):%Y%m%d-%H%M%S}-{old.name.split('-')[-1]}"
              if old.exists() and old.name != new_name:
                old.rename(old.with_name(new_name))
                item['log'] = f"qa-batch-logs/{new_name}/{Path(log_path).name}"
      if changed:
        stack.psql(f"UPDATE batches SET data = {sql_json(data)} WHERE id = {int(batch_id)};")
    self.update_latest_output_datetimes()
    self.simulate_mtimes(commit, real_start, sim_start)

  def simulate_mtimes(self, commit: Commit, real_start: datetime.datetime, sim_start: datetime.datetime):
    """Files modified after T0 get their simulated time"""
    t0 = self.story.t0.timestamp()
    real, sim = real_start.replace(tzinfo=UTC).timestamp(), sim_start.replace(tzinfo=UTC).timestamp()
    commit_dir = self.ws.outputs_commit(commit)
    for path in [*walk(commit_dir), commit_dir]:
      try:
        mtime = path.lstat().st_mtime
        if mtime > t0:
          t = sim + max(0.0, mtime - real)
          os.utime(path, (t, t), follow_symlinks=False)
      except OSError:
        pass

  def settle_mtimes(self):
    """The project's folders (<results>/<project>/<xx>/) were modified when their last commit got results"""
    project_dir = stack.results_root() / self.story.id
    shards = {self.ws.outputs_commit(c).parent for c in self.story.commits.values()}
    for folder in [*sorted(shards), project_dir]:
      children = [p.lstat().st_mtime for p in folder.iterdir()] if folder.exists() else []
      if children:
        os.utime(folder, (max(children),) * 2)

  def update_latest_output_datetimes(self):
    pid = sql_str(self.story.id)
    stack.psql(f"""
      UPDATE ci_commits c SET latest_output_datetime = GREATEST(c.authored_datetime, (
        SELECT max(o.created_date) AT TIME ZONE 'utc' FROM outputs o JOIN batches b ON o.batch_id = b.id WHERE b.ci_commit_id = c.id
      )) WHERE c.project_id = {pid};
      UPDATE projects p SET latest_output_datetime = (
        SELECT max(c.latest_output_datetime) AT TIME ZONE 'utc' FROM ci_commits c WHERE c.project_id = p.id
      ) WHERE p.id = {pid};
    """)

  # -- milestones
  def create_milestones(self):
    for m in self.story.milestones:
      if m.get('kind') == 'config':
        continue
      commit = self.story.commits[m['commit']]
      if self.args.until and m['commit'] not in self.seeded_commits:
        continue
      batch = m.get('batch', 'default')
      date = max(r.start for r in commit.runs) + datetime.timedelta(hours=1) if commit.runs else commit.at + datetime.timedelta(hours=2)
      date = min(date, self.story.t0 - datetime.timedelta(hours=1))
      session = self.server.login(m['by'])
      saved = self.server.post('/api/v1/milestones', {
        'project': self.story.id, 'label': m['label'], 'notes': m.get('notes', ''), 'group': m.get('group', ''),
        'shared': m.get('kind', 'shared') == 'shared', 'commit': commit.sha, 'batch': batch, 'filter': m.get('filter', ''),
        'branch': commit.branch, 'committer_name': self.story.people[commit.author]['name'], 'message': commit.message.splitlines()[0],
      }, session=session).json()
      # the API saves it now: it was saved in the story's past
      stack.psql(f"UPDATE milestones SET created_at = {sql_str(date.astimezone(UTC).replace(tzinfo=None).isoformat())}::timestamp, updated_at = created_at WHERE id = {int(saved['id'])};")
      log(f"  milestone {m['label']} on {commit.id}, by {m['by']}", 'cyan')

  @property
  def seeded_commits(self) -> List[str]:
    if not self.args.until:
      return self.story.order
    return self.story.order[:self.story.order.index(self.args.until) + 1]

  # -- main
  def seed(self):
    story = self.story
    start = time.time()
    self.ws.prepare()
    if self.args.resume:
      self.load_state()
      log(f"Resuming the seed of {story.id}: {len(self.state['done'])} steps done", 'blue')
    else:
      log(f"Seeding {story.id} ({len(story.order)} commits) with T0 = {iso(story.t0)}", 'blue')
      self.wipe()
      self.save_state()
    self.ensure_users()
    for commit_id in self.seeded_commits:
      commit = story.commits[commit_id]
      self.ws.checkout(commit)
      if not self.done(f"{commit.id}:commit"):
        log(f"{commit.at:%a %Y-%m-%d %H:%M} {commit.id} [{commit.branch}] {commit.author}: {commit.message.splitlines()[0]}", 'bold')
        self.create_commit(commit)
        self.mark(f"{commit.id}:commit")
      if commit.runs and not self.done(f"{commit.id}:artifacts"):
        # like the CI, before it runs anything
        env = self.ws.env(commit, 'ci', 'ci')
        real_start = db_now()
        self.ws.qa(['save-artifacts'], env, check=True, quiet=True)
        first = min(commit.runs, key=lambda r: r.start)
        self.simulate_mtimes(commit, real_start, (first.start - datetime.timedelta(minutes=1)).astimezone(UTC).replace(tzinfo=None))
        self.mark(f"{commit.id}:artifacts")
      for run in commit.runs:
        step = f"{commit.id}:run:{run.index}"
        if self.done(step):
          continue
        self.run_batch(commit, run)
        self.mark(step)
    if not self.done('milestones') and not self.args.until:
      self.create_milestones()
      self.mark('milestones')
    self.state['duration_s'] = self.state.get('duration_s', 0) + time.time() - start
    self.save_state()
    self.settle_mtimes()
    self.write_demo_metadata()
    log(f"Seeded {story.id} in {time.time() - start:.0f}s", 'green')
    if self.timings:
      slowest = sorted(self.timings.items(), key=lambda kv: -kv[1])[:5]
      log("Slowest batches: " + ', '.join(f"{what} ({seconds:.0f}s)" for what, seconds in slowest), 'dim')

  def write_demo_metadata(self):
    """<results>/.qaboard-demo/demo.json: T0 and what each project's story became. Part of the snapshots."""
    path = stack.demo_dir() / 'demo.json'
    path.parent.mkdir(parents=True, exist_ok=True)
    demo = json.loads(path.read_text()) if path.exists() else {}
    if demo.get('t0') and demo['t0'] != iso(self.story.t0):
      log(f"WARNING: the stack was seeded with T0={demo['t0']}, now {iso(self.story.t0)}: other projects' data is stale", 'yellow')
      demo = {}
    story = self.story
    demo['t0'] = iso(story.t0)
    # for the captures (docs-media/shots/lib/demo.ts)
    demo['app_version'] = stack.backend_version()
    demo['base_url'] = self.server.url
    demo['storage'] = str(stack.results_root())
    demo.setdefault('projects', {})[story.project] = {
      'id': story.id,
      'seed': story.seed,
      'story_sha256': story.sha256,
      'seeded_at': iso(datetime.datetime.now(UTC)),
      'seed_duration_s': round(self.state.get('duration_s', 0)),
      'complete': not self.args.until,
      'commits': {
        c.id: {'sha': c.sha, 'branch': c.branch, 'at': iso(c.at), 'parents': c.parents, 'author': c.author,
               'batches': sorted({r.db_label for r in c.runs})}
        for c in (story.commits[i] for i in self.seeded_commits)
      },
      'milestones': {m['label']: m['commit'] for m in story.milestones},
      'users': {handle: {'name': p['name'], 'password': DEMO_PASSWORD} for handle, p in story.people.items()},
    }
    path.write_text(json.dumps(demo, indent=2, sort_keys=True) + '\n')
    os.chmod(path, 0o666)


def remove_results(commit_dir: Path):
  """Deletes a commit's results, and the folders above it that end up empty"""
  shutil.rmtree(commit_dir, ignore_errors=True)
  for parent in list(commit_dir.parents)[:3]:   # <xx>/, <project>/, <group>/
    try:
      parent.rmdir()
    except OSError:
      break


def copy_if_changed(src, dst):
  """Like rsync: big inputs aren't copied again"""
  s, d = Path(src), Path(dst)
  if d.exists() and s.stat().st_size == d.stat().st_size and int(s.stat().st_mtime) == int(d.stat().st_mtime):
    return dst
  return shutil.copy2(src, dst)


def walk(root: Path):
  if not root.exists():
    return
  for dirpath, dirnames, filenames in os.walk(root):
    for name in filenames + dirnames:
      yield Path(dirpath) / name


def read_logs(output_dir: Path) -> str:
  texts = []
  for name in ('log.txt', 'log.lsf.txt'):
    p = output_dir / name
    if p.exists():
      texts.append(p.read_text(errors='replace'))
  return '\n'.join(texts)


def unquote_url(url: str) -> str:
  from urllib.parse import unquote
  return unquote(url)[2:]   # /s/mnt/... -> /mnt/...



# ------------------------------------------------------------------------------------------------ checks

class CheckRun:
  """A run, for checks and story_checks.py hooks"""
  def __init__(self, output: dict):
    self.output = output
    self.input: str = output['test_input_path']
    self.configurations: list = output['configurations']
    self.extra_parameters: dict = output['extra_parameters']
    self.platform: str = output['platform']
    self.metrics: dict = output['metrics'] or {}
    self.failed: bool = bool(output['is_failed'])
    self.pending: bool = bool(output['is_pending'])
    self.output_dir = Path(unquote_url(output['output_dir_url']))

  @property
  def key(self) -> str:
    """Identifies the run within its batch: input, platform, configurations, tuning parameters"""
    return json.dumps([self.input, self.platform, self.configurations, self.extra_parameters], sort_keys=True)

  def file(self, name: str) -> Path:
    return self.output_dir / name

  def log(self) -> str:
    return read_logs(self.output_dir)

  def __repr__(self):
    return f"<Run {self.input} {self.platform} {json.dumps(self.configurations)}{' ' + json.dumps(self.extra_parameters) if self.extra_parameters else ''}>"


class CheckContext:
  """What story_checks.py hooks get as `ctx` (see examples/STORY.md#checks)"""
  def __init__(self, seeder: Seeder, check: dict):
    self.seeder = seeder
    self.story = seeder.story
    self.check = check
    self.commit: str = check['commit']
    self.t0 = seeder.story.t0
    self.workspace = seeder.ws.dir
    self.results = stack.results_root()

  def sha(self, commit: str) -> str:
    return self.story.commits[commit].sha

  def parent(self, commit: str) -> Optional[str]:
    parents = self.story.commits[commit].parents
    return parents[0] if parents else None

  def flags(self, commit: str) -> dict:
    return deepcopy(self.story.commits[commit].flags)

  def db_label(self, commit: str, label: str) -> str:
    for run in self.story.commits[commit].runs:
      if run.label == label:
        return run.db_label
    return label

  def runs(self, commit: Optional[str] = None, label: Optional[str] = None, platform: Optional[str] = None,
           inputs: Optional[str] = None, configs: Optional[str] = None) -> List[CheckRun]:
    """The runs of a commit's batch, by default those the check selects"""
    commit = commit or self.commit
    label = label or self.check.get('label', 'default')
    platform = platform or self.check.get('platform', 'linux')
    inputs = inputs if inputs is not None else self.check.get('inputs')
    configs = configs if configs is not None else self.check.get('configs')
    batch = self.seeder.server.batch(self.story.id, self.sha(commit), self.db_label(commit, label)) or {}
    runs = [CheckRun(o) for o in batch.get('outputs', {}).values()]
    return [
      r for r in runs
      if r.platform == platform and glob_matches(inputs, r.input) and (not configs or fnmatch.fnmatch(json.dumps(r.configurations), configs))
    ]

  def qa(self, *args: str, commit: Optional[str] = None, check=False) -> subprocess.CompletedProcess:
    """Runs the real `qa` CLI in the workspace, as the CI on that commit (default: the check's)"""
    c = self.story.commits[commit or self.commit]
    self.seeder.ws.checkout(c)
    code, output = self.seeder.ws.qa(list(args), self.seeder.ws.env(c, 'ci', 'ci'), quiet=True)
    if check and code != 0:
      raise SeedError(f"`qa {' '.join(args)}` failed ({code}):\n{tail(output)}")
    # without colors: qa colors its output in CI
    return subprocess.CompletedProcess(['qa', *args], code, re.sub(r'\x1b\[[0-9;]*m', '', output), '')


def aggregate(values: List[float], how: str) -> float:
  if not values:
    raise ValueError("no values")
  if how == 'median':
    return statistics.median(values)
  if how == 'mean':
    return statistics.fmean(values)
  if how == 'min':
    return min(values)
  if how == 'max':
    return max(values)
  if how == 'p90':
    s = sorted(values)
    k = (len(s) - 1) * 0.9
    lo, hi = int(k), min(int(k) + 1, len(s) - 1)
    return s[lo] + (s[hi] - s[lo]) * (k - lo)
  raise ValueError(how)


def compare(value: float, spec: dict) -> bool:
  ok = True
  if 'gt' in spec: ok &= value > spec['gt']
  if 'gte' in spec: ok &= value >= spec['gte']
  if 'lt' in spec: ok &= value < spec['lt']
  if 'lte' in spec: ok &= value <= spec['lte']
  if 'between' in spec: ok &= spec['between'][0] <= value <= spec['between'][1]
  return ok


def describe(spec: dict) -> str:
  symbols = {'gt': '>', 'gte': '>=', 'lt': '<', 'lte': '<='}
  return ' and '.join(f"in [{v[0]}, {v[1]}]" if k == 'between' else f"{symbols[k]} {v}" for k, v in spec.items())


def match_runs(new: List[CheckRun], ref: List[CheckRun]) -> List[Tuple[CheckRun, CheckRun]]:
  """Like the web app: same input and platform, then the closest configuration"""
  pairs = []
  for n in new:
    candidates = [r for r in ref if r.input == n.input and r.platform == n.platform]
    if not candidates:
      continue
    def score(r: CheckRun):
      same_configs = r.configurations == n.configurations
      common = len({json.dumps(c, sort_keys=True) for c in r.configurations} & {json.dumps(c, sort_keys=True) for c in n.configurations})
      return (same_configs, r.extra_parameters == n.extra_parameters, common)
    pairs.append((n, max(candidates, key=score)))
  return pairs


def run_checks(seeder: Seeder) -> bool:
  story = seeder.story
  hooks = None
  hooks_path = story.example / 'story_checks.py'
  if hooks_path.exists():
    spec = importlib.util.spec_from_file_location(f"story_checks_{story.project.replace('-', '_')}", hooks_path)
    hooks = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(hooks)
  seeded = set(seeder.seeded_commits)
  results = []
  for check in story.checks:
    name = check['name']
    ctx = CheckContext(seeder, check)
    vs = check.get('vs')
    if vs == 'parent':
      vs = ctx.parent(check['commit'])
    elif vs and vs.startswith('milestone:'):
      label = vs.split(':', 1)[1]
      vs = next((m['commit'] for m in story.milestones if m['label'] == label), None)
      if vs is None:
        results.append(('FAIL', name, f"no milestone {label}"))
        continue
    needed = {check['commit'], *([vs] if vs else [])}
    if not needed <= seeded:
      results.append(('SKIP', name, 'not seeded (--until)'))
      continue
    try:
      if 'hook' in check:
        if not hooks or not hasattr(hooks, check['hook']):
          results.append(('FAIL', name, f"no function {check['hook']} in {hooks_path.relative_to(REPO)}"))
          continue
        ok, message = getattr(hooks, check['hook'])(ctx, **check.get('args', {}))
        results.append(('PASS' if ok else 'FAIL', name, message))
        continue
      expect = check['expect']
      if 'gate' in expect:
        # `qa gate` against the seeded server, like the project's CI would run it; its JSON says the verdict
        commit = story.commits[check['commit']]
        args = ['gate', '--json', '--commit', commit.sha, '--batch', ctx.db_label(check['commit'], check.get('label', 'default'))]
        if vs:
          args += ['--reference', ctx.sha(vs)]
        code, output = seeder.ws.qa(args, seeder.ws.env(commit, 'cli', commit.author), quiet=True, stdout_only=True)
        try:
          verdict = json.loads(output)['verdict']
        except (ValueError, KeyError, TypeError):
          verdict = None
        if verdict is None:
          results.append(('FAIL', name, f"`qa {' '.join(args)}` exited with {code} without a verdict:\n{tail(output, 15)}"))
        else:
          failed_checks = [failed_gate_check(c) for b in json.loads(output).get('batches', [])
                           for c in b.get('checks', []) if c.get('status') == 'fail']
          ok = verdict == expect['gate']
          results.append(('PASS' if ok else 'FAIL', name,
                          f"gate: {verdict} (expected {expect['gate']}, exit code {code})" + (f"; failed: {'; '.join(failed_checks)}" if failed_checks else '')))
        expect = {k: v for k, v in expect.items() if k != 'gate'}
        if not expect:
          continue
      new = ctx.runs()
      if not new:
        results.append(('FAIL', name, f"no runs on {check['commit']} ({check.get('label', 'default')}, {check.get('platform', 'linux')})"))
        continue
      messages, ok = [], True
      if 'failed' in expect:
        failed = sum(r.failed for r in new)
        good = compare(failed, expect['failed'])
        ok &= good
        messages.append(f"failed runs: {failed} (expected {describe(expect['failed'])})")
      if 'log' in expect:
        bad = [r for r in new if r.failed and not re.search(expect['log'], r.log())]
        ok &= not bad
        messages.append(f"logs of failed runs match /{expect['log']}/" if not bad else f"{len(bad)} failed runs' logs don't match /{expect['log']}/: {bad[:3]}")
      metric = check.get('metric')
      if metric and any(k in expect for k in ('value', 'delta', 'change_pct')):
        how = check.get('agg', 'median')
        valid = [r for r in new if not r.failed and r.metrics.get(metric) is not None]
        if vs:
          ref = ctx.runs(commit=vs, label=check.get('vs_label', check.get('label', 'default')), configs=check.get('vs_configs', check.get('configs')))
          ref = [r for r in ref if not r.failed and r.metrics.get(metric) is not None]
          pairs = match_runs(valid, ref)
          if not pairs:
            results.append(('FAIL', name, f"no matching runs between {check['commit']} and {vs}"))
            continue
          new_value = aggregate([n.metrics[metric] for n, _ in pairs], how)
          ref_value = aggregate([r.metrics[metric] for _, r in pairs], how)
        else:
          new_value = aggregate([r.metrics[metric] for r in valid], how)
          ref_value = None
        numbers = f"{metric} {how}: {new_value:.6g}" + (f" vs {ref_value:.6g} on {vs}" if ref_value is not None else '')
        for k in ('value', 'delta', 'change_pct'):
          if k not in expect:
            continue
          if k == 'value':
            actual = new_value
          elif k == 'delta':
            actual = new_value - ref_value
          else:
            actual = (new_value - ref_value) / abs(ref_value) * 100 if ref_value else float('inf')
          good = compare(actual, expect[k])
          ok &= good
          messages.append(f"{k}: {actual:+.4g}{'%' if k == 'change_pct' else ''} (expected {describe(expect[k])}) [{numbers}]")
      results.append(('PASS' if ok else 'FAIL', name, '; '.join(messages)))
    except Exception as e:
      results.append(('FAIL', name, f"{type(e).__name__}: {e}"))
  colors = {'PASS': 'green', 'FAIL': 'red', 'SKIP': 'yellow'}
  log(f"Checks of {story.id}:", 'bold')
  for status, name, message in results:
    log(f"  {status} {name}", colors[status])
    if message:
      log(f"       {message}", 'dim' if status == 'PASS' else colors[status])
  failed = [r for r in results if r[0] == 'FAIL']
  if failed:
    log(f"{len(failed)} of {len(results)} checks failed", 'red')
  return not failed


# ------------------------------------------------------------------------------------------------ CLI

def print_plan(story: Story):
  """What the story does, commit by commit: when, who, what changes in the flags, which runs"""
  def changes(before: dict, after: dict) -> str:
    keys = sorted(set(before) | set(after))
    return ', '.join(
      f"-{k}" if k not in after else f"{k}={json.dumps(after[k])}"
      for k in keys if before.get(k, MISSING) != after.get(k, MISSING)
    )
  defaults = story.data.get('defaults', {}).get('flags', {})
  print(f"{story.id}: {len(story.order)} commits, T0 {iso(story.t0)} ({story.t0:%A})")
  for commit_id in story.order:
    c = story.commits[commit_id]
    parent = story.commits[c.parents[0]].flags if c.parents else defaults
    runs = ', '.join(
      f"{r.batch}{'/' + r.platform if r.platform != 'linux' else ''}"
      f"{' via ' + r.via if r.via != 'ci' else ''}{' [' + r.label + ']' if r.label != 'default' else ''}"
      f"{' +' + str(r.after) if r.via != 'ci' or r.after != datetime.timedelta(minutes=6) else ''}"
      f"{' (in progress)' if r.progress else ''}"
      for r in c.runs
    ) or 'no runs'
    merge = f" merge of {c.parents[1]}" if len(c.parents) > 1 else ''
    print(f"{c.at:%a %m-%d %H:%M} {c.id:<24} {c.branch:<22} {c.author:<7}{merge}")
    flags = changes(parent, c.flags)
    if flags:
      print(f"{'':16}flags: {flags}")
    if c.patches:
      print(f"{'':16}patches: {', '.join(c.patches)}")
    print(f"{'':16}runs: {runs}")
    for f in c.failures:
      print(f"{'':16}fails: {f['batch']} {f.get('inputs', '')} {f.get('configs', '')} {f['kind']}")
  for m in story.milestones:
    print(f"milestone {m['label']} on {m['commit']} by {m['by']}")
  print(f"{len(story.checks)} checks")


def find_story(args) -> Path:
  if args.story:
    return Path(args.story)
  if not args.project:
    raise SystemExit("ERROR: give --project <example> or --story <path>")
  path = EXAMPLES / args.project / 'story.yaml'
  if not path.exists():
    raise SystemExit(f"ERROR: {path} doesn't exist")
  return path


def stack_t0() -> Optional[str]:
  path = stack.demo_dir() / 'demo.json'
  if path.exists():
    return json.loads(path.read_text()).get('t0')
  return None


def main():
  parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
  parser.add_argument('command', nargs='?', default='seed', choices=['seed', 'up', 'down'], help="default: seed")
  parser.add_argument('--project', help="An example's folder name, e.g. image-quality")
  parser.add_argument('--story', help="A story.yaml path instead of --project, e.g. docs-media/tests/fixture/story.yaml")
  parser.add_argument('--t0', help="The seed date, e.g. 2026-10-08T16:00Z. Default: the stack's, if it has seeded data, else the last Thursday 16:00 UTC")
  parser.add_argument('--server', default=stack.server_url(), help="QA-Board's URL (default: %(default)s)")
  parser.add_argument('--until', help="Stop after this commit (no milestones, checks of the seeded commits only)")
  parser.add_argument('--resume', action='store_true', help="Continue the last seed of this story where it stopped")
  parser.add_argument('--checks-only', action='store_true', help="Only run the story's checks")
  parser.add_argument('--fresh', action='store_true', help="Start from an empty stack: delete its database and seeded data first")
  parser.add_argument('--validate', action='store_true', help="Only check the story and print what it does (no stack needed)")
  parser.add_argument('--workspace', default='/tmp/kitefin', help="Where the examples are copied and run (default: %(default)s)")
  parser.add_argument('--jobs', type=int, default=os.cpu_count(), help="Runs in parallel in each batch (default: %(default)s)")
  parser.add_argument('--volumes', action='store_true', help="down: also delete the data")
  parser.add_argument('--pull', action='store_true', help="up: pull the images first")
  parser.add_argument('-q', '--quiet', action='store_true', help="Don't print qa's output")
  args = parser.parse_args()
  args.verbose = not args.quiet

  if args.command == 'up':
    stack.up(pull=args.pull)
    log(f"QA-Board is at {stack.server_url()}", 'green')
    return
  if args.command == 'down':
    stack.down(volumes=args.volumes)
    return

  if args.validate:
    story = Story(find_story(args), parse_t0(args.t0) if args.t0 else default_t0())
    print_plan(story)
    return
  if args.fresh:
    log("Deleting the demo stack's data (--fresh)", 'yellow')
    stack.down(volumes=True)
    # and the results of what was seeded
    old = stack.demo_dir() / 'demo.json'
    for project in (json.loads(old.read_text()).get('projects', {}) if old.exists() else {}).values():
      for commit in project.get('commits', {}).values():
        remove_results(stack.results_root() / project['id'] / commit['sha'][:2] / commit['sha'][2:16])
    shutil.rmtree(stack.demo_dir(), ignore_errors=True)
  if not stack.is_up():
    if args.server.rstrip('/') != stack.server_url():
      raise SystemExit(f"ERROR: {args.server} doesn't answer")
    stack.up()
  if args.t0:
    t0 = parse_t0(args.t0)
  elif stack_t0() and not args.resume:
    t0 = parse_t0(stack_t0())
    log(f"Using the stack's T0 ({iso(t0)}), so all its projects share it", 'dim')
  else:
    t0 = default_t0()
  story_path = find_story(args)
  if args.resume and not args.t0:
    # T0 comes from the state of the seed we resume
    probe = yaml.safe_load(story_path.read_text())
    state_path = Path(args.workspace) / probe['id'].split('/')[-1] / '.seed-state.json'
    if state_path.exists():
      t0 = parse_t0(json.loads(state_path.read_text())['t0'])
  if t0 >= datetime.datetime.now(UTC):
    raise SystemExit(f"ERROR: T0 ({iso(t0)}) must be in the past")
  story = Story(story_path, t0)
  if args.until and args.until not in story.commits:
    raise SystemExit(f"ERROR: --until: no commit {args.until}")
  seeder = Seeder(story, args)
  try:
    if not args.checks_only:
      seeder.seed()
    else:
      seeder.ws.prepare()
    ok = run_checks(seeder)
  except SeedError as e:
    log(f"ERROR: {e}", 'red')
    log(f"Fix it, then continue with: uv run docs-media/seed.py {' '.join(a for a in sys.argv[1:] if a != '--resume')} --resume", 'yellow')
    sys.exit(1)
  if not ok:
    sys.exit(1)


if __name__ == '__main__':
  main()
