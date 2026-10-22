"""
How much storage runs use: per batch and per user who ran them, in the `storage_usage` table, so that users see
their usage across projects, batches, commits, branches and folders without adding up millions of runs.

- The size of a run is what `qa` measured when it ended: Output.data.storage (bytes). Deleted runs don't count.
- The table is kept up to date by the jobs worker (backend/jobs/worker.py): every few minutes, the batches of commits
  with new runs. Changes made through QA-Board (deletions, moves...) refresh their batches right away. A full rebuild
  (the "storage_usage" job) catches the rest, e.g. nightly.
- A row's `folder` is the folder that contains all its runs: users find the runs there, and quota alerts name folders.

Nothing here depends on the web framework: api/storage.py is a thin layer over these functions.
"""
import os
import re
import datetime
from typing import Iterable, List, Optional

from sqlalchemy import text

from .database import db_session


CHUNK = 2_000


def utcnow():
  return datetime.datetime.utcnow()


def common_folder(batch_dir: Optional[str], has_default_dirs: bool, min_override: Optional[str], max_override: Optional[str]) -> Optional[str]:
  """
  The folder containing all the runs of a group: those saved in the batch's folder, and those saved elsewhere.
  The common prefix of many paths is the common prefix of the smallest and largest, in alphabetical order.
  """
  paths = []
  if has_default_dirs and batch_dir:
    paths.append(str(batch_dir))
  if min_override:
    if min_override == max_override:
      paths.append(min_override.rstrip('/') or '/')
    else:
      prefix = os.path.commonprefix([min_override, max_override])
      # "/a/b/run1" and "/a/b/run2" share "/a/b/run": the folder is "/a/b"
      folder = prefix.rstrip('/') if prefix.endswith('/') else os.path.dirname(prefix)
      paths.append(folder or '/')
  paths = [p for p in paths if p.startswith('/')]
  if not paths:
    return None
  try:
    return os.path.commonpath(paths)
  except ValueError:
    return None


SIZE = "CASE WHEN o.data->>'{key}' ~ '^[0-9]+(\\.[0-9]+)?$' THEN (o.data->>'{key}')::numeric END"
AGGREGATE = """
  SELECT o.batch_id,
         coalesce(o.data->>'user', '') AS user_name,
         count(*) FILTER (WHERE o.deleted IS NOT TRUE) AS nb_runs,
         coalesce(sum(""" + SIZE.format(key='storage') + """) FILTER (WHERE o.deleted IS NOT TRUE), 0)::bigint AS bytes,
         count(*) FILTER (WHERE o.deleted IS TRUE) AS deleted_runs,
         coalesce(sum(""" + SIZE.format(key='storage_left') + """) FILTER (WHERE o.deleted IS TRUE), 0)::bigint AS deleted_bytes,
         count(*) FILTER (WHERE o.deleted IS TRUE AND (o.data->>'storage_left') IS NULL) AS deleted_unmeasured,
         max(o.created_date) AS last_run_at,
         min(o.output_dir_override) AS min_override,
         max(o.output_dir_override) AS max_override,
         bool_or(o.output_dir_override IS NULL) AS has_default_dirs
  FROM outputs o
  WHERE {where}
  GROUP BY o.batch_id, coalesce(o.data->>'user', '')
"""


