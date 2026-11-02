"""
Scans the storage: what's on disk in the projects' folders, who owns it, and what QA-Board knows about it.
Admins explore the result (Admin > Storage > Scans) to find and delete what QA-Board doesn't track, users see the
untracked files they own ("Storage usage").

Each folder is one of:
- run: a run QA-Board knows. deleted_run: a run deleted in QA-Board, with files left. untracked_run: a run folder
  (it has run.json) that QA-Board doesn't know, e.g. its upload failed, or its run was hard-deleted.
- artifacts: a commit's artifacts. deleted_artifacts: artifacts QA-Board thinks it deleted, still on disk.
- export: an export QA-Board tracks. untracked_export: an export it doesn't (they have 0.qa.url...).
- batch: a batch's folder, whose runs are inside. folder: anything else. Files directly in a batch's or another folder
  count as untracked_files, big files have their own entries (file).
Runs, exports and artifacts aren't detailed: their size is all we need.

What QA-Board knows is looked up as we find folders: commits by the <2 hex>/<14 hex> folders of QA-Board's layout,
then their batches' and runs' folders, and runs with their own folder (output_dir_override) by their path.
Entries smaller than `min_size_mb` are summed up in their parent. Hard links count once. It runs on several threads:
the storage (NFS...) answers slowly, but in parallel. An interrupted scan resumes with the root folders it didn't finish.
Cancelling stops the threads at the next folder they read, even deep in a huge folder: only a folder whose storage
doesn't answer at all (a hung mount) can't be stopped, admins then force the job to stop (api/admin_jobs.py).
"""
import os
import re
import glob
import datetime
import threading
from functools import lru_cache
from concurrent.futures import ThreadPoolExecutor, wait, FIRST_COMPLETED
from typing import Optional

from sqlalchemy import text

from ..database import db_session, engine, make_engine
from ..models import Project, CiCommit, Batch, Output, Export, StorageScan
from ..storage import check_storage_path, UnsafePathError
from ..exports import MARKERS, owner_name
from .. import accounts
from . import params as p
from .common import matching_projects
from .report import Reporter, utcnow


PARAMS = ('roots', 'projects', 'exclude_projects', 'exclude_paths', 'min_size_mb', 'threads')
LEAVES = {'run', 'deleted_run', 'untracked_run', 'artifacts', 'deleted_artifacts', 'export', 'untracked_export'}
# what admins can delete from a scan: never what QA-Board tracks and uses
DELETABLE = {'deleted_run', 'untracked_run', 'deleted_artifacts', 'untracked_export', 'export', 'untracked_files', 'file', 'folder'}
UNTRACKED = {'deleted_run', 'untracked_run', 'deleted_artifacts', 'untracked_export', 'untracked_files'}
FLUSH_EVERY = 2000
PROGRESS_EVERY = 2  # seconds: how often the folders explored are reported, and cancelling is checked
# Storage snapshots are copies of everything: never scanned, whatever `exclude_paths` says
SNAPSHOTS = {'.snapshot', '.snapshots', '.zfs'}
commit_dirs_re = re.compile(r'/(?P<a>[0-9a-f]{2})/(?P<b>[0-9a-f]{14})(?=/|$)')


def validate(params: dict) -> dict:
  p.known_keys(params, PARAMS)
  roots = params.get('roots') or []
  if isinstance(roots, str):
    roots = [r for r in re.split(r'[\n,]', roots)]
  if not isinstance(roots, list) or not all(isinstance(r, str) for r in roots):
    raise p.ParamsError("`roots` must be a list of folders")
  roots = [r.strip().rstrip('/') or '/' for r in roots if r.strip()]
  for root in roots:
    if not root.startswith('/'):
      raise p.ParamsError(f"`roots`: {root} must be an absolute path")
  min_size = params.get('min_size_mb', 50)
  threads = params.get('threads', 8)
  if not isinstance(min_size, (int, float)) or min_size < 0:
    raise p.ParamsError("`min_size_mb` must be a number of MB")
  if not isinstance(threads, int) or not 1 <= threads <= 64:
    raise p.ParamsError("`threads` must be between 1 and 64")
  return {
    "roots": roots,
    "projects": p.globs(params.get('projects'), 'projects', default=[] if roots else ['*']),
    "exclude_projects": p.globs(params.get('exclude_projects'), 'exclude_projects'),
    "exclude_paths": p.globs(params.get('exclude_paths'), 'exclude_paths', default=['*/.snapshot', '*/.snapshots']),
    "min_size_mb": min_size,
    "threads": threads,
  }


