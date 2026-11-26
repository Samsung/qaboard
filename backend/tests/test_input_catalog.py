"""
The SQL of inputs and collections (backend/input_catalog.py), on a real PostgreSQL: set QABOARD_TEST_DATABASE_URL
(postgresql://user:password@host/db). It works in temporary tables, in a transaction that is rolled back: nothing is
written. The tables are those of the migration b8d0f2a4c6e1, and the columns of the others that the SQL reads.
"""
import os
import re
import json
import datetime
from types import SimpleNamespace

import pytest

from backend import input_catalog as catalog
from backend.input_catalog import InputFilters


NOW = datetime.datetime(2026, 11, 20, 12, 0, 0)


@pytest.fixture
def db(monkeypatch):
  url = os.environ.get('QABOARD_TEST_DATABASE_URL')
  if not url:
    pytest.skip("QABOARD_TEST_DATABASE_URL is not set")
  psycopg2 = pytest.importorskip('psycopg2')
  import psycopg2.extras
  connection = psycopg2.connect(url)
  try:
    cursor = connection.cursor(cursor_factory=psycopg2.extras.RealDictCursor)
    # Temporary tables hide the real ones, if any
    cursor.execute("""
      CREATE TEMPORARY TABLE projects (id text PRIMARY KEY) ON COMMIT DROP;
      CREATE TEMPORARY TABLE users (id serial PRIMARY KEY, user_name text, full_name text) ON COMMIT DROP;
      CREATE TEMPORARY TABLE groups (id serial PRIMARY KEY, name text) ON COMMIT DROP;
      CREATE TEMPORARY TABLE group_members (id serial PRIMARY KEY, group_id integer, user_id integer) ON COMMIT DROP;
      CREATE TEMPORARY TABLE test_inputs (id serial PRIMARY KEY, path text NOT NULL, database text NOT NULL, data json NOT NULL DEFAULT '{}', UNIQUE (database, path)) ON COMMIT DROP;
      CREATE TEMPORARY TABLE ci_commits (id serial PRIMARY KEY, hexsha text, project_id text REFERENCES projects (id), branch text) ON COMMIT DROP;
      CREATE TEMPORARY TABLE batches (id serial PRIMARY KEY, ci_commit_id integer, label text, origin text) ON COMMIT DROP;
      CREATE TEMPORARY TABLE outputs (
        id serial PRIMARY KEY, batch_id integer, test_input_id integer, created_date timestamp, deleted boolean,
        is_failed boolean, is_pending boolean, is_running boolean, platform text, configurations jsonb NOT NULL DEFAULT '[]',
        output_dir_override text, data json NOT NULL DEFAULT '{}'
      ) ON COMMIT DROP;
      CREATE INDEX ON outputs (test_input_id);
      CREATE INDEX ON outputs (test_input_id, batch_id) WHERE deleted IS NOT TRUE;

      CREATE TEMPORARY TABLE input_projects (
        test_input_id integer REFERENCES test_inputs (id) ON DELETE CASCADE,
        project_id text REFERENCES projects (id) ON DELETE CASCADE,
        first_run_at timestamp NOT NULL, last_run_at timestamp NOT NULL, runs integer NOT NULL DEFAULT 0,
        PRIMARY KEY (test_input_id, project_id)
      ) ON COMMIT DROP;
      CREATE INDEX ON input_projects (project_id, last_run_at DESC);
      CREATE TEMPORARY TABLE collections (
        id serial PRIMARY KEY, project_id text NOT NULL REFERENCES projects (id) ON DELETE CASCADE, name text NOT NULL,
        description text NOT NULL DEFAULT '', created_by integer REFERENCES users (id) ON DELETE SET NULL,
        created_at timestamp NOT NULL, updated_at timestamp NOT NULL, archived_at timestamp, latest_version integer NOT NULL DEFAULT 1,
        shared boolean NOT NULL DEFAULT true,
        CONSTRAINT uq_collections_project_id_name UNIQUE (project_id, name)
      ) ON COMMIT DROP;
      CREATE TEMPORARY TABLE collection_versions (
        id serial PRIMARY KEY, collection_id integer NOT NULL REFERENCES collections (id) ON DELETE CASCADE, version integer NOT NULL,
        created_by integer REFERENCES users (id) ON DELETE SET NULL, created_at timestamp NOT NULL, notes text NOT NULL DEFAULT '',
        size integer NOT NULL DEFAULT 0, UNIQUE (collection_id, version)
      ) ON COMMIT DROP;
      CREATE TEMPORARY TABLE collection_members (
        version_id integer REFERENCES collection_versions (id) ON DELETE CASCADE, position integer,
        test_input_id integer NOT NULL REFERENCES test_inputs (id) ON DELETE RESTRICT, region jsonb,
        PRIMARY KEY (version_id, position)
      ) ON COMMIT DROP;
      CREATE TEMPORARY TABLE collection_favorites (
        user_id integer REFERENCES users (id) ON DELETE CASCADE, collection_id integer REFERENCES collections (id) ON DELETE CASCADE,
        created_at timestamp NOT NULL, PRIMARY KEY (user_id, collection_id)
      ) ON COMMIT DROP;
      CREATE TEMPORARY TABLE collection_pins (
        id serial PRIMARY KEY, collection_id integer NOT NULL REFERENCES collections (id) ON DELETE CASCADE,
        group_id integer REFERENCES groups (id) ON DELETE CASCADE, pinned_by integer, created_at timestamp NOT NULL,
        UNIQUE (collection_id, group_id)
      ) ON COMMIT DROP;
      CREATE UNIQUE INDEX ON collection_pins (collection_id) WHERE group_id IS NULL;
    """)

    class Result:
      def __init__(self, rows, rowcount=-1):
        self.rows = rows
        self.rowcount = rowcount
      def fetchall(self):
        return self.rows

    def execute(sql, params):
      # sqlalchemy.text's :name parameters, as psycopg2's %(name)s
      cursor.execute(re.sub(r'(?<![:\w]):(\w+)', r'%(\1)s', sql.replace('%', '%%')), params)
      return Result([dict(row) for row in cursor.fetchall()] if cursor.description else [], cursor.rowcount)
    monkeypatch.setattr(catalog, "execute", execute)
    yield SimpleNamespace(cursor=cursor, connection=connection)
  finally:
    connection.rollback()
    connection.close()


