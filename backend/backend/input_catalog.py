"""
The SQL of inputs and collections (docs/design/inputs-and-collections.md). The rules are in backend/input_collections.py,
the API in api/inputs.py and api/collections.py, the tables in models/Collection.py.

Inputs are global (test_inputs). Which projects used which input is in `input_projects`, upserted when runs are
created (record_run): a project's Inputs tab reads it, never outputs, except for the "has runs that weren't deleted"
filter, an EXISTS from the projects' batches on the partial index outputs (test_input_id, batch_id) of runs not deleted.
Functions take the list of projects in scope (a project and the subprojects the user can read): the callers check
who can read what. Nothing here commits: the API does.
"""
import datetime
from typing import Dict, Iterable, List, Optional, Sequence

from .input_collections import like_escape, MAX_RUNS


def execute(sql: str, params: dict):
  from sqlalchemy import text
  from backend import db_session
  return db_session.execute(text(sql), params)


def rows_of(sql: str, params: dict) -> List[dict]:
  return [dict(row._mapping) if hasattr(row, '_mapping') else dict(row) for row in execute(sql, params).fetchall()]


def one_of(sql: str, params: dict) -> Optional[dict]:
  rows = rows_of(sql, params)
  return rows[0] if rows else None


def utcnow() -> datetime.datetime:
  return datetime.datetime.utcnow()


# Runs

RECORD_RUN = """
  INSERT INTO input_projects (test_input_id, project_id, first_run_at, last_run_at, runs)
  VALUES (:test_input_id, :project_id, :now, :now, :runs)
  ON CONFLICT (test_input_id, project_id) DO UPDATE
  SET last_run_at = GREATEST(input_projects.last_run_at, EXCLUDED.last_run_at), runs = input_projects.runs + EXCLUDED.runs
"""


def record_run(test_input_id: int, project_id: str, new_output: bool, now: Optional[datetime.datetime] = None):
  """A project ran on the input: one more run if it's a new output (runs aren't counted twice when they're updated)"""
  execute(RECORD_RUN, {"test_input_id": test_input_id, "project_id": project_id, "now": now or utcnow(), "runs": 1 if new_output else 0})


RECORD_RUN_LOCK_TIMEOUT = '2s'


def record_run_in_savepoint(session, test_input_id: int, project_id: str, new_output: bool = True,
                            now: Optional[datetime.datetime] = None) -> bool:
  """
  record_run in a savepoint of the session's transaction, for callers that save a run: if it fails (e.g. before the
  migration that adds input_projects), only it is undone and the run is still saved by the caller's commit. Never
  raises for it: whether it was recorded. Pending changes are flushed first, outside the savepoint: their errors are
  the caller's, as they would be at its commit.
  It waits at most RECORD_RUN_LOCK_TIMEOUT for the row: the migration's backfill, or a long transaction, holds it
  until it commits, and the run must not wait for it (it would time out). Not recorded then: the next run is.
  """
  session.flush()
  from sqlalchemy import text
  try:
    with session.begin_nested():
      # SET LOCAL lasts until the transaction ends, so we put back what it was. If the savepoint is rolled back, so is it
      before = session.execute(text("SELECT current_setting('lock_timeout')")).scalar()
      session.execute(text("SELECT set_config('lock_timeout', :timeout, true)"), {"timeout": RECORD_RUN_LOCK_TIMEOUT})
      record_run(test_input_id, project_id, new_output=new_output, now=now)
      session.execute(text("SELECT set_config('lock_timeout', :timeout, true)"), {"timeout": before})
    return True
  except Exception as e:
    print(f"WARNING: could not record that {project_id} used the input {test_input_id}: {e}")
    return False


# Projects

def scope_projects(project_id: str) -> List[str]:
  """The project and its subprojects, by path segments (a: a/b, not ab)"""
  rows = rows_of(
    "SELECT id FROM projects WHERE id = :project OR id LIKE :project_like ESCAPE '\\' ORDER BY id",
    {"project": project_id, "project_like": like_escape(project_id) + '/%'},
  )
  ids = [row['id'] for row in rows]
  return ids if project_id in ids else [project_id, *ids]


def project_exists(project_id: str) -> bool:
  return one_of("SELECT id FROM projects WHERE id = :project", {"project": project_id}) is not None


# Inputs