def describe(params: dict) -> str:
  what = []
  if params['projects']:
    what.append(f"the storage of {', '.join(params['projects'])}{' except ' + ', '.join(params['exclude_projects']) if params['exclude_projects'] else ''}")
  if params['roots']:
    what.append(', '.join(params['roots']))
  return f"Scan {' and '.join(what)}"


def project_roots(params: dict) -> list:
  """The folders of the projects' outputs and artifacts, whoever's they are ({user} in the storage settings)"""
  roots = set()
  for project_id in matching_projects(params) if params['projects'] else []:
    project = db_session.get(Project, project_id)
    if project is None or (project.data or {}).get('legacy'):
      continue
    try:
      storage = project.storage_roots(user_name='*')
    except Exception:
      continue
    for key in ('outputs', 'artifacts'):
      pattern = str(storage[key])
      for path in (glob.glob(pattern) if '*' in pattern else [pattern]):
        roots.add(path.rstrip('/'))
  from ..settings import setting
  if params['projects'] == ['*'] and setting('storage.exports_root'):
    roots.add(setting('storage.exports_root').rstrip('/'))
  return sorted(roots)


def real_folder(path: str):
  """Where a folder really is, and its identity: symlinks and bind mounts give the same folder several paths"""
  real = os.path.realpath(path)
  try:
    st = os.stat(real)
    return real, (st.st_dev, st.st_ino)
  except OSError:
    return real, None


def top_folders(paths) -> list:
  """
  Without the folders inside others, or that are another folder under another path (symlinks, bind mounts):
  each is scanned once.
  """
  kept, reals, identities = [], [], set()
  for path in sorted(set(paths), key=lambda p: (len(os.path.realpath(p)), len(p), p)):
    real, identity = real_folder(path)
    if identity is not None and identity in identities:
      continue
    if any(real == k or real.startswith(k.rstrip('/') + '/') for k in reals):
      continue
    if any(path == k or path.startswith(k.rstrip('/') + '/') for k in kept):
      continue
    kept.append(path)
    reals.append(real)
    if identity is not None:
      identities.add(identity)
  return sorted(kept)


def owner(uid: int) -> str:
  return _owner(uid, accounts.version())


# the accounts can change during a scan, e.g. when QABOARD_ACCOUNTS_COMMAND's first output arrives
@lru_cache(maxsize=10_000)
def _owner(uid: int, accounts_version) -> str:
  return owner_name(uid)


class Totals:
  """Bytes and files by kind and by owner (uids), and the newest modification"""
  __slots__ = ('bytes', 'files', 'kinds', 'owners', 'newest')

  def __init__(self):
    self.bytes, self.files, self.kinds, self.owners, self.newest = 0, 0, {}, {}, 0

  def add_file(self, stat, kind, seen):
    if stat.st_nlink > 1:
      key = (stat.st_dev, stat.st_ino)
      if key in seen:
        return
      seen.add(key)
    size = stat.st_size
    self.bytes += size
    self.files += 1
    self.kinds[kind] = self.kinds.get(kind, 0) + size
    owners = self.owners.setdefault(stat.st_uid, {})
    owners[kind] = owners.get(kind, 0) + size
    self.newest = max(self.newest, stat.st_mtime)

  def merge(self, other):
    self.bytes += other.bytes
    self.files += other.files
    for kind, size in other.kinds.items():
      self.kinds[kind] = self.kinds.get(kind, 0) + size
    for uid, kinds in other.owners.items():
      mine = self.owners.setdefault(uid, {})
      for kind, size in kinds.items():
        mine[kind] = mine.get(kind, 0) + size
    self.newest = max(self.newest, other.newest)

  def owners_by_name(self, limit=None):
    named = {}
    for uid, kinds in self.owners.items():
      named[owner(uid)] = named.get(owner(uid), 0) + sum(kinds.values())
    ordered = sorted(named.items(), key=lambda kv: -kv[1])
    return dict(ordered[:limit] if limit else ordered)