def _refresh(where: str, params: dict, delete_where: str):
  """Recomputes the rows of the batches that `where` selects (on outputs `o`), and deletes those of `delete_where`"""
  from .models import Batch
  rows = db_session.execute(text(AGGREGATE.format(where=where)), params).mappings().all()
  batch_ids = sorted({r['batch_id'] for r in rows})
  meta = {}
  if batch_ids:
    for batch_id, label, batch_dir_override, commit_id, hexsha, branch, project_id in db_session.execute(text("""
        SELECT b.id, b.label, b.batch_dir_override, c.id, c.hexsha, c.branch, c.project_id
        FROM batches b JOIN ci_commits c ON c.id = b.ci_commit_id
        WHERE b.id = ANY(:ids)"""), {"ids": batch_ids}):
      meta[batch_id] = {"label": label or 'default', "batch_dir": batch_dir_override, "ci_commit_id": commit_id,
                        "hexsha": hexsha, "branch": branch, "project_id": project_id}
  # The folders of batches, by QA-Board's conventions, need their project's settings
  need_dirs = [b for b in {r['batch_id'] for r in rows if r['has_default_dirs']} if b in meta and not meta[b]['batch_dir']]
  for start in range(0, len(need_dirs), 500):
    for batch in Batch.query.filter(Batch.id.in_(need_dirs[start:start + 500])):
      try:
        meta[batch.id]['batch_dir'] = str(batch.batch_dir)
      except Exception:
        pass
  now = utcnow()
  values = [{
    "batch_id": r['batch_id'], "user_name": r['user_name'], "project_id": m['project_id'], "ci_commit_id": m['ci_commit_id'],
    "hexsha": m['hexsha'], "branch": m['branch'], "batch_label": m['label'], "nb_runs": r['nb_runs'], "bytes": r['bytes'],
    "folder": common_folder(m['batch_dir'], r['has_default_dirs'], r['min_override'], r['max_override']),
    "last_run_at": r['last_run_at'], "updated_at": now,
    "deleted_runs": r['deleted_runs'], "deleted_bytes": r['deleted_bytes'], "deleted_unmeasured": r['deleted_unmeasured'],
  } for r in rows if (m := meta.get(r['batch_id']))]
  db_session.execute(text(f"DELETE FROM storage_usage WHERE {delete_where}"), params)
  if values:
    db_session.execute(text("""
      INSERT INTO storage_usage (batch_id, user_name, project_id, ci_commit_id, hexsha, branch, batch_label, nb_runs, bytes, folder, last_run_at, updated_at, deleted_runs, deleted_bytes, deleted_unmeasured)
      VALUES (:batch_id, :user_name, :project_id, :ci_commit_id, :hexsha, :branch, :batch_label, :nb_runs, :bytes, :folder, :last_run_at, :updated_at, :deleted_runs, :deleted_bytes, :deleted_unmeasured)
      ON CONFLICT (batch_id, user_name) DO UPDATE SET
        deleted_runs = EXCLUDED.deleted_runs, deleted_bytes = EXCLUDED.deleted_bytes, deleted_unmeasured = EXCLUDED.deleted_unmeasured,
        project_id = EXCLUDED.project_id, ci_commit_id = EXCLUDED.ci_commit_id, hexsha = EXCLUDED.hexsha, branch = EXCLUDED.branch,
        batch_label = EXCLUDED.batch_label, nb_runs = EXCLUDED.nb_runs, bytes = EXCLUDED.bytes, folder = EXCLUDED.folder,
        last_run_at = EXCLUDED.last_run_at, updated_at = EXCLUDED.updated_at
    """), values)
  db_session.commit()
  return len(values)


def refresh_batches(batch_ids: Iterable[int]) -> int:
  """Recomputes the usage of these batches, e.g. after deleting runs. Commits."""
  ids = sorted({int(i) for i in batch_ids if i is not None})
  count = 0
  for start in range(0, len(ids), CHUNK):
    chunk = ids[start:start + CHUNK]
    count += _refresh("o.batch_id = ANY(:ids)", {"ids": chunk}, "batch_id = ANY(:ids)")
  return count


def refresh_soon(batch_ids: Iterable[int] = (), commit_ids: Iterable[int] = ()):
  """After changes in the web app (deletions, moves...): users see them right away. It never fails the change itself."""
  try:
    refresh_batches(batch_ids)
    refresh_commits(commit_ids)
  except Exception as e:
    db_session.rollback()
    print(f"WARNING: could not update the storage usage: {e}")


def refresh_commits(commit_ids: Iterable[int]) -> int:
  commit_ids = sorted({int(i) for i in commit_ids if i is not None})
  if not commit_ids:
    return 0
  batch_ids = [i for (i,) in db_session.execute(text("SELECT id FROM batches WHERE ci_commit_id = ANY(:ids)"), {"ids": commit_ids})]
  # batches that were deleted are removed by the foreign key; those left without runs here
  count = refresh_batches(batch_ids)
  db_session.execute(text("DELETE FROM storage_usage WHERE ci_commit_id = ANY(:ids) AND NOT (batch_id = ANY(:batch_ids))"), {"ids": commit_ids, "batch_ids": batch_ids})
  db_session.commit()
  return count


def refresh_range(start_id: int, end_id: int) -> int:
  """Recomputes the batches with ids in [start_id, end_id): what a full rebuild does, chunk by chunk"""
  return _refresh("o.batch_id >= :start AND o.batch_id < :end", {"start": start_id, "end": end_id}, "batch_id >= :start AND batch_id < :end")


