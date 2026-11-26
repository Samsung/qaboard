"""
The SQL of inputs and collections (docs/design/inputs-and-collections.md). The rules are in backend/input_collections.py,
the API in api/inputs.py and api/collections.py, the tables in models/Collection.py.

Inputs are global (test_inputs). Which projects have which input is in `input_projects`, upserted when runs are
created (record_run) and when inputs are added before any run (add_inputs): a project's Inputs tab reads it, never
outputs, except for the "has runs that weren't deleted" filter, an EXISTS from the projects' batches on the partial
index outputs (test_input_id, batch_id) of runs not deleted. Inputs added without runs (`runs` = 0) pass that filter:
it hides inputs whose runs were all deleted, not inputs that are waiting for their first run.
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
  from .clock import utcnow as now
  return now()


# Runs

# Inputs added before any run have runs = 0, and first_run_at/last_run_at are when they were added: the first run
# sets both to its own time (the Inputs tab sorts by last_run_at, "added" then "last run")
RECORD_RUN = """
  INSERT INTO input_projects (test_input_id, project_id, first_run_at, last_run_at, runs)
  VALUES (:test_input_id, :project_id, :now, :now, :runs)
  ON CONFLICT (test_input_id, project_id) DO UPDATE
  SET first_run_at = CASE WHEN input_projects.runs = 0 AND EXCLUDED.runs > 0 THEN EXCLUDED.first_run_at ELSE input_projects.first_run_at END,
      last_run_at = GREATEST(input_projects.last_run_at, EXCLUDED.last_run_at), runs = input_projects.runs + EXCLUDED.runs
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
    return "SELECT test_input_id, first_run_at, last_run_at, runs, runs AS fewest_runs FROM input_projects WHERE project_id = :project_0"
  # fewest_runs: 0 when a project of the scope added it before any run (the live filter keeps it)
  return """
    SELECT test_input_id, min(first_run_at) AS first_run_at, max(last_run_at) AS last_run_at, sum(runs)::int AS runs,
           min(runs) AS fewest_runs
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


# The full path of an input of `ti`, what users see: its database and its path joined (input_collections.full_path)
def full_path_sql(alias: str = 'ti') -> str:
  return (f"(CASE WHEN {alias}.database IN ('', '.') THEN {alias}.path "
          f"ELSE rtrim({alias}.database, '/') || '/' || ltrim({alias}.path, '/') END)")


def metadata_sql(alias: str = 'ti') -> str:
  """data.metadata of `ti`, as jsonb"""
  return f"({alias}.data::jsonb -> 'metadata')"


class InputFilters:
  """
  The WHERE clauses of the Inputs tab's filters, on test_inputs `ti`, or on `m` (columns id, database, path, full_path, meta).
  `folder`: absolute ('/data/night'), a prefix of the full paths; relative ('night', older links), of the paths.
  `metadata`: {key: [values as text]}: inputs whose data.metadata[key] is one of the values, for each key.
  """
  def __init__(self, tokens: Iterable[str] = (), folder: str = '', database: Optional[str] = None, live: bool = True,
               metadata: Optional[Dict[str, List[str]]] = None):
    self.tokens = list(tokens)
    self.folder = folder or ''
    self.database = database or None
    self.live = live
    self.metadata = dict(metadata or {})
    self.meta_keys = list(self.metadata)

  def params(self) -> dict:
    params = {f"token_{i}": f"%{like_escape(token)}%" for i, token in enumerate(self.tokens)}
    if self.folder:
      params['folder_like'] = like_escape(self.folder) + '/%'
    if self.database:
      params['database'] = self.database
    for i, key in enumerate(self.meta_keys):
      params[f'meta_key_{i}'] = key
      params[f'meta_values_{i}'] = list(self.metadata[key])
    return params

  def search(self) -> List[str]:
    # the full path: users search what they see, the database's folders too
    clauses = [f"{full_path_sql()} ILIKE :token_{i} ESCAPE '\\'" for i in range(len(self.tokens))]
    if self.live:
      # on the scope `s`: inputs added before any run have none to delete
      clauses.append(f"(s.fewest_runs = 0 OR {LIVE})")
    return clauses

  def in_folder(self, alias: str = 'ti') -> List[str]:
    if not self.folder:
      return []
    full = f"{alias}.full_path" if alias == 'm' else full_path_sql(alias)
    if self.folder.startswith('/'):
      return [f"{full} LIKE :folder_like ESCAPE '\\'"]
    # relative: of a relative database's full paths, or (older links) of the paths in their database
    return [f"({full} LIKE :folder_like ESCAPE '\\' OR {alias}.path LIKE :folder_like ESCAPE '\\')"]

  def in_database(self, alias: str = 'ti') -> List[str]:
    return [f"{alias}.database = :database"] if self.database else []

  def in_metadata(self, alias: str = 'ti') -> List[str]:
    """The metadata filters: every key, any of its values"""
    meta = f"{alias}.meta" if alias == 'm' else metadata_sql(alias)
    return [f"({meta} ->> :meta_key_{i}) = ANY(CAST(:meta_values_{i} AS text[]))"
            for i in range(len(self.meta_keys))]

  def narrow(self, alias: str = 'ti') -> List[str]:
    """All the filters but the search: folder, database, metadata"""
    return self.in_folder(alias) + self.in_database(alias) + self.in_metadata(alias)


def where(clauses: List[str]) -> str:
  return ("WHERE " + " AND ".join(clauses)) if clauses else ""


def common_folder(first: Optional[str], last: Optional[str]) -> str:
  """
  The deepest folder of every path between `first` and `last` (the smallest and largest paths, bytewise): the folder
  of their common prefix. '/data/a/x.png', '/data/b/y.png' => '/data'. '' when it's the root.
  """
  if first is None or last is None:
    return ''
  if first == last:
    return first.rpartition('/')[0]
  n = 0
  for a, b in zip(first, last):
    if a != b:
      break
    n += 1
  return first[:n].rpartition('/')[0]


INPUT_COLUMNS = "ti.id, ti.database, ti.path, ti.data, s.first_run_at, s.last_run_at, s.runs"
ORDERS = {
  'last_run': "s.last_run_at DESC, ti.id DESC",
  'path': f"{full_path_sql()}, ti.id",
}
# facets: at most that many values
MAX_DATABASES = 200
MAX_FOLDERS = 1000
# metadata facets: keys, values listed per key
MAX_METADATA_KEYS = 50
MAX_METADATA_FACET_VALUES = 20
MAX_METADATA_VALUE_LENGTH = 200


def list_inputs(projects: Sequence[str], filters: InputFilters, sort: str = 'last_run', limit: int = 100, offset: int = 0,
                with_facets: Optional[bool] = None) -> dict:
  """
  {inputs, total, root, location, here, folders: [{folder, name, count}], databases: [{database, count}], metadata}:
  a page of the inputs of the projects, and what to narrow them with.
  - Folders are of the inputs' full paths (database/path). `root`: the deepest folder of every match ignoring the
    folder filter, where the breadcrumb starts. `location`: the deepest folder of the matches in the folder (at least
    the folder: chains of single folders are skipped), `folders` the next level under it, `here` the inputs right in it.
  - `databases`: those of the matches in the folder. `metadata`: [{key, count, distinct, values: [{value, count}]}],
    the inputs' data.metadata, most common values first; a key's facet ignores its own filter, so users can add values.
  The facets cost more than a page (they read every input in scope): by default they are counted for the first page
  only (`with_facets` None: offset == 0), and are None on the next ones.
  """
  params = {**projects_params(projects), **filters.params(), "limit": limit, "offset": offset}
  scope = scope_sql(projects)
  page = rows_of(f"""
    WITH s AS ({scope})
    SELECT {INPUT_COLUMNS}
    FROM s JOIN test_inputs ti ON ti.id = s.test_input_id
    {where(filters.search() + filters.narrow())}
    ORDER BY {ORDERS[sort]}
    LIMIT :limit OFFSET :offset
  """, params)
  if with_facets is None:
    with_facets = offset == 0
  if not with_facets:
    return {"inputs": page, "total": None, "databases": None, "folders": None, "root": None, "location": None,
            "here": None, "metadata": None}
  return {"inputs": page, **facets_of(scope, params, filters)}


def facets_of(scope: str, params: dict, filters: InputFilters) -> dict:
  # The search and live filters once (EXISTS on outputs is the costly part), then the counts
  matches = f"""
    WITH s AS ({scope}),
    m AS MATERIALIZED (
      SELECT ti.id, ti.database, ti.path, {full_path_sql()} AS full_path,
             CASE WHEN jsonb_typeof({metadata_sql()}) = 'object' THEN {metadata_sql()} END AS meta
      FROM s JOIN test_inputs ti ON ti.id = s.test_input_id
      {where(filters.search())}
    )
  """
  # bytewise: the common prefix of the smallest and largest paths is that of every path (not with a language's collation)
  facets = one_of(f"""{matches}
    SELECT
      (SELECT count(*) FROM m {where(filters.narrow('m'))}) AS total,
      (SELECT json_build_array(min(m.full_path COLLATE "C"), max(m.full_path COLLATE "C")) FROM m
       {where(filters.in_database('m') + filters.in_metadata('m'))}) AS root,
      (SELECT json_build_array(min(m.full_path COLLATE "C"), max(m.full_path COLLATE "C")) FROM m {where(filters.narrow('m'))}) AS location,
      (SELECT coalesce(json_agg(d), '[]') FROM (
        SELECT m.database, count(*) AS count FROM m {where(filters.in_folder('m') + filters.in_metadata('m'))}
        GROUP BY m.database ORDER BY count(*) DESC, m.database LIMIT {MAX_DATABASES}
      ) d) AS databases,
      (SELECT coalesce(json_agg(r), '[]') FROM (WITH {metadata_values_sql(filters)}) r) AS metadata
  """, params) or {}
  root = common_folder(*(facets.get('root') or [None, None]))
  location = common_folder(*(facets.get('location') or [None, None]))
  # never above the folder users picked (a relative one has no full path: the location says where it is)
  if filters.folder.startswith('/') and len(location) < len(filters.folder):
    location = filters.folder
  # at the root (''): '/data/a.png' is in '/data', a relative database's 'inputs/a.png' in 'inputs'
  if location:
    level = {**params, "location_like": like_escape(location) + '/%', "location_length": len(location) + 1}
    rest, under = "substr(m.full_path, :location_length + 1)", ["m.full_path LIKE :location_like ESCAPE '\\'"]
  else:
    level, rest, under = params, "ltrim(m.full_path, '/')", []
  folders = one_of(f"""{matches}
    SELECT
      (SELECT coalesce(json_agg(f), '[]') FROM (
        SELECT split_part({rest}, '/', 1) AS name, bool_or(m.full_path LIKE '/%') AS absolute, count(*) AS count FROM m
        {where(filters.narrow('m') + under + [f"strpos({rest}, '/') > 0"])}
        GROUP BY 1, m.full_path LIKE '/%' ORDER BY 1 LIMIT {MAX_FOLDERS}
      ) f) AS folders,
      (SELECT count(*) FROM m {where(filters.narrow('m') + under + [f"strpos({rest}, '/') = 0"])}) AS here
  """, level) or {}
  def folder_of(f):
    return f"{location}/{f['name']}" if location else f"/{f['name']}" if f['absolute'] else f['name']
  return {
    "total": int(facets.get('total') or 0),
    "root": root,
    "location": location,
    "here": int(folders.get('here') or 0),
    "folders": [{"folder": folder_of(f), "name": f['name'], "count": int(f['count'])} for f in folders.get('folders') or []],
    "databases": [{"database": d['database'], "count": int(d['count'])} for d in facets.get('databases') or []],
    "metadata": metadata_facets(matches, params, filters, facets.get('metadata') or []),
  }


def metadata_values_sql(filters: InputFilters, key: bool = False) -> str:
  """
  The CTEs (to follow a WITH) of rows (key, count, distinct, value, value_count) of the data.metadata of `m`: the most common keys, and their most
  common values. With `key`, only the key :facet_key (`filters` are then the other keys' filters).
  """
  clauses = filters.in_folder('m') + filters.in_database('m') + filters.in_metadata('m')
  clauses.append(f"length(e.value) <= {MAX_METADATA_VALUE_LENGTH}")
  if key:
    clauses.append("e.key = :facet_key")
  return f"""
    v AS (
      SELECT e.key, e.value, count(*) AS count FROM m CROSS JOIN LATERAL jsonb_each_text(m.meta) e
      {where(clauses)} GROUP BY e.key, e.value
    ),
    k AS (
      SELECT key, sum(count)::int AS count, count(*)::int AS distinct FROM v GROUP BY key
      ORDER BY sum(count) DESC, key LIMIT {MAX_METADATA_KEYS}
    )
    SELECT k.key, k.count, k.distinct, ranked.value, ranked.count AS value_count FROM k JOIN (
      SELECT v.*, row_number() OVER (PARTITION BY v.key ORDER BY v.count DESC, v.value) AS rank FROM v
    ) ranked ON ranked.key = k.key
    WHERE ranked.rank <= {MAX_METADATA_FACET_VALUES}
  """


def metadata_facets(matches: str, params: dict, filters: InputFilters, rows: List[dict]) -> List[dict]:
  """
  [{key, count, distinct, values: [{value, count}]}]: the keys of the matches' data.metadata, the most common first,
  with their most common values, from `rows` (metadata_values_sql, counted with every filter). A key with a filter
  lists the values of the inputs that the other filters keep: users add values (one more query per filtered key).
  """
  for i, key in enumerate(filters.meta_keys):
    others = InputFilters(folder=filters.folder, database=filters.database,
                          metadata={k: v for k, v in filters.metadata.items() if k != key})
    # the other filters' parameters keep their names: rename them for this query
    sql = metadata_values_sql(others, key=True)
    names = {f":meta_key_{j}": f":other_key_{j}" for j in range(len(others.meta_keys))}
    names.update({f":meta_values_{j}": f":other_values_{j}" for j in range(len(others.meta_keys))})
    for old, new in sorted(names.items(), key=lambda kv: -len(kv[0])):
      sql = sql.replace(old, new)
    extra = {}
    for j, other in enumerate(others.meta_keys):
      extra[f"other_key_{j}"] = other
      extra[f"other_values_{j}"] = list(others.metadata[other])
    rows = [row for row in rows if row['key'] != key] + rows_of(f"{matches}, {sql}", {**params, **extra, "facet_key": key})
  facets: Dict[str, dict] = {}
  for row in rows:
    facet = facets.setdefault(row['key'], {"key": row['key'], "count": int(row['count']), "distinct": int(row['distinct']), "values": []})
    facet['values'].append({"value": row['value'], "count": int(row['value_count'])})
  for facet in facets.values():
    facet['values'].sort(key=lambda v: (-v['count'], v['value']))
  # the filtered keys too, when nothing has them anymore: users can remove their filter
  for key in filters.meta_keys:
    facets.setdefault(key, {"key": key, "count": 0, "distinct": 0, "values": []})
  return sorted(facets.values(), key=lambda f: (-f['count'], f['key']))


def list_input_ids(projects: Sequence[str], filters: InputFilters, sort: str = 'last_run', cap: int = 50_000) -> dict:
  """
  {ids, total, too_many}: the ids of every input that matches the filters, in the order of the list, for "Select all
  matching". At most `cap` ids: when more match, `too_many` is true, `ids` empty and `total` None (not counted).
  """
  params = {**projects_params(projects), **filters.params(), "limit": cap + 1}
  rows = rows_of(f"""
    WITH s AS ({scope_sql(projects)})
    SELECT ti.id
    FROM s JOIN test_inputs ti ON ti.id = s.test_input_id
    {where(filters.search() + filters.narrow())}
    ORDER BY {ORDERS[sort]}
    LIMIT :limit
  """, params)
  if len(rows) > cap:
    return {"ids": [], "total": None, "too_many": True}
  return {"ids": [int(row['id']) for row in rows], "total": len(rows), "too_many": False}


# Adding inputs before any run (api/inputs.py add_inputs): `qa inputs add`, qaboard.inputs.add()

ADD_TEST_INPUTS = """
  INSERT INTO test_inputs (database, path, data)
  SELECT t.database, t.path, '{}' FROM unnest(CAST(:databases AS text[]), CAST(:paths AS text[])) AS t(database, path)
  ON CONFLICT (database, path) DO NOTHING
"""
# metadata given when adding is merged into data.metadata, where runs write theirs (qaboard.yaml inputs.metadata; a
# run that sends its own replaces it, api/outputs.py). Inputs are shared by every project: see docs/warts.md.
MERGE_METADATA = """
  UPDATE test_inputs ti SET data = (
    coalesce(ti.data::jsonb, '{}'::jsonb)
    || jsonb_build_object('metadata', coalesce(ti.data::jsonb -> 'metadata', '{}'::jsonb) || t.metadata::jsonb)
  )::json
  FROM unnest(CAST(:databases AS text[]), CAST(:paths AS text[]), CAST(:metadatas AS text[])) AS t(database, path, metadata)
  WHERE ti.database = t.database AND ti.path = t.path AND t.metadata IS NOT NULL
"""
ADD_INPUT_PROJECTS = """
  INSERT INTO input_projects (test_input_id, project_id, first_run_at, last_run_at, runs)
  SELECT ti.id, :project, :now, :now, 0
  FROM unnest(CAST(:databases AS text[]), CAST(:paths AS text[])) AS t(database, path)
  JOIN test_inputs ti ON ti.database = t.database AND ti.path = t.path
  ON CONFLICT (test_input_id, project_id) DO NOTHING
  RETURNING test_input_id
"""


def add_inputs(project_id: str, inputs: Sequence[dict], now: Optional[datetime.datetime] = None) -> List[dict]:
  """
  Adds inputs to the project's, before any run: `inputs` [{database, path, metadata (a dict or None)}], cleaned and
  without duplicates. Inputs the project already has are left as they are (except their metadata, merged).
  [{id, database, path, new}] in their order: `new` if the project didn't have it.
  """
  if not inputs:
    return []
  import json
  params = {
    "project": project_id, "now": now or utcnow(),
    "databases": [i['database'] for i in inputs], "paths": [i['path'] for i in inputs],
    "metadatas": [json.dumps(i['metadata']) if i.get('metadata') else None for i in inputs],
  }
  execute(ADD_TEST_INPUTS, params)
  if any(m is not None for m in params['metadatas']):
    execute(MERGE_METADATA, params)
  new = {row['test_input_id'] for row in rows_of(ADD_INPUT_PROJECTS, params)}
  rows = rows_of("""
    SELECT ti.id, ti.database, ti.path FROM unnest(CAST(:databases AS text[]), CAST(:paths AS text[])) WITH ORDINALITY AS t(database, path, position)
    JOIN test_inputs ti ON ti.database = t.database AND ti.path = t.path ORDER BY t.position
  """, params)
  return [{**row, "new": row['id'] in new} for row in rows]


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


def in_collections_of(input_id: int, collection_projects: Sequence[str], user_id: Optional[int] = None) -> bool:
  """
  Whether a version of a collection of the projects that the user sees has the input (e.g. collections of an ancestor
  seen from a subproject): shared ones, and the user's own
  """
  return one_of(f"""
    SELECT 1 AS found FROM collection_members m
    JOIN collection_versions v ON v.id = m.version_id JOIN collections c ON c.id = v.collection_id
    WHERE m.test_input_id = :id AND c.project_id = ANY(:projects) AND {VISIBLE} LIMIT 1
  """, {"id": input_id, "projects": list(collection_projects), "user_id": user_id}) is not None


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

# Personal collections (shared false) are seen by their owner only: who created them. Shared ones by the project.
VISIBLE = "(c.shared OR c.created_by = :user_id)"

COLLECTION_COLUMNS = """
  c.id, c.project_id, c.name, c.description, c.created_at, c.updated_at, c.archived_at, c.latest_version, c.shared,
  v.size, u.id AS created_by_id, u.user_name AS created_by_user_name, u.full_name AS created_by_full_name,
  uv.id AS updated_by_id, uv.user_name AS updated_by_user_name, uv.full_name AS updated_by_full_name
"""
COLLECTION_FROM = """
  FROM collections c
  LEFT JOIN collection_versions v ON v.collection_id = c.id AND v.version = c.latest_version
  LEFT JOIN users u ON u.id = c.created_by
  LEFT JOIN users uv ON uv.id = v.created_by
"""


def collections_of(projects: Sequence[str], archived: bool = False, user_id: Optional[int] = None) -> List[dict]:
  """The collections of the projects (a project and its ancestors) the user sees, by name"""
  return rows_of(f"""
    SELECT {COLLECTION_COLUMNS} {COLLECTION_FROM}
    WHERE c.project_id = ANY(:projects) AND {VISIBLE} {'' if archived else 'AND c.archived_at IS NULL'}
    ORDER BY c.name, c.project_id
  """, {"projects": list(projects), "user_id": user_id})


def archived_count(projects: Sequence[str], user_id: Optional[int] = None) -> int:
  """How many archived collections of the projects the user sees: the web app offers to show them when there are some"""
  row = one_of(f"SELECT count(*) AS n FROM collections c WHERE c.project_id = ANY(:projects) AND {VISIBLE} AND c.archived_at IS NOT NULL",
               {"projects": list(projects), "user_id": user_id})
  return int((row or {}).get('n') or 0)


def collection_by_id(collection_id: int, for_update: bool = False) -> Optional[dict]:
  if for_update:
    # locks the collection: one new version at a time
    execute("SELECT id FROM collections WHERE id = :id FOR UPDATE", {"id": collection_id})
  return one_of(f"SELECT {COLLECTION_COLUMNS} {COLLECTION_FROM} WHERE c.id = :id", {"id": collection_id})


def find_collection(projects: Sequence[str], name: str, user_id: Optional[int] = None) -> Optional[dict]:
  """
  The collection named so in the first of the projects that has one the user sees (a project, then its ancestors),
  archived or not
  """
  rows = rows_of(f"SELECT {COLLECTION_COLUMNS} {COLLECTION_FROM} WHERE c.project_id = ANY(:projects) AND c.name = :name AND {VISIBLE}",
                 {"projects": list(projects), "name": name, "user_id": user_id})
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
                      user_id: Optional[int], now: Optional[datetime.datetime] = None, shared: bool = True) -> int:
  """A new collection, with its version 1, shared with the project or personal (its creator's). Its id."""
  now = now or utcnow()
  row = one_of("""
    INSERT INTO collections (project_id, name, description, created_by, created_at, updated_at, latest_version, shared)
    VALUES (:project, :name, :description, :user_id, :now, :now, 1, :shared) RETURNING id
  """, {"project": project_id, "name": name, "description": description, "user_id": user_id, "now": now, "shared": bool(shared)})
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
  """`fields`: name, description, shared, archived (True/False)"""
  sets, params = [], {"id": collection_id, "now": now or utcnow()}
  for column in ('name', 'description', 'shared'):
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
  search = "".join(f" AND {full_path_sql()} ILIKE :token_{i} ESCAPE '\\'" for i in range(len(tokens)))
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


def clear_pins(collection_id: int) -> int:
  """Removes its pins, e.g. when it becomes personal: how many"""
  return execute("DELETE FROM collection_pins WHERE collection_id = :collection_id", {"collection_id": collection_id}).rowcount


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