def one(cursor, sql, *params):
  cursor.execute(sql, params)
  return cursor.fetchone()


def add_input(cursor, path, database='/data'):
  return one(cursor, "INSERT INTO test_inputs (database, path) VALUES (%s, %s) RETURNING id", database, path)['id']


def add_run(cursor, project, input_id, days_ago=1, deleted=False, label='default', user='alice'):
  """A run like api/outputs.py records it: the output, and input_projects"""
  cursor.execute("INSERT INTO projects (id) VALUES (%s) ON CONFLICT DO NOTHING", (project,))
  commit = one(cursor, "INSERT INTO ci_commits (hexsha, project_id, branch) VALUES (%s, %s, 'main') RETURNING id", f"sha-{project}", project)['id']
  batch = one(cursor, "INSERT INTO batches (ci_commit_id, label, origin) VALUES (%s, %s, 'ci') RETURNING id", commit, label)['id']
  when = NOW - datetime.timedelta(days=days_ago)
  output = one(cursor, """
    INSERT INTO outputs (batch_id, test_input_id, created_date, deleted, is_failed, platform, output_dir_override, data)
    VALUES (%s, %s, %s, %s, false, 'linux', '/storage/run', %s) RETURNING id
  """, batch, input_id, when, deleted, json.dumps({"user": user}))['id']
  catalog.record_run(input_id, project, new_output=True, now=when)
  return output


@pytest.fixture
def inputs(db):
  """
  Project a ran on night/street.png (/data), night/rain/1.png, night/rain/2.png, day/sun.png (deleted runs only)
  and on /other's night/street.png; its subproject a/b on b-only.png; ab (not a subproject) on ab.png
  """
  c = db.cursor
  ids = SimpleNamespace(
    street=add_input(c, 'night/street.png'), rain1=add_input(c, 'night/rain/1.png'), rain2=add_input(c, 'night/rain/2.png'),
    sun=add_input(c, 'day/sun.png'), other=add_input(c, 'night/street.png', '/other'), b_only=add_input(c, 'b-only.png'),
    ab=add_input(c, 'ab_100%.png'),
  )
  add_run(c, 'a', ids.street, days_ago=5)
  add_run(c, 'a', ids.street, days_ago=1)
  add_run(c, 'a', ids.rain1, days_ago=3)
  add_run(c, 'a', ids.rain2, days_ago=2)
  add_run(c, 'a', ids.sun, days_ago=4, deleted=True)
  add_run(c, 'a', ids.other, days_ago=6)
  add_run(c, 'a/b', ids.b_only, days_ago=0)
  add_run(c, 'ab', ids.ab, days_ago=0)
  return ids


# Runs