def scope_sql(projects: Sequence[str]) -> str:
  """The inputs of the projects, with their runs. One project: no aggregation, so ORDER BY last_run_at uses the index"""
  if len(projects) == 1:
    return "SELECT test_input_id, first_run_at, last_run_at, runs FROM input_projects WHERE project_id = :project_0"
  return """
    SELECT test_input_id, min(first_run_at) AS first_run_at, max(last_run_at) AS last_run_at, sum(runs)::int AS runs
    FROM input_projects WHERE project_id = ANY(:projects) GROUP BY test_input_id
  """


def projects_params(projects: Sequence[str]) -> dict:
  return {"projects": list(projects), "project_0": projects[0]}


# Driven by the scope: the projects' commits (ix on ci_commits.project_id), their batches, then one probe per batch in
# the partial index ix_outputs_live_test_input_id_batch_id (test_input_id, batch_id) WHERE deleted IS NOT TRUE, index only.
# Never by outputs.test_input_id alone: an input with millions of runs in other projects would read them all (seconds).
# Measured on 7.6M outputs, an input with 2.3M runs elsewhere and only deleted runs in scope: 3 ms (2.2 s by test_input_id).
LIVE = """EXISTS (
  SELECT 1 FROM ci_commits c JOIN batches b ON b.ci_commit_id = c.id JOIN outputs o ON o.batch_id = b.id
  WHERE c.project_id = ANY(:projects) AND o.test_input_id = ti.id AND o.deleted IS NOT TRUE
)"""


class InputFilters:
  """The WHERE clauses of the Inputs tab's filters, on test_inputs `ti`"""
  def __init__(self, tokens: Iterable[str] = (), folder: str = '', database: Optional[str] = None, live: bool = True):
    self.tokens = list(tokens)
    self.folder = folder or ''
    self.database = database or None
    self.live = live

  def params(self) -> dict:
    params = {f"token_{i}": f"%{like_escape(token)}%" for i, token in enumerate(self.tokens)}
    if self.folder:
      params['folder_like'] = like_escape(self.folder) + '/%'
    params['folder_prefix_length'] = len(self.folder) + 1 if self.folder else 0
    if self.database:
      params['database'] = self.database
    return params

  def search(self) -> List[str]:
    clauses = [f"ti.path ILIKE :token_{i} ESCAPE '\\'" for i in range(len(self.tokens))]
    if self.live:
      clauses.append(LIVE)
    return clauses

  def in_folder(self, alias: str = 'ti') -> List[str]:
    return [f"{alias}.path LIKE :folder_like ESCAPE '\\'"] if self.folder else []

  def in_database(self, alias: str = 'ti') -> List[str]:
    return [f"{alias}.database = :database"] if self.database else []


def where(clauses: List[str]) -> str:
  return ("WHERE " + " AND ".join(clauses)) if clauses else ""


INPUT_COLUMNS = "ti.id, ti.database, ti.path, ti.data, s.first_run_at, s.last_run_at, s.runs"
ORDERS = {
  'last_run': "s.last_run_at DESC, ti.id DESC",
  'path': "ti.path, ti.database, ti.id",
}
# facets: at most that many values
MAX_DATABASES = 200
MAX_FOLDERS = 1000