def refresh_recent(since: datetime.datetime) -> int:
  """The batches of the commits that got runs since then (CiCommit.latest_output_datetime is indexed)"""
  commit_ids = [i for (i,) in db_session.execute(text("SELECT id FROM ci_commits WHERE latest_output_datetime >= :since"), {"since": since})]
  return refresh_commits(commit_ids)


def max_batch_id() -> int:
  return db_session.execute(text("SELECT coalesce(max(id), 0) FROM batches")).scalar()


def updated_at() -> Optional[datetime.datetime]:
  return db_session.execute(text("SELECT max(updated_at) FROM storage_usage")).scalar()


# --- queries ---

def like_escape(value: str) -> str:
  return value.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_')


def normalize_folder(folder: Optional[str]) -> Optional[str]:
  """"/algo/x/ " => "/algo/x". Only absolute paths."""
  if not folder:
    return None
  folder = folder.strip().replace('\\', '/')
  folder = re.sub(r'/+', '/', folder)
  if not folder.startswith('/'):
    raise ValueError("The folder must be an absolute path, e.g. /algo/project/outputs/alice")
  return folder.rstrip('/') or '/'


class Filters:
  """What users choose: whose runs, which projects, which folder, which branch, how old"""
  def __init__(self, user: Optional[str] = None, projects: Optional[List[str]] = None, allowed_projects: Optional[List[str]] = None,
               folder: Optional[str] = None, branch: Optional[str] = None, older_than_days: Optional[int] = None, search: Optional[str] = None):
    self.user = user
    self.projects = projects or []
    self.allowed_projects = allowed_projects  # None: all
    self.folder = normalize_folder(folder)
    self.branch = branch or None
    self.older_than_days = older_than_days
    self.search = (search or '').strip() or None

  def where(self, alias='u'):
    """SQL conditions and their parameters"""
    conditions, params = ["TRUE"], {}
    if self.user is not None:
      conditions.append(f"{alias}.user_name = :user")
      params['user'] = self.user
    if self.projects:
      conditions.append(f"{alias}.project_id = ANY(:projects)")
      params['projects'] = self.projects
    if self.allowed_projects is not None:
      conditions.append(f"{alias}.project_id = ANY(:allowed_projects)")
      params['allowed_projects'] = self.allowed_projects
    if self.folder:
      # in the folder, or in a parent folder: then only some of its runs may be in the folder
      if self.folder == '/':
        conditions.append(f"{alias}.folder LIKE '/%'")
      else:
        conditions.append(f"({alias}.folder = :folder OR {alias}.folder LIKE :folder_like ESCAPE '\\' OR :folder LIKE ({alias}.folder || '/%'))")
        params['folder'] = self.folder
        params['folder_like'] = like_escape(self.folder) + '/%'
    if self.branch:
      conditions.append(f"({alias}.branch = :branch OR {alias}.branch = 'origin/' || :branch)")
      params['branch'] = self.branch
    if self.older_than_days:
      conditions.append(f"{alias}.last_run_at < :older_than")
      params['older_than'] = utcnow() - datetime.timedelta(days=self.older_than_days)
    if self.search:
      conditions.append(f"({alias}.project_id ILIKE :search ESCAPE '\\' OR {alias}.branch ILIKE :search ESCAPE '\\' OR {alias}.batch_label ILIKE :search ESCAPE '\\' OR {alias}.hexsha LIKE :search_sha ESCAPE '\\')")
      params['search'] = f"%{like_escape(self.search)}%"
      params['search_sha'] = f"{like_escape(self.search.lower())}%"
    return " AND ".join(conditions), params

  def partial_sql(self, alias='u'):
    """Rows whose runs are only partly in the folder: their folder is a parent of it"""
    if not self.folder or self.folder == '/':
      return "FALSE"
    return f"({alias}.folder IS DISTINCT FROM :folder AND :folder LIKE ({alias}.folder || '/%'))"