def test_record_run_counts_new_outputs(db, inputs):
  row = one(db.cursor, "SELECT * FROM input_projects WHERE test_input_id = %s AND project_id = 'a'", inputs.street)
  assert (row['runs'], row['first_run_at'], row['last_run_at']) == (2, NOW - datetime.timedelta(days=5), NOW - datetime.timedelta(days=1))
  # an update of a run: not one more, and it ran later
  catalog.record_run(inputs.street, 'a', new_output=False, now=NOW)
  row = one(db.cursor, "SELECT * FROM input_projects WHERE test_input_id = %s AND project_id = 'a'", inputs.street)
  assert (row['runs'], row['last_run_at']) == (2, NOW)
  # late updates don't move it back
  catalog.record_run(inputs.street, 'a', new_output=False, now=NOW - datetime.timedelta(days=9))
  assert one(db.cursor, "SELECT last_run_at FROM input_projects WHERE test_input_id = %s AND project_id = 'a'", inputs.street)['last_run_at'] == NOW


def test_add_inputs_before_any_run(db, inputs):
  added = catalog.add_inputs('a', [
    {"database": "/data", "path": "new/1.raw", "metadata": {"sensor": "imx766"}},
    {"database": "/data", "path": "night/street.png", "metadata": None},
    {"database": "/data", "path": "new/2.raw", "metadata": None},
  ], now=NOW)
  assert [(row['path'], row['new']) for row in added] == [('new/1.raw', True), ('night/street.png', False), ('new/2.raw', True)]
  assert added[1]['id'] == inputs.street
  # what the project knew is kept
  row = one(db.cursor, "SELECT * FROM input_projects WHERE test_input_id = %s AND project_id = 'a'", inputs.street)
  assert (row['runs'], row['last_run_at']) == (2, NOW - datetime.timedelta(days=1))
  new = one(db.cursor, "SELECT * FROM input_projects WHERE test_input_id = %s AND project_id = 'a'", added[0]['id'])
  assert (new['runs'], new['first_run_at'], new['last_run_at']) == (0, NOW, NOW)
  assert one(db.cursor, "SELECT data FROM test_inputs WHERE id = %s", added[0]['id'])['data'] == {"metadata": {"sensor": "imx766"}}
  # listed with "only inputs with runs": they have none to delete, they wait for their first run
  found = catalog.list_inputs(['a'], InputFilters(), sort='path')
  assert ('/data', 'new/1.raw') in paths(found) and ('/data', 'day/sun.png') not in paths(found)
  assert ('/data', 'new/1.raw') in [(r['database'], r['path']) for r in catalog.list_inputs(['a'], InputFilters(), with_facets=True)['inputs']]
  assert catalog.list_input_ids(['a'], InputFilters(), sort='path')['total'] == found['total']
  # metadata is merged, adding again doesn't make them new
  again = catalog.add_inputs('a', [{"database": "/data", "path": "new/1.raw", "metadata": {"scene": "night"}}], now=NOW)
  assert again[0]['new'] is False
  assert one(db.cursor, "SELECT data FROM test_inputs WHERE id = %s", added[0]['id'])['data'] == {"metadata": {"sensor": "imx766", "scene": "night"}}
  # the first run: its time, not the time it was added
  later = NOW + datetime.timedelta(days=3)
  catalog.record_run(added[0]['id'], 'a', new_output=True, now=later)
  new = one(db.cursor, "SELECT * FROM input_projects WHERE test_input_id = %s AND project_id = 'a'", added[0]['id'])
  assert (new['runs'], new['first_run_at'], new['last_run_at']) == (1, later, later)
  assert catalog.add_inputs('a', []) == []
  # merged: the keys sent replace those of before, from any project (docs/warts.md)
  catalog.add_inputs('ab', [{"database": "/data", "path": "new/1.raw", "metadata": {"sensor": "other", "lux": 3}}], now=NOW)
  assert one(db.cursor, "SELECT data FROM test_inputs WHERE id = %s", added[0]['id'])['data'] == {"metadata": {"sensor": "other", "scene": "night", "lux": 3}}


def test_inputs_added_to_one_project_of_the_scope_stay_live(db, inputs):
  # a/b ran on it, and its runs were deleted; a adds it before running on it
  add_run(db.cursor, 'a/b', inputs.sun, deleted=True)
  catalog.add_inputs('a', [{"database": "/data", "path": "day/sun.png", "metadata": None}], now=NOW)
  db.cursor.execute("UPDATE input_projects SET runs = 0 WHERE test_input_id = %s AND project_id = 'a'", (inputs.sun,))
  assert ('/data', 'day/sun.png') in paths(catalog.list_inputs(['a', 'a/b'], InputFilters()))
  assert ('/data', 'day/sun.png') not in paths(catalog.list_inputs(['a/b'], InputFilters()))