def list_inputs(projects: Sequence[str], filters: InputFilters, sort: str = 'last_run', limit: int = 100, offset: int = 0,
                with_facets: Optional[bool] = None) -> dict:
  """
  {inputs, total, databases: [{database, count}], folders: [{folder, name, count}]}: a page of the inputs of the
  projects. `folders` are the next level under filters.folder (counting the inputs under them), `databases` those of
  the inputs in the folder: each facet ignores its own filter, so that users can switch.
  The facets (total, databases, folders) cost more than a page (they read every input in scope): by default they are
  counted for the first page only (`with_facets` None: offset == 0), and are None on the next ones.
  """
  params = {**projects_params(projects), **filters.params(), "limit": limit, "offset": offset}
  scope = scope_sql(projects)
  page = rows_of(f"""
    WITH s AS ({scope})
    SELECT {INPUT_COLUMNS}
    FROM s JOIN test_inputs ti ON ti.id = s.test_input_id
    {where(filters.search() + filters.in_folder() + filters.in_database())}
    ORDER BY {ORDERS[sort]}
    LIMIT :limit OFFSET :offset
  """, params)
  if with_facets is None:
    with_facets = offset == 0
  if not with_facets:
    return {"inputs": page, "total": None, "databases": None, "folders": None}
  # The search and live filters once (EXISTS on outputs is the costly part), then the counts
  folder_name = "split_part(substr(m.path, :folder_prefix_length + 1), '/', 1)"
  facets = one_of(f"""
    WITH s AS ({scope}),
    m AS MATERIALIZED (
      SELECT ti.id, ti.database, ti.path FROM s JOIN test_inputs ti ON ti.id = s.test_input_id
      {where(filters.search())}
    )
    SELECT
      (SELECT count(*) FROM m {where(filters.in_folder('m') + filters.in_database('m'))}) AS total,
      (SELECT coalesce(json_agg(d), '[]') FROM (
        SELECT m.database, count(*) AS count FROM m {where(filters.in_folder('m'))}
        GROUP BY m.database ORDER BY count(*) DESC, m.database LIMIT {MAX_DATABASES}
      ) d) AS databases,
      (SELECT coalesce(json_agg(f), '[]') FROM (
        SELECT {folder_name} AS name, count(*) AS count FROM m
        {where(filters.in_folder('m') + filters.in_database('m') + ["strpos(substr(m.path, :folder_prefix_length + 1), '/') > 0"])}
        GROUP BY 1 ORDER BY 1 LIMIT {MAX_FOLDERS}
      ) f) AS folders
  """, params) or {}
  prefix = f"{filters.folder}/" if filters.folder else ''
  return {
    "inputs": page,
    "total": int(facets.get('total') or 0),
    "databases": [{"database": d['database'], "count": int(d['count'])} for d in facets.get('databases') or []],
    "folders": [{"folder": prefix + f['name'], "name": f['name'], "count": int(f['count'])} for f in facets.get('folders') or []],
  }


def input_by_id(input_id: int) -> Optional[dict]:
  return one_of("SELECT id, database, path, data FROM test_inputs WHERE id = :id", {"id": input_id})


def input_in_scope(input_id: int, projects: Sequence[str]) -> Optional[dict]:
  """The input with its runs in the projects, None if they never ran on it"""
  return one_of(f"""
    WITH s AS ({scope_sql(projects)})
    SELECT {INPUT_COLUMNS} FROM s JOIN test_inputs ti ON ti.id = s.test_input_id WHERE ti.id = :id
  """, {**projects_params(projects), "id": input_id})


def input_stats(input_id: int, projects: Sequence[str]) -> dict:
  return one_of("""
    SELECT min(first_run_at) AS first_run_at, max(last_run_at) AS last_run_at, coalesce(sum(runs), 0)::int AS runs
    FROM input_projects WHERE test_input_id = :id AND project_id = ANY(:projects)
  """, {"id": input_id, "projects": list(projects)}) or {}


def in_collections_of(input_id: int, collection_projects: Sequence[str]) -> bool:
  """Whether a version of a collection of the projects has the input (e.g. collections of an ancestor seen from a subproject)"""
  return one_of("""
    SELECT 1 AS found FROM collection_members m
    JOIN collection_versions v ON v.id = m.version_id JOIN collections c ON c.id = v.collection_id
    WHERE m.test_input_id = :id AND c.project_id = ANY(:projects) LIMIT 1
  """, {"id": input_id, "projects": list(collection_projects)}) is not None


def input_runs(input_id: int, projects: Sequence[str], limit: int = MAX_RUNS) -> List[dict]:
  """The latest runs of the projects on the input, deleted or not"""
  return rows_of("""
    SELECT o.id, b.label AS batch, c.hexsha AS commit, c.branch, c.project_id AS project,
           o.data->>'user' AS "user", coalesce(o.data->>'origin', b.origin) AS origin, o.created_date,
           coalesce(o.deleted, false) AS deleted, coalesce(o.is_failed, false) AS is_failed,
           coalesce(o.is_pending, false) AS is_pending, coalesce(o.is_running, false) AS is_running,
           o.platform, o.configurations, o.output_dir_override
    FROM outputs o JOIN batches b ON b.id = o.batch_id JOIN ci_commits c ON c.id = b.ci_commit_id
    WHERE o.test_input_id = :id AND c.project_id = ANY(:projects)
    ORDER BY o.created_date DESC NULLS LAST, o.id DESC
    LIMIT :limit
  """, {"id": input_id, "projects": list(projects), "limit": limit})