class Known:
  """What QA-Board knows about folders, looked up as the scan finds them. One per thread: each has its own session."""
  def __init__(self, session, exports: dict, batch_overrides: dict):
    self.session = session
    self.exports = exports                  # path => export id (shared, read-only)
    self.batch_overrides = batch_overrides  # path => batch id (shared, read-only)
    self.commits = {}                       # 16-char prefix => {batch_dirs, artifacts_dirs}
    self.batch_runs = {}                    # batch id => {run dir: (output id, deleted)}

  def commit_info(self, prefix: str) -> dict:
    if prefix not in self.commits:
      info = {"batch_dirs": {}, "artifacts_dirs": {}, "commits": []}
      commits = (self.session.query(CiCommit).filter(CiCommit.hexsha >= prefix, CiCommit.hexsha < prefix + 'g').all())
      for commit in commits:
        if not commit.hexsha.startswith(prefix):
          continue
        info["commits"].append(commit.id)
        # no `except`: if QA-Board can't tell where a commit's files are, the folder fails (an error of the scan)
        # rather than its runs and artifacts looking untracked, and deletable
        info["artifacts_dirs"][str(commit.artifacts_dir)] = (commit.id, commit.project_id, bool(commit.deleted))
        for batch in commit.batches:
          info["batch_dirs"][str(batch.batch_dir)] = (batch.id, commit.project_id)
      self.session.rollback()
      self.session.expunge_all()
      if len(self.commits) > 20_000:
        self.commits.clear()
      self.commits[prefix] = info
    return self.commits[prefix]

  def commit_for(self, path: str) -> Optional[dict]:
    matches = list(commit_dirs_re.finditer(path))
    if not matches:
      return None
    last = matches[-1]
    return self.commit_info(last.group('a') + last.group('b'))

  def batch(self, path: str):
    """(batch id, project id) if it's a batch's folder"""
    if path in self.batch_overrides:
      return self.batch_overrides[path]
    info = self.commit_for(path)
    return info['batch_dirs'].get(path) if info else None

  def artifacts(self, path: str):
    info = self.commit_for(path)
    return info['artifacts_dirs'].get(path) if info else None

  def runs_of(self, batch_id: int) -> dict:
    if batch_id not in self.batch_runs:
      runs = {}
      batch = self.session.get(Batch, batch_id)
      if batch is not None:
        batch_dir = batch.batch_dir
        for output in self.session.query(Output).filter(Output.batch_id == batch_id):
          runs[str(output.get_output_dir(batch_dir))] = (output.id, bool(output.deleted))
      self.session.rollback()
      self.session.expunge_all()
      if len(self.batch_runs) > 2000:
        self.batch_runs.clear()
      self.batch_runs[batch_id] = runs
    return self.batch_runs[batch_id]

  def run(self, path: str, batch_id: Optional[int]):
    """(output id, deleted) if it's a run's folder"""
    if batch_id is not None:
      found = self.runs_of(batch_id).get(path)
      if found:
        return found
    row = self.session.execute(text("SELECT id, deleted FROM outputs WHERE output_dir_override = :path LIMIT 1"), {"path": path}).first()
    self.session.rollback()
    return (row[0], bool(row[1])) if row else None