def test_scope_is_the_project_and_its_subprojects(db, inputs):
  assert catalog.scope_projects('a') == ['a', 'a/b']
  assert catalog.scope_projects('a/b') == ['a/b']
  # LIKE's wildcards are escaped
  db.cursor.execute("INSERT INTO projects (id) VALUES ('x_y'), ('xzy/sub'), ('x_y/sub')")
  assert catalog.scope_projects('x_y') == ['x_y', 'x_y/sub']
  # a project without runs yet
  assert catalog.scope_projects('new') == ['new']
  assert catalog.project_exists('a') and not catalog.project_exists('new')


# The Inputs tab

def paths(found):
  return [(row['database'], row['path']) for row in found['inputs']]


def test_list_live_inputs_latest_first(db, inputs):
  found = catalog.list_inputs(['a', 'a/b'], InputFilters())
  assert paths(found) == [('/data', 'b-only.png'), ('/data', 'night/street.png'), ('/data', 'night/rain/2.png'), ('/data', 'night/rain/1.png'), ('/other', 'night/street.png')]
  assert found['total'] == 5
  street = found['inputs'][1]
  # two projects: aggregated
  assert (street['runs'], street['first_run_at'], street['last_run_at']) == (2, NOW - datetime.timedelta(days=5), NOW - datetime.timedelta(days=1))
  assert found['databases'] == [{'database': '/data', 'count': 4}, {'database': '/other', 'count': 1}]
  # folders of the full paths: /data/night and /other/night aren't the same folder
  assert (found['root'], found['location'], found['here']) == ('', '', 0)
  assert found['folders'] == [{'folder': '/data', 'name': 'data', 'count': 4}, {'folder': '/other', 'name': 'other', 'count': 1}]


def test_list_one_project_with_deleted_runs(db, inputs):
  found = catalog.list_inputs(['a'], InputFilters(live=False), sort='path')
  assert paths(found) == [('/data', 'day/sun.png'), ('/data', 'night/rain/1.png'), ('/data', 'night/rain/2.png'), ('/data', 'night/street.png'), ('/other', 'night/street.png')]
  assert found['folders'] == [{'folder': '/data', 'name': 'data', 'count': 4}, {'folder': '/other', 'name': 'other', 'count': 1}]


def test_pages(db, inputs):
  page = catalog.list_inputs(['a'], InputFilters(live=False), sort='path', limit=2, offset=2)
  assert paths(page) == [('/data', 'night/rain/2.png'), ('/data', 'night/street.png')]
  # the facets are counted on the first page only, unless asked
  assert (page['total'], page['databases'], page['folders']) == (None, None, None)
  page = catalog.list_inputs(['a'], InputFilters(live=False), sort='path', limit=2, offset=2, with_facets=True)
  assert page['total'] == 5 and page['databases'] == [{'database': '/data', 'count': 4}, {'database': '/other', 'count': 1}]
  first = catalog.list_inputs(['a'], InputFilters(live=False), sort='path', limit=2, with_facets=False)
  assert len(first['inputs']) == 2 and first['total'] is None
  assert catalog.list_inputs(['a'], InputFilters(), limit=2, offset=100)['inputs'] == []


def test_ids_of_every_match(db, inputs):
  found = catalog.list_input_ids(['a', 'a/b'], InputFilters())
  listed = catalog.list_inputs(['a', 'a/b'], InputFilters(), limit=1000)
  # the list's order, every match
  assert found == {'ids': [i['id'] for i in listed['inputs']], 'total': 5, 'too_many': False}
  found = catalog.list_input_ids(['a'], InputFilters(live=False, folder='night', tokens=['rain']), sort='path')
  assert found['ids'] == [i['id'] for i in catalog.list_inputs(['a'], InputFilters(live=False, folder='night', tokens=['rain']), sort='path')['inputs']]
  assert found['total'] == 2
  # over the cap: none, so that users narrow the filters instead of saving a part
  assert catalog.list_input_ids(['a', 'a/b'], InputFilters(), cap=4) == {'ids': [], 'total': None, 'too_many': True}
  assert catalog.list_input_ids(['a', 'a/b'], InputFilters(), cap=5)['total'] == 5