def totals(filters: Filters) -> dict:
  where, params = filters.where()
  row = db_session.execute(text(f"""
    SELECT coalesce(sum(bytes), 0), coalesce(sum(nb_runs), 0), count(DISTINCT batch_id) FILTER (WHERE nb_runs > 0),
           count(DISTINCT ci_commit_id) FILTER (WHERE nb_runs > 0), count(DISTINCT project_id) FILTER (WHERE nb_runs > 0),
           coalesce(sum(deleted_runs), 0), coalesce(sum(deleted_bytes), 0), coalesce(sum(deleted_unmeasured), 0)
    FROM storage_usage u WHERE {where}"""), params).one()
  return {"bytes": int(row[0]), "runs": int(row[1]), "batches": row[2], "commits": row[3], "projects": row[4],
          "deleted": {"runs": int(row[5]), "bytes": int(row[6]), "unmeasured": int(row[7])}}


def by_project(filters: Filters, limit=500) -> list:
  where, params = filters.where()
  rows = db_session.execute(text(f"""
    SELECT project_id, sum(bytes), sum(nb_runs), count(DISTINCT batch_id) FILTER (WHERE nb_runs > 0),
           count(DISTINCT ci_commit_id) FILTER (WHERE nb_runs > 0), max(last_run_at), sum(deleted_runs), sum(deleted_bytes)
    FROM storage_usage u WHERE {where}
    GROUP BY project_id ORDER BY sum(bytes) DESC, sum(deleted_bytes) DESC LIMIT :limit"""), {**params, "limit": limit}).all()
  return [{"project_id": p, "bytes": int(b), "runs": int(r), "batches": nb, "commits": nc, "last_run_at": iso(last),
           "deleted": {"runs": int(dr), "bytes": int(db)}} for p, b, r, nb, nc, last, dr, db in rows]


def by_user(filters: Filters, limit=20) -> list:
  """Who uses the most: with their biggest project, to see where it goes"""
  where, params = filters.where()
  rows = db_session.execute(text(f"""
    WITH per_project AS (
      SELECT user_name, project_id, sum(bytes) AS bytes, sum(nb_runs) AS runs, count(DISTINCT batch_id) AS batches,
             count(DISTINCT ci_commit_id) AS commits, max(last_run_at) AS last_run_at
      FROM storage_usage u WHERE {where} AND u.nb_runs > 0
      GROUP BY user_name, project_id
    )
    SELECT user_name, sum(bytes), sum(runs), sum(batches), sum(commits), count(*), max(last_run_at),
           (array_agg(project_id ORDER BY bytes DESC))[1], max(bytes)
    FROM per_project
    GROUP BY user_name ORDER BY sum(bytes) DESC LIMIT :limit"""), {**params, "limit": limit}).all()
  return [{"user_name": u, "bytes": int(b), "runs": int(r), "batches": int(nb), "commits": int(nc), "projects": nprojects,
           "last_run_at": iso(last), "top_project": {"project_id": top, "bytes": int(top_bytes)}}
          for u, b, r, nb, nc, nprojects, last, top, top_bytes in rows]


def nb_users(filters: Filters) -> int:
  where, params = filters.where()
  return db_session.execute(text(f"SELECT count(DISTINCT user_name) FROM storage_usage u WHERE {where} AND u.nb_runs > 0"), params).scalar()


GROUPS = ('batch', 'commit', 'branch')
SORTS = {
  'size': 'bytes DESC',
  'oldest': 'last_run_at ASC NULLS FIRST',
  'newest': 'last_run_at DESC NULLS LAST',
  'runs': 'runs DESC',
}