class Stopped(Exception):
  """The job was cancelled, or the worker is stopping: the threads give up their folder"""


class Scanner:
  def __init__(self, scan_id: int, params: dict, report: Reporter, exports: dict, batch_overrides: dict):
    from sqlalchemy.orm import scoped_session, sessionmaker
    # the threads look things up in the database: their own connections, not the web app's pool
    self.engine = make_engine(pool_size=params['threads'] + 1, max_overflow=params['threads'])
    self.sessions = scoped_session(sessionmaker(bind=self.engine))
    self.scan_id = scan_id
    self.min_bytes = int(params['min_size_mb'] * 1000 * 1000)
    self.exclude = params['exclude_paths']
    self.report = report
    self.exports = exports
    self.batch_overrides = batch_overrides
    self.seen = set()  # hard links
    self.lock = threading.Lock()
    self.local = threading.local()
    self.errors = 0
    self.stop = threading.Event()
    self.dirs = 0  # folders read: the progress while the big folders take hours

  def read(self, path: str) -> list:
    if self.stop.is_set():
      raise Stopped()
    with os.scandir(path) as listing:
      children = list(listing)
    with self.lock:
      self.dirs += 1
    return children

  def known(self) -> Known:
    if not hasattr(self.local, 'known'):
      self.local.known = Known(self.sessions, self.exports, self.batch_overrides)
      self.local.entries = []
    return self.local.known

  def excluded(self, path: str) -> bool:
    import fnmatch
    return any(fnmatch.fnmatch(path, pattern) for pattern in self.exclude)

  def entry(self, path, parent, depth, is_dir, kind, totals: Totals, owner_uid=None, ref=None, small=None):
    owners = totals.owners_by_name(limit=10)
    self.local.entries.append({
      "scan_id": self.scan_id, "path": path, "parent": parent, "name": os.path.basename(path) or path, "depth": depth,
      "is_dir": is_dir, "kind": kind, "bytes": totals.bytes, "files": totals.files,
      "newest_mtime": datetime.datetime.utcfromtimestamp(totals.newest) if totals.newest else None,
      "owners": owners, "owner": owner(owner_uid) if owner_uid is not None else (next(iter(owners), None)),
      "ref": ref or {}, "small": small or {}, "kinds": totals.kinds,
    })
    if len(self.local.entries) >= FLUSH_EVERY:
      self.flush()

  def flush(self):
    entries = getattr(self.local, 'entries', None)
    if not entries:
      return
    with self.engine.begin() as connection:
      connection.execute(text("""
        INSERT INTO storage_scan_entries (scan_id, path, parent, name, depth, is_dir, kind, bytes, files, newest_mtime, owners, owner, kinds, ref, small)
        VALUES (:scan_id, :path, :parent, :name, :depth, :is_dir, :kind, :bytes, :files, :newest_mtime,
                CAST(:owners AS jsonb), :owner, CAST(:kinds AS jsonb), CAST(:ref AS jsonb), CAST(:small AS jsonb))
        ON CONFLICT (scan_id, path) DO UPDATE SET parent = EXCLUDED.parent, name = EXCLUDED.name, depth = EXCLUDED.depth,
          is_dir = EXCLUDED.is_dir, kind = EXCLUDED.kind, bytes = EXCLUDED.bytes, files = EXCLUDED.files, newest_mtime = EXCLUDED.newest_mtime,
          owners = EXCLUDED.owners, owner = EXCLUDED.owner, kinds = EXCLUDED.kinds, ref = EXCLUDED.ref, small = EXCLUDED.small
      """), [{**e, "owners": _json(e['owners']), "kinds": _json(e['kinds']), "ref": _json(e['ref']), "small": _json(e['small'])} for e in entries])
    self.local.entries = []

  def classify(self, path: str, names: set, batch: Optional[tuple]):
    """(kind, ref) of a folder, from its files and what QA-Board knows. `batch`: the batch whose folder it's in."""
    known = self.known()
    batch_id = batch[0] if batch else None
    if 'run.json' in names or 'manifest.outputs.json' in names:
      run = known.run(path, batch_id)
      if run:
        return ('deleted_run' if run[1] else 'run'), {"output_id": run[0], **({"batch_id": batch_id} if batch_id else {})}
      return 'untracked_run', {**({"batch_id": batch_id, "project_id": batch[1]} if batch else {})}
    if any(marker in names for marker in MARKERS):
      export_id = self.exports.get(path)
      return ('export', {"export_id": export_id}) if export_id else ('untracked_export', {})
    if 'manifests' in names:
      artifacts = known.artifacts(path)
      if artifacts:
        return ('deleted_artifacts' if artifacts[2] else 'artifacts'), {"commit_id": artifacts[0], "project_id": artifacts[1]}
    found = known.batch(path)
    if found:
      return 'batch', {"batch_id": found[0], "project_id": found[1]}
    return 'folder', {}

  def walk(self, path: str, parent: Optional[str], depth: int, batch: Optional[tuple]) -> Totals:
    """Everything in the folder, classified. Stores the entries that are big enough, or at the top."""
    totals = Totals()
    if os.path.basename(path) in SNAPSHOTS or self.excluded(path):
      return totals
    try:
      children = self.read(path)
      own = os.lstat(path)
    except OSError as e:
      with self.lock:
        self.errors += 1
        if self.errors <= 200:
          self.report.error('permission' if isinstance(e, PermissionError) else 'other', f"Could not read {path}: {e}", path=path)
      return totals
    names = {c.name for c in children}
    kind, ref = self.classify(path, names, batch)
    if kind in LEAVES:
      for child in children:
        self.add_tree(child, totals, kind)
      self.entry(path, parent, depth, True, kind, totals, own.st_uid, ref)
      return totals
    if kind == 'batch':
      batch = (ref['batch_id'], ref['project_id'])
    small = {"bytes": 0, "files": 0, "entries": 0}
    for child in children:
      try:
        if child.is_dir(follow_symlinks=False):
          child_totals = self.walk(child.path, path, depth + 1, batch)
          if child_totals.bytes < self.min_bytes and depth + 1 > 1:
            small["bytes"] += child_totals.bytes
            small["files"] += child_totals.files
            small["entries"] += 1
          totals.merge(child_totals)
        else:
          file_totals = Totals()
          # files right in a batch's folder are the batch's (logs...)
          file_totals.add_file(child.stat(follow_symlinks=False), 'batch' if kind == 'batch' else 'untracked_files', self.seen)
          if file_totals.bytes >= self.min_bytes and self.min_bytes > 0:
            self.entry(child.path, path, depth + 1, False, 'file', file_totals, None, {})
          else:
            small["bytes"] += file_totals.bytes
            small["files"] += file_totals.files
          totals.merge(file_totals)
      except OSError:
        with self.lock:
          self.errors += 1
    if depth <= 1 or totals.bytes >= self.min_bytes:
      self.entry(path, parent, depth, True, kind, totals, own.st_uid, ref, small if small["bytes"] or small["entries"] else None)
    return totals

  def add_tree(self, entry, totals: Totals, kind: str):
    """Everything under an entry counts as `kind`"""
    try:
      if entry.is_dir(follow_symlinks=False):
        if entry.name in SNAPSHOTS:
          return
        for child in self.read(entry.path):
          self.add_tree(child, totals, kind)
      else:
        totals.add_file(entry.stat(follow_symlinks=False), kind, self.seen)
    except OSError:
      with self.lock:
        self.errors += 1

  def subtree(self, path: str, root: str) -> Totals:
    """A thread's work: a folder at the top of a root"""
    try:
      batch = None
      totals = self.walk(path, root, 1, batch)
      self.flush()
      return totals
    finally:
      self.sessions.remove()