def test_folders_are_the_next_level(db, inputs):
  found = catalog.list_inputs(['a'], InputFilters(folder='/data/night'))
  assert found['total'] == 3
  assert (found['root'], found['location'], found['here']) == ('', '/data/night', 1)
  assert found['folders'] == [{'folder': '/data/night/rain', 'name': 'rain', 'count': 2}]
  found = catalog.list_inputs(['a'], InputFilters(folder='/data/night/rain'))
  assert paths(found) == [('/data', 'night/rain/2.png'), ('/data', 'night/rain/1.png')] and found['folders'] == []
  assert (found['location'], found['here']) == ('/data/night/rain', 2)
  # not a folder of night/rain: night/rainy...
  assert catalog.list_inputs(['a'], InputFilters(folder='/data/night/rai'))['total'] == 0
  # relative folders (older links): of the paths in every database
  assert catalog.list_inputs(['a'], InputFilters(folder='night'))['total'] == 4


def test_the_folders_start_where_the_inputs_are(db, inputs):
  c = db.cursor
  for path in ('2024/night/cam0/1.png', '2024/night/cam0/2.png', '2024/night/cam1/1.png', '2024/day/cam0/1.png'):
    add_run(c, 'deep', add_input(c, path, '/mnt/data/projectX'))
  found = catalog.list_inputs(['deep'], InputFilters())
  # the common folder: no need to click through /mnt, /mnt/data...
  assert (found['root'], found['location'], found['here']) == ('/mnt/data/projectX/2024', '/mnt/data/projectX/2024', 0)
  assert [(f['folder'], f['count']) for f in found['folders']] == [('/mnt/data/projectX/2024/day', 1), ('/mnt/data/projectX/2024/night', 3)]
  # a folder with a single subfolder: skipped
  found = catalog.list_inputs(['deep'], InputFilters(folder='/mnt/data/projectX/2024/day'))
  assert (found['root'], found['location'], found['here'], found['folders']) == ('/mnt/data/projectX/2024', '/mnt/data/projectX/2024/day/cam0', 1, [])
  # the search reads the full path
  assert catalog.list_inputs(['deep'], InputFilters(tokens=['projectx', 'cam1']))['total'] == 1
  # relative databases next to absolute ones: their own folders at the root
  add_run(c, 'deep', add_input(c, 'x/1.png', 'inputs'))
  found = catalog.list_inputs(['deep'], InputFilters())
  assert (found['root'], [(f['folder'], f['count']) for f in found['folders']]) == ('', [('inputs', 1), ('/mnt', 4)])
  found = catalog.list_inputs(['deep'], InputFilters(folder='inputs'))
  assert (found['total'], found['location'], found['here']) == (1, 'inputs/x', 1)
  # the common prefix is a folder's: /a/bc and /a/bd are in /a, not /a/b
  for path in ('bc/1.png', 'bd/1.png'):
    add_run(c, 'siblings', add_input(c, path, '/a'))
  found = catalog.list_inputs(['siblings'], InputFilters())
  assert (found['root'], [f['name'] for f in found['folders']]) == ('/a', ['bc', 'bd'])


def test_metadata_filters_and_facets(db, inputs):
  c = db.cursor
  def with_metadata(path, metadata):
    i = add_input(c, path)
    c.execute("UPDATE test_inputs SET data = %s WHERE id = %s", (json.dumps({"metadata": metadata}), i))
    add_run(c, 'meta', i)
  with_metadata('1.png', {"weather": "rain", "iso": 100, "hdr": True})
  with_metadata('2.png', {"weather": "rain", "iso": 800})
  with_metadata('3.png', {"weather": "snow", "iso": 800, "note": "x" * 300})
  with_metadata('4.png', {})
  found = catalog.list_inputs(['meta'], InputFilters())
  facets = {f['key']: f for f in found['metadata']}
  assert list(facets) == ['iso', 'weather', 'hdr']
  assert facets['weather'] == {'key': 'weather', 'count': 3, 'distinct': 2, 'values': [{'value': 'rain', 'count': 2}, {'value': 'snow', 'count': 1}]}
  assert facets['iso']['values'] == [{'value': '800', 'count': 2}, {'value': '100', 'count': 1}]
  # values compared as text, any of a key's values, every key
  assert catalog.list_inputs(['meta'], InputFilters(metadata={'weather': ['rain', 'snow']}))['total'] == 3
  found = catalog.list_inputs(['meta'], InputFilters(metadata={'weather': ['rain'], 'iso': ['800']}))
  assert paths(found) == [('/data', '2.png')] and found['total'] == 1
  assert catalog.list_inputs(['meta'], InputFilters(metadata={'hdr': ['true']}))['total'] == 1
  # a filtered key lists the values the other filters keep: users add values
  facets = {f['key']: f for f in found['metadata']}
  assert facets['weather']['values'] == [{'value': 'rain', 'count': 1}, {'value': 'snow', 'count': 1}]
  assert facets['iso']['values'] == [{'value': '100', 'count': 1}, {'value': '800', 'count': 1}]
  assert catalog.list_input_ids(['meta'], InputFilters(metadata={'iso': ['800']}))['total'] == 2
  # a filter on a key nothing has: still listed, to remove it
  found = catalog.list_inputs(['meta'], InputFilters(metadata={'camera': ['a']}))
  assert found['total'] == 0 and found['metadata'][-1] == {'key': 'camera', 'count': 0, 'distinct': 0, 'values': []}