def inputs_outside(input_ids: Sequence[int], projects: Sequence[str]) -> List[int]:
  """The inputs that no run of the projects used (or that don't exist), in their order"""
  if not input_ids:
    return []
  rows = rows_of("""
    SELECT DISTINCT test_input_id FROM input_projects
    WHERE test_input_id = ANY(:ids) AND project_id = ANY(:projects)
  """, {"ids": list(input_ids), "projects": list(projects)})
  found = {row['test_input_id'] for row in rows}
  return [i for i in input_ids if i not in found]


# Collections

COLLECTION_COLUMNS = """
  c.id, c.project_id, c.name, c.description, c.created_at, c.updated_at, c.archived_at, c.latest_version,
  v.size, u.id AS created_by_id, u.user_name AS created_by_user_name, u.full_name AS created_by_full_name
"""
COLLECTION_FROM = """
  FROM collections c
  LEFT JOIN collection_versions v ON v.collection_id = c.id AND v.version = c.latest_version
  LEFT JOIN users u ON u.id = c.created_by
"""


def collections_of(projects: Sequence[str], archived: bool = False) -> List[dict]:
  """The collections of the projects (a project and its ancestors), by name"""
  return rows_of(f"""
    SELECT {COLLECTION_COLUMNS} {COLLECTION_FROM}
    WHERE c.project_id = ANY(:projects) {'' if archived else 'AND c.archived_at IS NULL'}
    ORDER BY c.name, c.project_id
  """, {"projects": list(projects)})


def collection_by_id(collection_id: int, for_update: bool = False) -> Optional[dict]:
  if for_update:
    # locks the collection: one new version at a time
    execute("SELECT id FROM collections WHERE id = :id FOR UPDATE", {"id": collection_id})
  return one_of(f"SELECT {COLLECTION_COLUMNS} {COLLECTION_FROM} WHERE c.id = :id", {"id": collection_id})


def find_collection(projects: Sequence[str], name: str) -> Optional[dict]:
  """The collection named so in the first of the projects that has one (a project, then its ancestors), archived or not"""
  rows = rows_of(f"SELECT {COLLECTION_COLUMNS} {COLLECTION_FROM} WHERE c.project_id = ANY(:projects) AND c.name = :name",
                 {"projects": list(projects), "name": name})
  by_project = {row['project_id']: row for row in rows}
  return next((by_project[p] for p in projects if p in by_project), None)


def name_taken(project_id: str, name: str, except_id: Optional[int] = None) -> Optional[int]:
  row = one_of("SELECT id FROM collections WHERE project_id = :project AND name = :name AND id IS DISTINCT FROM :except_id",
               {"project": project_id, "name": name, "except_id": except_id})
  return row['id'] if row else None


INSERT_MEMBERS = """
  INSERT INTO collection_members (version_id, position, test_input_id)
  SELECT :version_id, t.position - 1, t.id FROM unnest(CAST(:ids AS integer[])) WITH ORDINALITY AS t(id, position)
"""


def insert_version(collection_id: int, version: int, input_ids: Sequence[int], notes: str, user_id: Optional[int], now: datetime.datetime) -> int:
  row = one_of("""
    INSERT INTO collection_versions (collection_id, version, created_by, created_at, notes, size)
    VALUES (:collection_id, :version, :user_id, :now, :notes, :size) RETURNING id
  """, {"collection_id": collection_id, "version": version, "user_id": user_id, "now": now, "notes": notes, "size": len(input_ids)})
  if input_ids:
    execute(INSERT_MEMBERS, {"version_id": row['id'], "ids": list(input_ids)})
  return row['id']


def create_collection(project_id: str, name: str, description: str, input_ids: Sequence[int], notes: str,
                      user_id: Optional[int], now: Optional[datetime.datetime] = None) -> int:
  """A new collection, with its version 1. Its id."""
  now = now or utcnow()
  row = one_of("""
    INSERT INTO collections (project_id, name, description, created_by, created_at, updated_at, latest_version)
    VALUES (:project, :name, :description, :user_id, :now, :now, 1) RETURNING id
  """, {"project": project_id, "name": name, "description": description, "user_id": user_id, "now": now})
  insert_version(row['id'], 1, input_ids, notes, user_id, now)
  return row['id']