def _json(value):
  import json
  return json.dumps(value, default=str)


def merge_scan_totals(scan_id: int, totals: Totals):
  """Adds a finished part to the scan's totals, by kind and by owner (several threads do it)"""
  with engine.begin() as connection:
    row = connection.execute(text("SELECT totals FROM storage_scans WHERE id = :id FOR UPDATE"), {"id": scan_id}).scalar() or {}
    by_kind = row.get('by_kind') or {}
    for kind, size in totals.kinds.items():
      by_kind[kind] = by_kind.get(kind, 0) + size
    by_owner = row.get('by_owner') or {}
    for uid, kinds in totals.owners.items():
      name = owner(uid)
      mine = by_owner.setdefault(name, {})
      for kind, size in kinds.items():
        mine[kind] = mine.get(kind, 0) + size
    new = {**row, "by_kind": by_kind, "by_owner": by_owner, "bytes": (row.get('bytes') or 0) + totals.bytes, "files": (row.get('files') or 0) + totals.files}
    connection.execute(text("UPDATE storage_scans SET totals = CAST(:totals AS jsonb) WHERE id = :id"), {"id": scan_id, "totals": _json(new)})


def run(params: dict, report: Reporter):
  roots = top_folders([*params['roots'], *project_roots(params)])
  scan_id = report.progress.get('scan_id')
  scan = db_session.get(StorageScan, scan_id) if scan_id else None
  if scan is None:
    scan = StorageScan(job_id=getattr(report, 'job_id', None), roots=roots, status='running', created_at=utcnow(),
                       totals={}, min_bytes=int(params['min_size_mb'] * 1000 * 1000))
    db_session.add(scan)
    db_session.commit()
    report.set(scan_id=scan.id)
  scan_id = scan.id
  # owners are saved by name: with QABOARD_ACCOUNTS_COMMAND, wait for its accounts instead of saving "uid 2041".
  # Never a reason to fail: we use the accounts we have, and names saved as "uid 2041" are resolved when read.
  try:
    updated = accounts.refresh()
  except Exception as e:
    updated = False
    print(f"[scan] could not update the accounts: {e}")
  if not updated:
    report.log("Could not update the accounts (QABOARD_ACCOUNTS_COMMAND, see the backend's logs): we use the ones we have", level='warning')
  report.log(f"Scanning {len(roots)} folders: {', '.join(roots[:10])}{'…' if len(roots) > 10 else ''}")
  # small and shared by the threads: the exports QA-Board knows, and the batches with their own folder
  exports = {path: export_id for export_id, path in db_session.query(Export.id, Export.path).filter(Export.deleted_at.is_(None))}
  batch_overrides = {}
  for batch_id, batch_dir, project_id in db_session.execute(text("""
      SELECT b.id, b.batch_dir_override, c.project_id FROM batches b JOIN ci_commits c ON c.id = b.ci_commit_id
      WHERE b.batch_dir_override IS NOT NULL""")):
    batch_overrides[batch_dir.rstrip('/')] = (batch_id, project_id)
  db_session.commit()
  scanner = Scanner(scan_id, params, report, exports, batch_overrides)
  try:
    finished = scan_roots(roots, scan_id, scanner, params, report)
  finally:
    scanner.sessions.remove()
    scanner.engine.dispose()
  scan = db_session.get(StorageScan, scan_id)
  db_session.refresh(scan)
  if not finished:
    # the worker stopping (deploys) resumes it later: only a cancelled scan is over
    if getattr(report, 'cancelled', False):
      scan.status, scan.finished_at = 'cancelled', utcnow()
      db_session.commit()
    return
  scan.status = 'done'
  scan.finished_at = utcnow()
  scan.totals = {**(scan.totals or {}), "errors": scanner.errors}
  db_session.commit()
  untracked = sum(size for kind, size in (scan.totals.get('by_kind') or {}).items() if kind in UNTRACKED)
  report.log(f"Done: {_human(scan.totals.get('bytes', 0))} in {scan.totals.get('files', 0)} files, {_human(untracked)} QA-Board doesn't track")