def test_databases_ignore_their_own_filter(db, inputs):
  found = catalog.list_inputs(['a'], InputFilters(database='/other'))
  assert paths(found) == [('/other', 'night/street.png')] and found['total'] == 1
  assert found['databases'] == [{'database': '/data', 'count': 3}, {'database': '/other', 'count': 1}]
  assert (found['root'], found['location'], found['here'], found['folders']) == ('/other/night', '/other/night', 1, [])


def test_search(db, inputs):
  assert paths(catalog.list_inputs(['a'], InputFilters(tokens=['RAIN', '2']))) == [('/data', 'night/rain/2.png')]
  assert catalog.list_inputs(['a'], InputFilters(tokens=['%']))['total'] == 0
  # LIKE's wildcards are searched literally
  found = catalog.list_inputs(['ab'], InputFilters(tokens=['_100%']))
  assert paths(found) == [('/data', 'ab_100%.png')]
  assert catalog.list_inputs(['ab'], InputFilters(tokens=['1_0']))['total'] == 0


def test_folders_with_like_wildcards(db, inputs):
  c = db.cursor
  odd = add_input(c, '50%_off/x.png')
  add_run(c, 'a', odd)
  assert paths(catalog.list_inputs(['a'], InputFilters(folder='50%_off'))) == [('/data', '50%_off/x.png')]
  assert catalog.list_inputs(['a'], InputFilters(folder='50%'))['total'] == 0
  assert paths(catalog.list_inputs(['a'], InputFilters(folder='/data/50%_off'))) == [('/data', '50%_off/x.png')]
  assert catalog.list_inputs(['a'], InputFilters(folder='/data/50%'))['total'] == 0


def test_an_input(db, inputs):
  row = catalog.input_in_scope(inputs.street, ['a', 'a/b'])
  assert (row['path'], row['runs']) == ('night/street.png', 2)
  assert catalog.input_in_scope(inputs.ab, ['a', 'a/b']) is None
  assert catalog.input_by_id(inputs.ab)['path'] == 'ab_100%.png'
  assert catalog.input_by_id(999999) is None
  assert catalog.input_stats(inputs.street, ['a/b']) == {'first_run_at': None, 'last_run_at': None, 'runs': 0}
  runs = catalog.input_runs(inputs.street, ['a', 'a/b'])
  assert [r['created_date'] for r in runs] == [NOW - datetime.timedelta(days=1), NOW - datetime.timedelta(days=5)]
  assert (runs[0]['project'], runs[0]['batch'], runs[0]['user'], runs[0]['origin'], runs[0]['deleted'], runs[0]['branch']) == ('a', 'default', 'alice', 'ci', False, 'main')
  assert catalog.input_runs(inputs.sun, ['a'])[0]['deleted'] is True
  assert catalog.input_runs(inputs.street, ['a/b']) == []


def test_inputs_outside(db, inputs):
  assert catalog.inputs_outside([inputs.street, inputs.b_only, inputs.ab, 999999], ['a', 'a/b']) == [inputs.ab, 999999]
  assert catalog.inputs_outside([], ['a']) == []


# Collections

@pytest.fixture
def people(db):
  db.cursor.execute("INSERT INTO users (id, user_name, full_name) VALUES (1, 'alice', 'Alice A'), (2, 'bob', 'Bob B')")
  db.cursor.execute("INSERT INTO groups (id, name) VALUES (5, 'night-team'), (6, 'day-team')")
  db.cursor.execute("INSERT INTO group_members (group_id, user_id) VALUES (5, 2)")