class StaleVersion(Exception):
  def __init__(self, latest_version: int):
    super().__init__(f"The latest version is {latest_version}")
    self.latest_version = latest_version


def add_version(collection_id: int, base_version: int, input_ids: Sequence[int], notes: str, user_id: Optional[int],
                now: Optional[datetime.datetime] = None) -> int:
  """Saves version N+1 if `base_version` is still the latest (N), else raises StaleVersion. The new version's number."""
  now = now or utcnow()
  row = one_of("SELECT latest_version FROM collections WHERE id = :id FOR UPDATE", {"id": collection_id})
  if row is None:
    raise LookupError(collection_id)
  if row['latest_version'] != base_version:
    raise StaleVersion(row['latest_version'])
  version = row['latest_version'] + 1
  insert_version(collection_id, version, input_ids, notes, user_id, now)
  execute("UPDATE collections SET latest_version = :version, updated_at = :now WHERE id = :id", {"id": collection_id, "version": version, "now": now})
  return version


def update_collection(collection_id: int, fields: dict, now: Optional[datetime.datetime] = None):
  """`fields`: name, description, archived (True/False)"""
  sets, params = [], {"id": collection_id, "now": now or utcnow()}
  for column in ('name', 'description'):
    if column in fields:
      sets.append(f"{column} = :{column}")
      params[column] = fields[column]
  if 'archived' in fields:
    sets.append("archived_at = CASE WHEN :archived THEN coalesce(archived_at, :now) ELSE NULL END")
    params['archived'] = bool(fields['archived'])
  if not sets:
    return
  execute(f"UPDATE collections SET {', '.join(sets)}, updated_at = :now WHERE id = :id", params)


VERSION_COLUMNS = """
  v.id, v.version, v.created_at, v.notes, v.size,
  u.id AS created_by_id, u.user_name AS created_by_user_name, u.full_name AS created_by_full_name
"""


def versions_of(collection_id: int) -> List[dict]:
  return rows_of(f"""
    SELECT {VERSION_COLUMNS} FROM collection_versions v LEFT JOIN users u ON u.id = v.created_by
    WHERE v.collection_id = :id ORDER BY v.version DESC
  """, {"id": collection_id})


def version_of(collection_id: int, version: int) -> Optional[dict]:
  return one_of(f"""
    SELECT {VERSION_COLUMNS} FROM collection_versions v LEFT JOIN users u ON u.id = v.created_by
    WHERE v.collection_id = :id AND v.version = :version
  """, {"id": collection_id, "version": version})


def members(version_id: int, projects: Sequence[str], tokens: Iterable[str] = (), limit: int = 100, offset: int = 0) -> dict:
  """{inputs, total}: the inputs of a version, in their order, with their runs in the projects"""
  tokens = list(tokens)
  params = {"version_id": version_id, "projects": list(projects), "limit": limit, "offset": offset,
            **{f"token_{i}": f"%{like_escape(token)}%" for i, token in enumerate(tokens)}}
  search = "".join(f" AND ti.path ILIKE :token_{i} ESCAPE '\\'" for i in range(len(tokens)))
  # the page first, then its runs: the total counts members, not their runs (versions have up to MAX_MEMBERS)
  rows = rows_of(f"""
    SELECT p.position, p.id, p.database, p.path, p.data, s.first_run_at, s.last_run_at, coalesce(s.runs, 0) AS runs, p.total
    FROM (
      SELECT m.position, ti.id, ti.database, ti.path, ti.data, count(*) OVER () AS total
      FROM collection_members m JOIN test_inputs ti ON ti.id = m.test_input_id
      WHERE m.version_id = :version_id{search}
      ORDER BY m.position
      LIMIT :limit OFFSET :offset
    ) p
    LEFT JOIN LATERAL (
      SELECT min(ip.first_run_at) AS first_run_at, max(ip.last_run_at) AS last_run_at, sum(ip.runs)::int AS runs
      FROM input_projects ip WHERE ip.test_input_id = p.id AND ip.project_id = ANY(:projects)
    ) s ON true
    ORDER BY p.position
  """, params)
  if rows:
    total = int(rows[0]['total'])
  elif offset == 0:
    total = 0
  else:
    total = int((one_of(f"""
      SELECT count(*) AS total FROM collection_members m JOIN test_inputs ti ON ti.id = m.test_input_id
      WHERE m.version_id = :version_id{search}
    """, params) or {}).get('total') or 0)
  for row in rows:
    row.pop('total', None)
  return {"inputs": rows, "total": total}