def items(filters: Filters, group='batch', sort='size', limit=50, offset=0) -> dict:
  """Batches, commits or branches, the biggest first. Each has a `key` to select it for deletion."""
  where, params = filters.where()
  partial = filters.partial_sql()
  keys = {
    'batch': "u.batch_id",
    'commit': "u.ci_commit_id",
    'branch': "u.project_id, coalesce(u.branch, '')",
  }[group]
  columns = {
    'batch': "u.batch_id, min(u.project_id) AS project_id, min(u.ci_commit_id) AS ci_commit_id, min(u.hexsha) AS hexsha, min(u.branch) AS branch, min(u.batch_label) AS batch_label, min(u.folder) AS folder, 1 AS batches",
    'commit': "u.ci_commit_id, min(u.project_id) AS project_id, min(u.hexsha) AS hexsha, min(u.branch) AS branch, (array_agg(DISTINCT u.batch_label))[1:6] AS labels, count(DISTINCT u.batch_id) AS batches",
    'branch': "u.project_id, coalesce(u.branch, '') AS branch, count(DISTINCT u.ci_commit_id) AS commits, count(DISTINCT u.batch_id) AS batches, (array_agg(u.ci_commit_id ORDER BY u.last_run_at DESC NULLS LAST))[1] AS ci_commit_id, (array_agg(u.hexsha ORDER BY u.last_run_at DESC NULLS LAST))[1] AS hexsha",
  }[group]
  query = f"""
    SELECT {columns}, sum(u.bytes) AS bytes, sum(u.nb_runs) AS runs, max(u.last_run_at) AS last_run_at,
           bool_or({partial}) AS partial, (array_agg(DISTINCT u.user_name))[1:4] AS users, count(DISTINCT u.user_name) AS nb_users
    FROM storage_usage u WHERE {where} AND u.nb_runs > 0
    GROUP BY {keys}"""
  total = db_session.execute(text(f"SELECT count(*) FROM ({query}) g"), params).scalar()
  rows = db_session.execute(text(f"{query} ORDER BY {SORTS.get(sort, SORTS['size'])} LIMIT :limit OFFSET :offset"),
                            {**params, "limit": limit, "offset": offset}).mappings().all()
  answer = []
  for r in rows:
    item = {k: (iso(v) if isinstance(v, datetime.datetime) else int(v) if k in ('bytes', 'runs') else v) for k, v in r.items()}
    item['key'] = r['batch_id'] if group == 'batch' else r['ci_commit_id'] if group == 'commit' else [r['project_id'], r['branch']]
    answer.append(item)
  add_commits(answer)
  return {"items": answer, "total": total}


def first_line(message: Optional[str], max_length=200) -> Optional[str]:
  if not message:
    return None
  line = message.strip().split('\n', 1)[0].strip()
  return line if len(line) <= max_length else f"{line[:max_length - 1]}…"


def add_commits(items: list) -> None:
  """The commits of the items (for branches, the one with the latest runs): their message, author and date"""
  ids = sorted({i['ci_commit_id'] for i in items if i.get('ci_commit_id')})
  if not ids:
    return
  commits = {
    commit_id: {"message": first_line(message), "details": (message or '').strip()[:1000] or None, "author": author, "authored_at": iso(authored)}
    for commit_id, message, author, authored in db_session.execute(text(
      "SELECT id, message, committer_name, authored_datetime FROM ci_commits WHERE id = ANY(:ids)"), {"ids": ids})
  }
  for item in items:
    item['commit'] = commits.get(item.get('ci_commit_id'))


def deepest_folder(lowest: Optional[str], highest: Optional[str]) -> Optional[str]:
  """
  The deepest folder containing all the folders whose "<folder>/" sort between `lowest` and `highest`, e.g. the end of
  a chain of folders with only one subfolder. With the trailing "/", the common prefix of the first and last in
  alphabetical order is the common prefix of all of them.
  """
  if not lowest or not highest:
    return None
  prefix = os.path.commonprefix([lowest, highest])
  return prefix[:prefix.rfind('/')] or '/'


def common_root(filters: Filters) -> str:
  """The deepest folder that contains all the runs: where exploring them starts"""
  inner = Filters(filters.user, filters.projects, filters.allowed_projects, None, filters.branch, filters.older_than_days, filters.search)
  where, params = inner.where()
  lowest, highest = db_session.execute(text(f"""
    SELECT min(u.folder || '/'), max(u.folder || '/') FROM storage_usage u WHERE {where} AND u.folder LIKE '/%' AND u.nb_runs > 0"""), params).one()
  return deepest_folder(lowest, highest) or '/'