def test_create_and_version(db, inputs, people):
  collection_id = catalog.create_collection('a', 'night/hard', 'Hard ones', [inputs.rain2, inputs.street], 'first', 1, NOW)
  row = catalog.collection_by_id(collection_id)
  assert (row['project_id'], row['name'], row['latest_version'], row['size'], row['created_by_user_name'], row['archived_at']) == ('a', 'night/hard', 1, 2, 'alice', None)
  assert [r['id'] for r in catalog.member_refs(catalog.version_of(collection_id, 1)['id'])] == [inputs.rain2, inputs.street]

  # bob saves version 2
  assert catalog.add_version(collection_id, 1, [inputs.street, inputs.rain1, inputs.b_only], 'more', 2, NOW + datetime.timedelta(hours=1)) == 2
  row = catalog.collection_by_id(collection_id)
  assert (row['latest_version'], row['size'], row['updated_at'], row['created_by_user_name']) == (2, 3, NOW + datetime.timedelta(hours=1), 'alice')
  versions = catalog.versions_of(collection_id)
  assert [(v['version'], v['size'], v['notes'], v['created_by_user_name']) for v in versions] == [(2, 3, 'more', 'bob'), (1, 2, 'first', 'alice')]
  # version 1 didn't change
  v1 = catalog.version_of(collection_id, 1)
  assert catalog.member_ids(v1['id']) == {inputs.rain2, inputs.street}
  assert catalog.version_of(collection_id, 3) is None

  # someone saved meanwhile
  with pytest.raises(catalog.StaleVersion) as e:
    catalog.add_version(collection_id, 1, [], '', 1)
  assert e.value.latest_version == 2
  # an empty version is fine
  assert catalog.add_version(collection_id, 2, [], '', 1) == 3


def test_members_in_their_order_with_their_runs(db, inputs, people):
  collection_id = catalog.create_collection('a', 'mixed', '', [inputs.b_only, inputs.ab, inputs.street], '', 1, NOW)
  version_id = catalog.version_of(collection_id, 1)['id']
  found = catalog.members(version_id, ['a', 'a/b'])
  assert [(r['id'], r['position'], r['runs']) for r in found['inputs']] == [(inputs.b_only, 0, 1), (inputs.ab, 1, 0), (inputs.street, 2, 2)]
  assert found['total'] == 3 and found['inputs'][1]['last_run_at'] is None
  assert [r['id'] for r in catalog.members(version_id, ['a'], ['street'])['inputs']] == [inputs.street]
  page = catalog.members(version_id, ['a'], limit=1, offset=5)
  assert page == {'inputs': [], 'total': 3}
  assert catalog.members(version_id, ['a'], ['nothing'], offset=1) == {'inputs': [], 'total': 0}


def test_names_are_unique_per_project(db, inputs, people):
  catalog.create_collection('a', 'night', '', [], '', 1, NOW)
  assert catalog.name_taken('a', 'night') is not None and catalog.name_taken('a/b', 'night') is None
  db.cursor.execute("SAVEPOINT s")
  with pytest.raises(Exception):
    catalog.create_collection('a', 'night', '', [], '', 1, NOW)
  db.cursor.execute("ROLLBACK TO SAVEPOINT s")
  # the same name in a subproject is another collection
  catalog.create_collection('a/b', 'night', '', [], '', 1, NOW)


def test_find_the_nearest(db, inputs, people):
  db.cursor.execute("INSERT INTO projects (id) VALUES ('a/b/c')")
  in_a = catalog.create_collection('a', 'night', '', [], '', 1, NOW)
  in_b = catalog.create_collection('a/b', 'night', '', [], '', 1, NOW)
  assert catalog.find_collection(['a/b/c', 'a/b', 'a'], 'night')['id'] == in_b
  assert catalog.find_collection(['a'], 'night')['id'] == in_a
  assert catalog.find_collection(['a/b/c', 'a/b', 'a'], 'day') is None
  # archived ones resolve
  catalog.update_collection(in_b, {'archived': True}, NOW)
  assert catalog.find_collection(['a/b/c', 'a/b', 'a'], 'night')['id'] == in_b


def test_list_rename_archive(db, inputs, people):
  first = catalog.create_collection('a', 'night/hard', '', [inputs.street], '', 1, NOW)
  second = catalog.create_collection('a/b', 'b-only', '', [], '', 1, NOW)
  catalog.create_collection('ab', 'elsewhere', '', [], '', 1, NOW)
  assert [r['id'] for r in catalog.collections_of(['a/b', 'a'])] == [second, first]
  catalog.update_collection(first, {'name': 'night/harder', 'description': 'Harder', 'archived': True}, NOW + datetime.timedelta(hours=1))
  assert [r['id'] for r in catalog.collections_of(['a/b', 'a'])] == [second]
  row = [r for r in catalog.collections_of(['a/b', 'a'], archived=True) if r['id'] == first][0]
  assert (row['name'], row['description'], row['archived_at'], row['size']) == ('night/harder', 'Harder', NOW + datetime.timedelta(hours=1), 1)
  # archiving again keeps the date, unarchiving clears it
  catalog.update_collection(first, {'archived': True}, NOW + datetime.timedelta(hours=2))
  assert catalog.collection_by_id(first)['archived_at'] == NOW + datetime.timedelta(hours=1)
  catalog.update_collection(first, {'archived': False}, NOW)
  assert catalog.collection_by_id(first)['archived_at'] is None
  catalog.update_collection(first, {})
  assert catalog.collection_by_id(first, for_update=True)['id'] == first