def member_ids(version_id: int) -> set:
  return {row['test_input_id'] for row in rows_of("SELECT test_input_id FROM collection_members WHERE version_id = :version_id", {"version_id": version_id})}


def member_refs(version_id: int) -> List[dict]:
  """[{id, database, path}] of a version, in their order: what the CLI runs"""
  return rows_of("""
    SELECT ti.id, ti.database, ti.path FROM collection_members m JOIN test_inputs ti ON ti.id = m.test_input_id
    WHERE m.version_id = :version_id ORDER BY m.position
  """, {"version_id": version_id})


# Favorites and pins

def favorite_ids(user_id: Optional[int], collection_ids: Sequence[int]) -> set:
  if not user_id or not collection_ids:
    return set()
  rows = rows_of("SELECT collection_id FROM collection_favorites WHERE user_id = :user_id AND collection_id = ANY(:ids)",
                 {"user_id": user_id, "ids": list(collection_ids)})
  return {row['collection_id'] for row in rows}


def set_favorite(user_id: int, collection_id: int, favorite: bool, now: Optional[datetime.datetime] = None):
  if favorite:
    execute("""
      INSERT INTO collection_favorites (user_id, collection_id, created_at) VALUES (:user_id, :collection_id, :now)
      ON CONFLICT DO NOTHING
    """, {"user_id": user_id, "collection_id": collection_id, "now": now or utcnow()})
  else:
    execute("DELETE FROM collection_favorites WHERE user_id = :user_id AND collection_id = :collection_id",
            {"user_id": user_id, "collection_id": collection_id})


def pins_of(collection_ids: Sequence[int]) -> Dict[int, List[dict]]:
  """{collection id: [{id, name}]}: the groups it's pinned for, id None for everyone (first)"""
  if not collection_ids:
    return {}
  rows = rows_of("""
    SELECT p.collection_id, p.group_id, g.name FROM collection_pins p LEFT JOIN groups g ON g.id = p.group_id
    WHERE p.collection_id = ANY(:ids) ORDER BY p.collection_id, p.group_id NULLS FIRST
  """, {"ids": list(collection_ids)})
  pins: Dict[int, List[dict]] = {}
  for row in rows:
    pins.setdefault(row['collection_id'], []).append({"id": row['group_id'], "name": row['name']})
  return pins


def set_pin(collection_id: int, group_id: Optional[int], pinned: bool, user_id: Optional[int], now: Optional[datetime.datetime] = None) -> bool:
  """Pins or unpins it: whether it changed anything"""
  if pinned:
    # the unique index for everyone's pins is partial (group_id IS NULL): no ON CONFLICT target covers both
    result = execute("""
      INSERT INTO collection_pins (collection_id, group_id, pinned_by, created_at)
      SELECT :collection_id, CAST(:group_id AS integer), CAST(:user_id AS integer), :now
      WHERE NOT EXISTS (
        SELECT 1 FROM collection_pins WHERE collection_id = :collection_id AND group_id IS NOT DISTINCT FROM CAST(:group_id AS integer)
      )
      ON CONFLICT DO NOTHING
    """, {"collection_id": collection_id, "group_id": group_id, "user_id": user_id, "now": now or utcnow()})
  else:
    result = execute("DELETE FROM collection_pins WHERE collection_id = :collection_id AND group_id IS NOT DISTINCT FROM CAST(:group_id AS integer)",
                     {"collection_id": collection_id, "group_id": group_id})
  return result.rowcount > 0


def group_ids_of(user_id: Optional[int]) -> List[int]:
  if not user_id:
    return []
  return [row['group_id'] for row in rows_of("SELECT group_id FROM group_members WHERE user_id = :user_id", {"user_id": user_id})]


def groups_of(user_id: Optional[int]) -> List[dict]:
  """[{id, name}] of the user's groups, by name"""
  if not user_id:
    return []
  return rows_of("""
    SELECT g.id, g.name FROM group_members m JOIN groups g ON g.id = m.group_id
    WHERE m.user_id = :user_id ORDER BY g.name, g.id
  """, {"user_id": user_id})


def group_exists(group_id: int) -> bool:
  return one_of("SELECT id FROM groups WHERE id = :id", {"id": group_id}) is not None