def folders(filters: Filters, path: Optional[str], limit=200) -> dict:
  """
  The subfolders of `path` with runs, the biggest first, e.g. to find the runs in the folder a quota alert names.
  `here`: runs right in the folder. `partial`: runs of batches whose folder contains `path`: some may be inside.
  Subfolders that only have one subfolder, and no runs right in them, are skipped: `path` is the deepest folder they
  lead to, and `name` the folders on the way (e.g. "a/b/c"). Without `path`, it starts from the deepest folder
  that contains all the runs (`skipped` says it skipped folders).
  """
  skipped = False
  if not path:
    path = common_root(filters)
    skipped = path != '/'
  path = normalize_folder(path) or '/'
  # the folder filter selects what's in `path`
  inner = Filters(filters.user, filters.projects, filters.allowed_projects, None, filters.branch, filters.older_than_days, filters.search)
  where, params = inner.where()
  start = 2 if path == '/' else len(path) + 2
  inside = "u.folder LIKE '/%'" if path == '/' else "u.folder LIKE :like ESCAPE '\\'"
  params = {**params, "path": path, "like": like_escape(path) + '/%', "start": start, "limit": limit}
  children = db_session.execute(text(f"""
    SELECT split_part(substr(u.folder, :start), '/', 1) AS name, sum(u.bytes), sum(u.nb_runs), count(DISTINCT u.batch_id),
           min(u.folder || '/'), max(u.folder || '/')
    FROM storage_usage u WHERE {where} AND {inside} AND u.nb_runs > 0
    GROUP BY 1 ORDER BY 2 DESC LIMIT :limit"""), params).all()
  here = db_session.execute(text(f"""
    SELECT coalesce(sum(u.bytes), 0), coalesce(sum(u.nb_runs), 0), count(DISTINCT u.batch_id) FROM storage_usage u
    WHERE {where} AND u.folder = :path AND u.nb_runs > 0"""), params).one()
  partial = db_session.execute(text(f"""
    SELECT coalesce(sum(u.bytes), 0), coalesce(sum(u.nb_runs), 0), count(DISTINCT u.batch_id) FROM storage_usage u
    WHERE {where} AND u.folder IS DISTINCT FROM :path AND :path LIKE (u.folder || '/%') AND u.nb_runs > 0"""), params).one() if path != '/' else (0, 0, 0)
  join = (lambda name: f"/{name}") if path == '/' else (lambda name: f"{path}/{name}")
  def child(name, size, runs, batches, lowest, highest):
    folder = join(name)
    deepest = deepest_folder(lowest, highest) or folder
    if not deepest.startswith(folder):
      deepest = folder
    return {"name": deepest[len(folder) - len(name):], "path": deepest, "bytes": int(size), "runs": int(runs), "batches": batches}
  return {
    "path": path,
    "skipped": skipped,
    "children": [child(*row) for row in children],
    "here": {"bytes": int(here[0]), "runs": int(here[1]), "batches": here[2]},
    "partial": {"bytes": int(partial[0]), "runs": int(partial[1]), "batches": partial[2]},
  }


def top_folders(filters: Filters, depth=4, limit=8) -> list:
  """The biggest folders `depth` levels deep, e.g. /algo/project/outputs/alice: where quota alerts usually point"""
  where, params = filters.where()
  rows = db_session.execute(text(f"""
    SELECT array_to_string((string_to_array(u.folder, '/'))[1:{int(depth) + 1}], '/') AS folder, sum(u.bytes), sum(u.nb_runs)
    FROM storage_usage u WHERE {where} AND u.folder LIKE '/%' AND u.nb_runs > 0
    GROUP BY 1 ORDER BY 2 DESC LIMIT :limit"""), {**params, "limit": limit}).all()
  return [{"path": f, "bytes": int(b), "runs": int(r)} for f, b, r in rows if f]


def selected_rows(filters: Filters, group: str, keys: Optional[list] = None, max_rows=100_000) -> list:
  """The rows (batch, user) of a selection: some batches, commits or branches, or all that match the filters"""
  where, params = filters.where()
  if keys is not None:
    if group == 'batch':
      where += " AND u.batch_id = ANY(:keys)"
      params['keys'] = [int(k) for k in keys]
    elif group == 'commit':
      where += " AND u.ci_commit_id = ANY(:keys)"
      params['keys'] = [int(k) for k in keys]
    elif group == 'branch':
      pairs = [(str(k[0]), str(k[1] or '')) for k in keys]
      where += " AND (u.project_id, coalesce(u.branch, '')) IN (SELECT * FROM unnest(CAST(:key_projects AS text[]), CAST(:key_branches AS text[])))"
      params['key_projects'] = [p for p, _ in pairs]
      params['key_branches'] = [b for _, b in pairs]
  return db_session.execute(text(f"""
    SELECT u.batch_id, u.user_name, u.project_id, u.ci_commit_id, u.hexsha, u.batch_label, u.nb_runs, u.bytes, u.folder
    FROM storage_usage u WHERE {where} AND u.nb_runs > 0 ORDER BY u.bytes DESC LIMIT :max_rows"""), {**params, "max_rows": max_rows}).mappings().all()


def iso(date):
  if not date:
    return None
  if date.tzinfo is not None:
    date = date.astimezone(datetime.timezone.utc).replace(tzinfo=None)
  return f"{date.isoformat()}Z"