def test_personal_collections_are_their_creators(db, inputs, people):
  shared = catalog.create_collection('a', 'night/hard', '', [inputs.street], '', 1, NOW)
  alices = catalog.create_collection('a', 'alice/try', '', [inputs.rain1], '', 1, NOW, shared=False)
  assert [r['id'] for r in catalog.collections_of(['a'], user_id=1)] == [alices, shared]
  assert [r['id'] for r in catalog.collections_of(['a'], user_id=2)] == [shared]
  assert [r['id'] for r in catalog.collections_of(['a'])] == [shared]
  assert catalog.collection_by_id(alices)['shared'] is False
  assert catalog.find_collection(['a'], 'alice/try', user_id=1)['id'] == alices
  assert catalog.find_collection(['a'], 'alice/try', user_id=2) is None
  # what's only in alice's collection isn't seen through it by bob
  assert catalog.in_collections_of(inputs.rain1, ['a'], 1)
  assert not catalog.in_collections_of(inputs.rain1, ['a'], 2)
  # names stay unique per project
  assert catalog.name_taken('a', 'alice/try') == alices
  catalog.update_collection(alices, {'shared': True}, NOW)
  assert catalog.find_collection(['a'], 'alice/try', user_id=2)['id'] == alices


def test_inputs_of_collections_are_kept(db, inputs, people):
  collection_id = catalog.create_collection('a', 'keep', '', [inputs.street], '', 1, NOW)
  assert catalog.in_collections_of(inputs.street, ['a/b', 'a'])
  assert not catalog.in_collections_of(inputs.street, ['a/b'])
  db.cursor.execute("SAVEPOINT s")
  with pytest.raises(Exception, match='foreign key'):
    db.cursor.execute("DELETE FROM test_inputs WHERE id = %s", (inputs.street,))
  db.cursor.execute("ROLLBACK TO SAVEPOINT s")
  # deleting the project deletes its collections
  db.cursor.execute("DELETE FROM input_projects WHERE project_id = 'a'")
  db.cursor.execute("DELETE FROM ci_commits WHERE project_id = 'a'")
  db.cursor.execute("DELETE FROM projects WHERE id = 'a'")
  assert catalog.collection_by_id(collection_id) is None
  assert one(db.cursor, "SELECT count(*) AS n FROM collection_members")['n'] == 0


def test_favorites_and_pins(db, inputs, people):
  first = catalog.create_collection('a', 'one', '', [], '', 1, NOW)
  second = catalog.create_collection('a', 'two', '', [], '', 1, NOW)
  catalog.set_favorite(2, first, True)
  catalog.set_favorite(2, first, True)
  assert catalog.favorite_ids(2, [first, second]) == {first}
  assert catalog.favorite_ids(None, [first]) == set() and catalog.favorite_ids(2, []) == set()
  catalog.set_favorite(2, first, False)
  assert catalog.favorite_ids(2, [first, second]) == set()

  for changed in (True, False):
    assert catalog.set_pin(first, None, True, 1) is changed
    assert catalog.set_pin(first, 5, True, 2) is changed
  assert catalog.pins_of([first, second]) == {first: [{'id': None, 'name': None}, {'id': 5, 'name': 'night-team'}]}
  catalog.set_pin(first, None, False, 1)
  assert catalog.pins_of([first]) == {first: [{'id': 5, 'name': 'night-team'}]}
  assert catalog.set_pin(first, 5, False, 2) is True and catalog.set_pin(first, 5, False, 2) is False
  assert catalog.pins_of([first]) == {} and catalog.pins_of([]) == {}

  db.cursor.execute("INSERT INTO group_members (group_id, user_id) VALUES (6, 2)")
  assert catalog.groups_of(2) == [{'id': 6, 'name': 'day-team'}, {'id': 5, 'name': 'night-team'}] and catalog.groups_of(None) == []
  db.cursor.execute("DELETE FROM group_members WHERE group_id = 6")
  assert catalog.group_ids_of(2) == [5] and catalog.group_ids_of(1) == [] and catalog.group_ids_of(None) == []
  assert catalog.group_exists(6) and not catalog.group_exists(7)