def scan_roots(roots: list, scan_id: int, scanner: Scanner, params: dict, report: Reporter) -> bool:
  """False if it stopped before the end"""
  done = set(report.progress.get('done') or [])
  dirs_before = report.progress.get('dirs_explored') or 0
  report.set(roots_total=len(roots))
  for root in roots:
    if report.should_stop():
      return False
    try:
      check_storage_path(root)
    except UnsafePathError as e:
      report.error('unsafe_path', str(e), path=root)
      continue
    if not os.path.isdir(root):
      report.log(f"{root} doesn't exist", level='warning')
      continue
    try:
      with os.scandir(root) as listing:
        children = list(listing)
    except OSError as e:
      report.error('permission', f"Could not read {root}: {e}", path=root)
      continue
    # the files right in the root count with it, its folders are one task each (they're all stored, at depth 1)
    root_files = Totals()
    for child in children:
      if not child.is_dir(follow_symlinks=False):
        try:
          root_files.add_file(child.stat(follow_symlinks=False), 'untracked_files', scanner.seen)
        except OSError:
          pass
    if root.rstrip('/') + '/' not in done:
      merge_scan_totals(scan_id, root_files)
      done.add(root.rstrip('/') + '/')
    folders = [c.path for c in children if c.is_dir(follow_symlinks=False) and c.path not in done]
    report.add(folders_total=len(folders))
    with ThreadPoolExecutor(max_workers=params['threads']) as pool:
      futures = {pool.submit(scanner.subtree, folder, root): folder for folder in folders}
      pending = set(futures)
      while pending:
        # not only when a folder is done: a big one takes hours, we report and check for cancellations meanwhile
        finished, pending = wait(pending, timeout=PROGRESS_EVERY, return_when=FIRST_COMPLETED)
        for future in finished:
          folder = futures[future]
          try:
            totals = future.result()
          except Stopped:
            continue
          except Exception as e:
            report.error('other', f"Could not scan {folder}: {e}", path=folder)
            continue
          merge_scan_totals(scan_id, totals)
          done.add(folder)
          report.add(folders_done=1, bytes=totals.bytes, files=totals.files)
          report.set(done=sorted(done), current=folder)
        report.set(dirs_explored=dirs_before + scanner.dirs)
        if report.should_stop():
          # the threads stop at the next folder they read, the pool waits for them
          scanner.stop.set()
          for future in pending:
            future.cancel()
          break
    if scanner.stop.is_set():
      report.log(f"Stopped, after reading {dirs_before + scanner.dirs} folders", level='warning')
      return False
    with engine.begin() as connection:
      row = connection.execute(text("""
        SELECT coalesce(sum(bytes), 0), coalesce(sum(files), 0) FROM storage_scan_entries
        WHERE scan_id = :scan AND parent = :root AND is_dir"""), {"scan": scan_id, "root": root}).one()
    root_entry = Totals()
    root_entry.merge(root_files)
    root_entry.bytes += int(row[0])
    root_entry.files += int(row[1])
    with engine.begin() as connection:
      for (kinds,) in connection.execute(text("SELECT kinds FROM storage_scan_entries WHERE scan_id = :scan AND parent = :root AND is_dir"), {"scan": scan_id, "root": root}):
        for kind, size in (kinds or {}).items():
          root_entry.kinds[kind] = root_entry.kinds.get(kind, 0) + size
    scanner.known()
    scanner.entry(root, None, 0, True, 'folder', root_entry, os.lstat(root).st_uid, {"root": True},
                  {"bytes": root_files.bytes, "files": root_files.files, "entries": 0} if root_files.files else None)
    scanner.flush()
    report.add(roots_done=1)
  return True


def _human(size) -> str:
  for unit in ('B', 'KB', 'MB', 'GB', 'TB', 'PB'):
    if size < 1000 or unit == 'PB':
      return f"{size:.1f} {unit}"
    size /= 1000
