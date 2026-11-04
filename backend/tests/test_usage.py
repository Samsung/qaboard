"""
Usage analytics (backend/usage.py, backend/api/usage.py): cleaning what clients send, the ingest endpoint's answers,
periods and filters, the rate limit, and the SQL of Admin > Usage.

The SQL runs only against a real PostgreSQL: set QABOARD_TEST_DATABASE_URL (postgresql://user:password@host/db).
It works in temporary tables, in a transaction that is rolled back: nothing is written.
"""
import os
import re
import json
import datetime
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest
from flask import g

from backend import usage
from backend.api import usage as api


NOW = datetime.datetime(2026, 11, 3, 12, 0, 0)


# Cleaning

def test_clean_event_keeps_valid_names_only():
  assert usage.clean_event({"event": "page_view"}, NOW)['event'] == 'page_view'
  assert usage.clean_event({"event": "a" * 64}, NOW) is not None
  for bad in ("PageView", "1event", "a" * 65, "", "page view", "$pageview", None, 3):
    assert usage.clean_event({"event": bad}, NOW) is None, bad
  assert usage.clean_event("page_view", NOW) is None
  assert usage.clean_event(None, NOW) is None


def test_clean_event_timestamps_are_clamped_near_now():
  event = lambda when: usage.clean_event({"event": "e", "timestamp": when}, NOW)['created_at']
  assert event("2026-11-03T11:00:00.000Z") == NOW - datetime.timedelta(hours=1)
  assert event("2026-11-03T13:00:00+02:00") == NOW - datetime.timedelta(hours=1)
  assert event("2026-11-03T11:00:00") == NOW - datetime.timedelta(hours=1)
  # too old, too far ahead
  assert event("2026-10-01T00:00:00Z") == NOW - usage.MAX_PAST
  assert event("2026-12-01T00:00:00Z") == NOW + usage.MAX_FUTURE
  # missing or invalid: now
  assert event(None) == NOW
  assert event("yesterday") == NOW
  assert event(12345) == NOW


def test_clean_event_texts_are_cut():
  event = usage.clean_event({"event": "e", "project_id": " repo/" + "x" * 600, "client_id": "c" * 100}, NOW)
  assert len(event['project_id']) == usage.MAX_PROJECT_ID and event['project_id'].startswith("repo/")
  assert len(event['client_id']) == usage.MAX_CLIENT_ID
  event = usage.clean_event({"event": "e", "project_id": "  ", "client_id": 42}, NOW)
  assert event['project_id'] is None and event['client_id'] is None


def test_clean_strings_postgresql_refuses():
  # NUL in text and JSONB, lone surrogates (not UTF-8): a 500 and the whole request lost, otherwise
  event = usage.clean_event({"event": "e", "project_id": "re\x00po", "client_id": "\ud800abc", "properties": {"a": "x\x00y", "b": ["\udc00", "ok"]}}, NOW)
  assert event['project_id'] == "repo" and event['client_id'] == "\ufffdabc"
  assert event['properties'] == {"a": "xy", "b": ["\ufffd", "ok"]}
  assert usage.clean_text("\x00", 10) is None
  assert usage.clean_string("é" * 300, 200) == "é" * 200


def test_clean_properties_limits():
  properties = usage.clean_properties({
    "route": "commit", "n": 3, "ratio": 0.5, "flag": True, "nothing": None,
    "long": "x" * 500, "nan": float('nan'), "inf": float('inf'),
    "list": [1, "two", None, [3], {"four": 4}, 5.0], "long_list": list(range(100)),
    "nested": {"a": 1}, "Bad-Key": 1, "": 2, "x" * 65: 3, 7: 4,
  })
  assert properties == {
    "route": "commit", "n": 3, "ratio": 0.5, "flag": True, "nothing": None,
    "long": "x" * usage.MAX_STRING,
    "list": [1, "two", None, 5.0], "long_list": list(range(usage.MAX_LIST)),
  }
  assert usage.clean_properties(None) == {}
  assert usage.clean_properties(["a"]) == {}
  assert len(usage.clean_properties({f"k{i}": i for i in range(100)})) == usage.MAX_KEYS
  assert usage.clean_properties({"ok": "a" * 50})["ok"] == "a" * 50


def test_clean_source():
  assert usage.clean_source('cli') == 'cli'
  assert usage.clean_source('webapp') == 'webapp'
  assert usage.clean_source('server') == 'webapp'
  assert usage.clean_source(None) == 'webapp'


# Periods and filters

def test_parse_date():
  assert usage.parse_date(None) is None
  assert usage.parse_date("  ") is None
  assert usage.parse_date("2026-11-03") == datetime.datetime(2026, 11, 3)
  # an inclusive last day
  assert usage.parse_date("2026-11-03", end_of_day=True) == datetime.datetime(2026, 11, 4)
  assert usage.parse_date("2026-11-03T10:00:00Z") == datetime.datetime(2026, 11, 3, 10)
  assert usage.parse_date("2026-11-03T12:00:00+02:00") == datetime.datetime(2026, 11, 3, 10)
  with pytest.raises(ValueError):
    usage.parse_date("last week")


def test_period_defaults_and_previous():
  period = usage.Period(now=NOW)
  assert period.until == NOW and period.since == NOW - datetime.timedelta(days=30)
  previous = period.previous()
  assert previous.until == period.since and previous.since == NOW - datetime.timedelta(days=60)
  with pytest.raises(ValueError):
    usage.Period(NOW, NOW)
  assert period.describe() == {"since": "2026-10-04T12:00:00Z", "until": "2026-11-03T12:00:00Z"}
  # an inclusive "today" ends now, not at midnight: trends compare periods of the same length
  period = usage.Period(NOW - datetime.timedelta(days=7), NOW + datetime.timedelta(hours=12), now=NOW)
  assert period.until == NOW and period.previous_since == NOW - datetime.timedelta(days=14)
  with pytest.raises(ValueError):
    usage.Period(datetime.datetime(1999, 12, 31), NOW, now=NOW)
  with pytest.raises(ValueError):
    usage.Period(datetime.datetime(2019, 1, 1), NOW, now=NOW)
  assert usage.Period(datetime.datetime(2022, 1, 1), NOW, now=NOW).since == datetime.datetime(2022, 1, 1)


def test_filters_select_a_project_or_a_product():
  period = usage.Period(now=NOW)
  filters = usage.Filters(period, " /group/repo/ ")
  assert filters.project == "group/repo"
  assert "project_id = :project OR project_id LIKE :project_like" in filters.where()
  assert filters.params() == {"since": period.since, "until": period.until, "project": "group/repo", "project_like": "group/repo/%"}
  assert filters.params(previous=True)["until"] == period.since
  assert usage.Filters(period, "a_b%").params()["project_like"] == "a\\_b\\%/%"
  assert "project" not in usage.Filters(period, "").where()
  assert usage.Filters(period).where(alias='e') == "e.created_at >= :since AND e.created_at < :until"


def test_bucket_starts():
  assert usage.bucket_start(datetime.datetime(2026, 11, 3, 15), 'day') == datetime.datetime(2026, 11, 3)
  # a Tuesday: the week starts on Monday
  assert usage.bucket_start(datetime.datetime(2026, 11, 3, 15), 'week') == datetime.datetime(2026, 11, 2)
  assert usage.bucket_start(datetime.datetime(2026, 11, 2), 'week') == datetime.datetime(2026, 11, 2)


def test_event_as_text():
  row = {"id": 1, "created_at": NOW, "received_at": NOW, "properties": {"b": 1, "a": [1, 2]}}
  text = usage.event_as_text(row)
  assert text["created_at"] == "2026-11-03T12:00:00Z" and text["properties"] == '{"a": [1, 2], "b": 1}'


# Storing

@pytest.fixture
def session(monkeypatch):
  """The database session `store` adds to, without a database"""
  import sys
  session = MagicMock()
  monkeypatch.setitem(sys.modules, 'backend.database', SimpleNamespace(db_session=session))
  monkeypatch.setattr(sys.modules['sqlalchemy'], 'insert', lambda table: ('insert', table), raising=False)
  return session


def test_store_builds_rows_for_one_insert(session):
  alice = SimpleNamespace(id=7, user_name='alice')
  events = [usage.clean_event({"event": "page_view", "project_id": "p", "properties": {"route": "commit"}}, NOW),
            usage.clean_event({"event": "output_open"}, NOW)]
  assert usage.store(events, actor=SimpleNamespace(user=alice, token=None), source='webapp', now=NOW) == 2
  session.execute.assert_called_once()
  rows = session.execute.call_args[0][1]
  assert [r['event'] for r in rows] == ['page_view', 'output_open']
  assert rows[0] == {"created_at": NOW, "received_at": NOW, "source": "webapp", "event": "page_view", "user_id": 7,
                     "user_name": "alice", "verified": True, "client_id": None, "project_id": "p", "properties": {"route": "commit"}}
  assert usage.store([], actor=None) == 0


def test_store_unverified_cli_events_match_accounts_by_name(session, monkeypatch):
  monkeypatch.setattr(usage, "find_user_id", lambda name: 42 if name == 'bob' else None)
  assert usage.find_user_id(None) is None and usage.find_user_id("") is None
  events = [usage.clean_event({"event": "cli_command"}, NOW)]
  usage.store(events, actor=None, source='cli', user_name_hint='bob', now=NOW)
  row = session.execute.call_args[0][1][0]
  assert (row['user_id'], row['user_name'], row['verified']) == (42, 'bob', False)
  usage.store(events, actor=None, source='cli', user_name_hint='carol', now=NOW)
  row = session.execute.call_args[0][1][0]
  assert (row['user_id'], row['user_name'], row['verified']) == (None, 'carol', False)
  # the web app never says who it is: anonymous visitors stay anonymous
  usage.store(events, actor=None, source='webapp', user_name_hint='carol', now=NOW)
  row = session.execute.call_args[0][1][0]
  assert (row['user_id'], row['user_name'], row['verified']) == (None, None, True)
  # a blank or odd hint is nobody
  for hint in ("   ", {}, 3, "\x00"):
    usage.store(events, actor=None, source='cli', user_name_hint=hint, now=NOW)
    row = session.execute.call_args[0][1][0]
    assert (row['user_id'], row['user_name'], row['verified']) == (None, None, True), hint
  # a signed-in actor wins over the hint
  usage.store(events, actor=SimpleNamespace(user=SimpleNamespace(id=1, user_name='alice'), token=None), source='cli', user_name_hint='bob', now=NOW)
  row = session.execute.call_args[0][1][0]
  assert (row['user_id'], row['user_name'], row['verified']) == (1, 'alice', True)


# The endpoint

@pytest.fixture
def ingest(monkeypatch):
  """POSTs a body to the endpoint, with settings and an actor; returns (status, stored events)"""
  stored = []
  settings = {'analytics.enabled': True, 'ingest.auth': 'off'}
  monkeypatch.setattr(api, "setting", lambda key: settings[key])
  monkeypatch.setattr(usage, "store", lambda events, **kwargs: stored.append((events, kwargs)) or len(events))
  monkeypatch.setattr(api, "db_session", MagicMock())
  monkeypatch.setattr(api, "client_ip", lambda: "10.0.0.1")
  monkeypatch.setattr(api.time, "monotonic", lambda: 1000.0)
  api._rate_windows.clear()

  def post(dummy_app, body, actor=None, content_type='application/json', raw=None):
    data = raw if raw is not None else json.dumps(body)
    with dummy_app.test_request_context("/api/v1/events", method="POST", data=data, content_type=content_type):
      g.actor = actor
      response = api.usage_events()
      status = response[1] if isinstance(response, tuple) else response.status_code
      return status
  return SimpleNamespace(post=post, stored=stored, settings=settings)


def alice():
  return SimpleNamespace(user=SimpleNamespace(id=7, user_name='alice'), token=None)


def test_events_are_stored_for_the_actor(dummy_app, ingest):
  status = ingest.post(dummy_app, {"events": [{"event": "page_view", "properties": {"route": "commit"}}, {"event": "BAD"}]}, actor=alice())
  assert status == 204
  events, kwargs = ingest.stored[0]
  assert [e['event'] for e in events] == ['page_view']
  assert kwargs['actor'].user.user_name == 'alice' and kwargs['source'] == 'webapp' and kwargs['user_name_hint'] is None


def test_beacons_are_text_plain(dummy_app, ingest):
  assert ingest.post(dummy_app, {"events": [{"event": "page_view"}]}, actor=alice(), content_type='text/plain') == 204
  assert len(ingest.stored) == 1


def test_cli_events_say_who_without_a_token(dummy_app, ingest):
  assert ingest.post(dummy_app, {"source": "cli", "user_name": "bob", "events": [{"event": "cli_command"}]}) == 204
  _, kwargs = ingest.stored[0]
  assert kwargs['source'] == 'cli' and kwargs['user_name_hint'] == 'bob'
  # the web app can't claim a name
  assert ingest.post(dummy_app, {"source": "webapp", "user_name": "bob", "events": [{"event": "page_view"}]}) == 204
  assert ingest.stored[1][1]['user_name_hint'] is None


def test_unverified_events_are_dropped_when_results_need_tokens(dummy_app, ingest):
  ingest.settings['ingest.auth'] = 'token'
  assert ingest.post(dummy_app, {"source": "cli", "user_name": "bob", "events": [{"event": "cli_command"}]}) == 204
  assert ingest.stored == []
  assert ingest.post(dummy_app, {"events": [{"event": "page_view"}]}, actor=alice()) == 204
  assert len(ingest.stored) == 1


def test_nothing_is_stored_when_analytics_are_off(dummy_app, ingest):
  ingest.settings['analytics.enabled'] = False
  assert ingest.post(dummy_app, {"events": [{"event": "page_view"}]}, actor=alice()) == 204
  assert ingest.stored == []


def test_malformed_bodies(dummy_app, ingest):
  assert ingest.post(dummy_app, None, raw="not json") == 400
  assert ingest.post(dummy_app, {"event": "page_view"}) == 400
  assert ingest.post(dummy_app, [{"event": "page_view"}]) == 400
  assert ingest.post(dummy_app, {"events": "page_view"}) == 400
  # an empty list is fine, and stores nothing
  assert ingest.post(dummy_app, {"events": []}) == 204
  assert ingest.stored == []


def test_too_many_events_or_bytes(dummy_app, ingest):
  assert ingest.post(dummy_app, {"events": [{"event": "e"}] * (usage.MAX_EVENTS + 1)}) == 413
  assert ingest.post(dummy_app, None, raw='{"events": [{"event": "e", "properties": {"x": "' + "y" * usage.MAX_BODY_BYTES + '"}}]}') == 413
  assert ingest.stored == []


def test_rate_limit_per_actor(dummy_app, ingest):
  body = {"events": [{"event": "e"}] * 100}
  for _ in range(10):
    assert ingest.post(dummy_app, body, actor=alice()) == 204
  assert ingest.post(dummy_app, body, actor=alice()) == 429
  # another actor isn't affected
  assert ingest.post(dummy_app, body, actor=SimpleNamespace(user=SimpleNamespace(id=8, user_name='bob'), token=None)) == 204
  assert len(ingest.stored) == 11


def test_rate_limit_window_slides():
  api._rate_windows.clear()
  assert not api.rate_limited("k", 600, now=1000)
  assert api.rate_limited("k", 600, now=1030)
  # refused events aren't counted: insisting doesn't make it worse
  assert api.rate_limited("k", 600, now=1031)
  # the minute before fades: 600 * (1 - 41/60) + 1 < 1000
  assert not api.rate_limited("k", 1, now=1061)
  # two minutes later, it's forgotten
  assert not api.rate_limited("k", 1000, now=1140)
  # empty requests count for nothing, and stale keys are cleaned up (at most once a minute)
  assert not api.rate_limited("other", 0, now=1140)
  assert "other" not in api._rate_windows
  api._rate_cleaned_at = 0
  assert not api.rate_limited("fresh", 1, now=1300)
  assert "k" not in api._rate_windows and "fresh" in api._rate_windows


def test_a_failed_insert_is_not_the_clients_problem(dummy_app, ingest, monkeypatch):
  def boom(events, **kwargs):
    raise RuntimeError("DataError")
  monkeypatch.setattr(usage, "store", boom)
  api.app.logger = MagicMock()
  assert ingest.post(dummy_app, {"events": [{"event": "page_view"}]}, actor=alice()) == 204
  api.db_session.rollback.assert_called_once()


def test_csv_cells():
  assert api.csv_cell("=HYPERLINK(1)") == "'=HYPERLINK(1)"
  assert api.csv_cell("+1") == "'+1" and api.csv_cell("-1") == "'-1" and api.csv_cell("@x") == "'@x" and api.csv_cell("\tx") == "'\tx"
  assert api.csv_cell("repo/sub") == "repo/sub" and api.csv_cell(3) == 3 and api.csv_cell(None) is None
  assert api.csv_cell({"b": 1, "a": 2}) == '{"a": 2, "b": 1}' and api.csv_cell(["=x"]) == '["=x"]'
  lines = list(api.csv_lines([{"a": "=x", "b": 1}], ("a", "b")))
  assert lines == ["a,b\r\n", "'=x,1\r\n"]


# Admin > Usage, on PostgreSQL

@pytest.fixture
def postgres(monkeypatch):
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
      CREATE TEMPORARY TABLE usage_events (
        id bigserial PRIMARY KEY, created_at timestamp NOT NULL, received_at timestamp NOT NULL DEFAULT now(),
        source text NOT NULL, event text NOT NULL, user_id integer, user_name text, verified boolean NOT NULL DEFAULT true,
        client_id text, project_id text, properties jsonb NOT NULL DEFAULT '{}'
      ) ON COMMIT DROP;
      CREATE TEMPORARY TABLE users (id serial PRIMARY KEY, user_name text, full_name text, kind text NOT NULL DEFAULT 'human', status text NOT NULL DEFAULT 'active') ON COMMIT DROP;
      CREATE TEMPORARY TABLE groups (id serial PRIMARY KEY, name text) ON COMMIT DROP;
      CREATE TEMPORARY TABLE group_members (id serial PRIMARY KEY, group_id integer, user_id integer) ON COMMIT DROP;
      CREATE TEMPORARY TABLE ci_commits (id serial PRIMARY KEY, project_id text, latest_output_datetime timestamptz) ON COMMIT DROP;
      CREATE TEMPORARY TABLE batches (id serial PRIMARY KEY, ci_commit_id integer, origin text) ON COMMIT DROP;
      CREATE TEMPORARY TABLE outputs (id serial PRIMARY KEY, batch_id integer, created_date timestamp) ON COMMIT DROP;
    """)

    class Result:
      def __init__(self, rows, rowcount):
        self.rows, self.rowcount = rows, rowcount
      def fetchall(self):
        return self.rows

    def execute(sql, params):
      # sqlalchemy.text's :name parameters, as psycopg2's %(name)s
      cursor.execute(re.sub(r'(?<![:\w]):(\w+)', r'%(\1)s', sql.replace('%', '%%')), params)
      return Result([dict(row) for row in cursor.fetchall()] if cursor.description else [], cursor.rowcount)
    monkeypatch.setattr(usage, "execute", execute)
    # claim_events wraps its UPDATE in a savepoint of the session: the cursor's transaction is the test's
    import sys
    monkeypatch.setitem(sys.modules, 'backend.database', SimpleNamespace(db_session=MagicMock()))
    yield cursor
  finally:
    connection.rollback()
    connection.close()


def insert_event(cursor, event, days_ago=1, user_id=None, user_name=None, source='webapp', project_id='repo/sub', verified=True, **properties):
  cursor.execute(
    "INSERT INTO usage_events (created_at, source, event, user_id, user_name, verified, project_id, properties) VALUES (%s, %s, %s, %s, %s, %s, %s, %s)",
    (NOW - datetime.timedelta(days=days_ago), source, event, user_id, user_name, verified, project_id, json.dumps(properties)))


def insert_ci_runs(cursor, project_id, n, days_ago=2):
  # like api/outputs.py, the commit says when it last got runs
  cursor.execute("INSERT INTO ci_commits (project_id, latest_output_datetime) VALUES (%s, %s) RETURNING id", (project_id, NOW - datetime.timedelta(days=days_ago)))
  commit_id = cursor.fetchone()['id']
  cursor.execute("INSERT INTO batches (ci_commit_id, origin) VALUES (%s, 'ci') RETURNING id", (commit_id,))
  batch_id = cursor.fetchone()['id']
  for _ in range(n):
    cursor.execute("INSERT INTO outputs (batch_id, created_date) VALUES (%s, %s)", (batch_id, NOW - datetime.timedelta(days=days_ago)))


@pytest.fixture
def sample(postgres):
  cursor = postgres
  cursor.execute("INSERT INTO users (id, user_name, full_name) VALUES (1, 'alice', 'Alice A'), (2, 'bob', 'Bob B')")
  cursor.execute("INSERT INTO groups (id, name) VALUES (1, 'team')")
  cursor.execute("INSERT INTO group_members (group_id, user_id) VALUES (1, 1), (1, 2)")
  # alice looks at results in the web app, on 3 days, and starts a tuning
  insert_event(cursor, 'page_view', 1, user_id=1, user_name='alice', route='commit', commit_id='c1')
  insert_event(cursor, 'page_view', 2, user_id=1, user_name='alice', route='commit', commit_id='c1')
  insert_event(cursor, 'page_view', 3, user_id=1, user_name='alice', route='commit', commit_id='c2')
  insert_event(cursor, 'page_view', 3, user_id=1, user_name='alice', route='history')
  insert_event(cursor, 'commit_compare', 1, user_id=1, user_name='alice')
  insert_event(cursor, 'output_open', 1, user_id=1, user_name='alice', viewer='images')
  insert_event(cursor, 'image_viewer_use', 1, user_id=1, user_name='alice', feature='compare')
  insert_event(cursor, 'batch_start', 1, user_id=1, user_name='alice', kind='tuning', n_runs=4)
  insert_event(cursor, 'export_start', 1, user_id=1, user_name='alice')
  insert_event(cursor, 'milestone_save', 1, user_id=1, user_name='alice')
  # bob uses the CLI without a token, carol has no account
  # a batch that ran (it has a runner), and a dry run: only the first counts as started
  insert_event(cursor, 'cli_command', 1, user_id=2, user_name='bob', source='cli', verified=False, command='batch', runner='local')
  insert_event(cursor, 'cli_command', 1, user_id=2, user_name='bob', source='cli', verified=False, command='batch', runner='local', dryrun=True)
  insert_event(cursor, 'cli_command', 2, user_id=2, user_name='bob', source='cli', verified=False, command='run')
  insert_event(cursor, 'cli_command', 1, user_name='carol', source='cli', verified=False, command='run', project_id='other/repo')
  # alice was already there 40 days ago, in another project
  insert_event(cursor, 'page_view', 40, user_id=1, user_name='alice', route='commit', commit_id='old', project_id='old/repo')
  insert_ci_runs(cursor, 'repo/sub', 3)
  insert_ci_runs(cursor, 'nobody/looks', 2)
  return cursor


def period():
  return usage.Period(NOW - datetime.timedelta(days=30), NOW)


def test_summary_counts(sample):
  result = usage.summary(usage.Filters(period()))
  assert result['since'] == "2026-10-04T12:00:00Z" and result['project'] is None
  counts = result['counts']
  assert counts['web_users'] == 1 and counts['cli_users'] == 2 and counts['users'] == 3
  assert counts['unverified_cli_users'] == 1  # carol: bob has an account
  assert counts['new_users'] == 2  # alice was already there
  assert counts['commits_viewed'] == 2 and counts['comparisons'] == 1 and counts['outputs_opened'] == 1 and counts['image_viewer_uses'] == 1
  assert counts['batches_started'] == 2 and counts['batches_started_by_kind'] == {'tuning': 1, 'automated_tuning': 0, 'run_tests': 0, 'redo': 0, 'cli': 1}
  assert counts['cli_commands'] == 4 and counts['exports'] == 1 and counts['milestones'] == 1
  assert counts['ci_runs'] == 5
  previous = result['previous_counts']
  assert previous['events'] == 1 and previous['web_users'] == 1 and previous['commits_viewed'] == 1 and previous['ci_runs'] == 0


def test_summary_of_a_project_or_a_product(sample):
  counts = usage.counts(usage.Filters(period(), 'repo'))
  assert counts['events'] == 13 and counts['ci_runs'] == 3 and counts['cli_users'] == 1
  counts = usage.counts(usage.Filters(period(), 'other/repo'))
  assert counts['events'] == 1 and counts['ci_runs'] == 0 and counts['unverified_cli_users'] == 1
  assert usage.counts(usage.Filters(period(), 'rep'))['events'] == 0


def test_timeseries_fills_empty_buckets(sample):
  days = usage.timeseries(usage.Filters(period()), 'day')
  assert len(days) == 31 and days[0]['start'] == "2026-10-04T00:00:00Z" and days[-1]['start'] == "2026-11-03T00:00:00Z"
  by_day = {d['start']: d for d in days}
  assert by_day["2026-11-02T00:00:00Z"] == {"start": "2026-11-02T00:00:00Z", "web_users": 1, "cli_users": 2, "commits_viewed": 1, "outputs_opened": 1, "batches_started": 2, "cli_commands": 3}
  assert by_day["2026-10-31T00:00:00Z"]["commits_viewed"] == 1 and by_day["2026-10-20T00:00:00Z"]["web_users"] == 0
  weeks = usage.timeseries(usage.Filters(period()), 'week')
  assert [w['start'] for w in weeks][:2] == ["2026-09-28T00:00:00Z", "2026-10-05T00:00:00Z"] and weeks[-1]['start'] == "2026-11-02T00:00:00Z"
  assert weeks[-1]['web_users'] == 1 and weeks[-2]['web_users'] == 1
  with pytest.raises(ValueError):
    usage.timeseries(usage.Filters(period()), 'month')


def test_users_leaderboard(sample):
  users = usage.users(usage.Filters(period()))
  assert [u['user_name'] for u in users] == ['alice', 'bob', 'carol']
  alice, bob, carol = users
  assert alice['full_name'] == 'Alice A' and alice['verified'] and alice['active_days'] == 3 and alice['commits_viewed'] == 2
  assert alice['web_events'] == 10 and alice['batches_started'] == 1 and alice['projects'] == ['repo/sub'] and alice['last_seen_at'] == "2026-11-02T12:00:00Z"
  assert bob['user_id'] == 2 and not bob['verified'] and bob['cli_commands'] == 3 and bob['batches_started'] == 1 and bob['active_days'] == 2
  assert carol['user_id'] is None and carol['full_name'] is None and carol['projects'] == ['other/repo']
  assert usage.users(usage.Filters(period()), limit=1) == [alice]


def test_groups_leaderboard(sample):
  groups = usage.groups(usage.Filters(period()))
  assert groups == [{"group_id": 1, "name": "team", "members": 2, "active_members": 2, "active_days": 5, "commits_viewed": 2,
                     "batches_started": 2, "cli_commands": 3, "events": 13}]
  # a group without activity still shows, with its members
  sample.execute("INSERT INTO groups (id, name) VALUES (2, 'idle'); INSERT INTO group_members (group_id, user_id) VALUES (2, 2)")
  groups = usage.groups(usage.Filters(period(), 'nothing/here'))
  assert [(g['name'], g['members'], g['active_members']) for g in groups] == [('idle', 1, 0), ('team', 2, 0)]


def test_projects_and_their_status(sample):
  projects = usage.projects(usage.Filters(period()))
  # other/repo: only carol's CLI, its first event ever; old/repo: activity in the period before, nothing now
  assert [(p['project_id'], p['status']) for p in projects] == [('repo/sub', 'new'), ('other/repo', 'new'), ('nobody/looks', 'ci_only'), ('old/repo', 'quiet')]
  repo = projects[0]
  assert repo['product'] == 'repo' and repo['people'] == 1 and repo['commits_viewed'] == 2 and repo['ci_runs'] == 3 and repo['batches_started'] == 2
  # old/repo had activity before the period: quiet now
  since = NOW - datetime.timedelta(days=39)
  statuses = {p['project_id']: p['status'] for p in usage.projects(usage.Filters(usage.Period(since, NOW)))}
  assert statuses['old/repo'] == 'quiet'
  # active, not new, when the project was seen before
  statuses = {p['project_id']: p['status'] for p in usage.projects(usage.Filters(usage.Period(NOW - datetime.timedelta(days=50), NOW)))}
  assert statuses['old/repo'] == 'new'
  insert_event(sample, 'page_view', 60, user_id=1, user_name='alice', route='commit', commit_id='older', project_id='old/repo')
  statuses = {p['project_id']: p['status'] for p in usage.projects(usage.Filters(usage.Period(NOW - datetime.timedelta(days=50), NOW)))}
  assert statuses['old/repo'] == 'active'


def test_one_user(sample):
  result = usage.user_usage(1, period())
  assert result['total'] == 10 and result['active_days'] == 3
  assert result['first_seen_at'] == "2026-09-24T12:00:00Z" and result['last_seen_at'] == "2026-11-02T12:00:00Z"
  assert result['by_event'][0] == {"event": "page_view", "count": 4} and len(result['by_event']) == 7
  assert result['by_project'] == [{"project_id": "repo/sub", "count": 10}]
  nobody = usage.user_usage(99, period())
  assert nobody['total'] == 0 and nobody['first_seen_at'] is None and nobody['by_event'] == []


def test_events_rows_in_chunks(sample):
  rows = list(usage.events_rows(usage.Filters(period()), chunk=4))
  assert len(rows) == 14 and [r['id'] for r in rows] == sorted(r['id'] for r in rows)
  assert set(rows[0]) == set(usage.EVENT_COLUMNS)
  assert len(list(usage.events_rows(usage.Filters(period()), chunk=4, limit=5))) == 5
  assert [r['user_name'] for r in usage.events_rows(usage.Filters(period(), 'other/repo'))] == ['carol']


def test_batch_help_is_not_a_batch_started(sample):
  # `qa batch --help` and usage errors send a cli_command without a runner: it's a command, not a batch
  before = usage.counts(usage.Filters(period()))
  insert_event(sample, 'cli_command', 1, user_id=2, user_name='bob', source='cli', verified=False, command='batch')
  after = usage.counts(usage.Filters(period()))
  assert after['cli_commands'] == before['cli_commands'] + 1
  assert after['batches_started'] == before['batches_started']


def test_overview_helpers(sample):
  since = NOW - datetime.timedelta(days=90)
  assert usage.active_user_ids(since) == {1, 2}
  assert usage.ci_only_projects(since) == ['nobody/looks']
  assert usage.web_only_users(since) == [1]
  assert usage.tuning_products(since) == {'old': False, 'other': False, 'repo': True}


def test_anonymous_visitors_count_as_looking(sample):
  # servers that don't require signing in: page views without a user, from a browser (client_id)
  sample.execute("INSERT INTO usage_events (created_at, source, event, client_id, project_id, properties) VALUES (%s, 'webapp', 'page_view', 'browser-1', 'nobody/looks', %s)",
                 (NOW - datetime.timedelta(days=1), '{"commit_id": "c9"}'))
  statuses = {p['project_id']: (p['status'], p['people']) for p in usage.projects(usage.Filters(period()))}
  assert statuses['nobody/looks'] == ('new', 1)
  # the overview agrees: nobody/looks isn't CI-only anymore
  assert usage.ci_only_projects(NOW - datetime.timedelta(days=90)) == []
  # a project whose only looks are anonymous isn't "new" forever
  sample.execute("INSERT INTO usage_events (created_at, source, event, client_id, project_id) VALUES (%s, 'webapp', 'page_view', 'browser-1', 'nobody/looks')",
                 (NOW - datetime.timedelta(days=45),))
  statuses = {p['project_id']: p['status'] for p in usage.projects(usage.Filters(period()))}
  assert statuses['nobody/looks'] == 'active'
  # anonymous visitors are not "users"
  assert usage.counts(usage.Filters(period()))['web_users'] == 1


def test_ci_only_projects_match_subprojects_exactly(sample):
  # a page view of my_repo/sub says my_repo is looked at, but not myXrepo (LIKE's _ is escaped)
  insert_ci_runs(sample, 'my_repo', 1)
  insert_ci_runs(sample, 'myXrepo', 1)
  insert_event(sample, 'page_view', 1, user_id=1, user_name='alice', route='commit', project_id='my_repo/sub')
  assert usage.ci_only_projects(NOW - datetime.timedelta(days=90)) == ['myXrepo', 'nobody/looks']


def test_ci_only_projects_are_those_with_recent_ci_runs(sample):
  # CI runs before the window don't count, and neither do the local batches
  insert_ci_runs(sample, 'stale/repo', 2, days_ago=100)
  insert_ci_runs(sample, 'local/repo', 1)
  sample.execute("UPDATE batches SET origin = 'local' WHERE ci_commit_id = (SELECT id FROM ci_commits WHERE project_id = 'local/repo')")
  assert usage.ci_only_projects(NOW - datetime.timedelta(days=90)) == ['nobody/looks']
  # a commit that got CI runs again: its project is back
  insert_ci_runs(sample, 'stale/repo', 1, days_ago=3)
  assert usage.ci_only_projects(NOW - datetime.timedelta(days=90)) == ['nobody/looks', 'stale/repo']


def test_a_new_account_claims_its_cli_events(sample):
  # carol used the CLI before she had an account: once she signs up, she is one person
  assert usage.counts(usage.Filters(period()))['users'] == 3
  sample.execute("INSERT INTO users (id, user_name, full_name) VALUES (9, 'carol', 'Carol C')")
  assert usage.claim_events(SimpleNamespace(id=9, user_name='carol', kind='human')) == 1
  insert_event(sample, 'cli_command', 1, user_id=9, user_name='carol', source='cli', command='run', project_id='other/repo')
  counts = usage.counts(usage.Filters(period()))
  assert counts['users'] == 3 and counts['cli_users'] == 2 and counts['unverified_cli_users'] == 0 and counts['new_users'] == 2
  carol = next(u for u in usage.users(usage.Filters(period())) if u['user_name'] == 'carol')
  assert carol['user_id'] == 9 and carol['cli_commands'] == 2 and not carol['verified']  # one event is still unverified
  assert usage.user_usage(9, period())['unverified'] == 1
  # service accounts and nobody claim nothing
  assert usage.claim_events(SimpleNamespace(id=10, user_name='bot', kind='service')) == 0
  assert usage.claim_events(None) == 0


def test_active_users_are_people_with_accounts(sample):
  since = NOW - datetime.timedelta(days=90)
  # an event of a deleted account, and of a service account
  insert_event(sample, 'page_view', 1, user_id=77, user_name='gone')
  sample.execute("INSERT INTO users (id, user_name, kind) VALUES (5, 'bot', 'service')")
  insert_event(sample, 'cli_command', 1, user_id=5, user_name='bot', source='cli', command='run')
  assert usage.active_user_ids(since) == {1, 2}
  assert usage.users(usage.Filters(period()), limit=None)[0]['user_name'] == 'alice'


# The admin endpoints, through their handlers

def get(dummy_app, handler, query='', actor=None, **kwargs):
  """Calls a GET handler with a query string: (status, the JSON or the text)"""
  with dummy_app.test_request_context(f"/api/v1/admin/usage/x?{query}", method="GET"):
    g.actor = actor
    response = handler(**kwargs)
    if isinstance(response, tuple):
      return response[1], response[0].get_json()
    text = response.get_data(as_text=True)
    return response.status_code, (response.get_json() if response.mimetype == 'application/json' else text)


def test_admin_summary_and_timeseries(dummy_app, sample):
  status, data = get(dummy_app, api.admin_usage_summary, "since=2026-10-04&until=2026-11-02")
  assert status == 200 and data['counts']['users'] == 3 and data['previous_counts']['users'] == 1
  assert data['until'] == "2026-11-03T00:00:00Z"
  status, data = get(dummy_app, api.admin_usage_timeseries, "since=2026-10-04&until=2026-11-02&bucket=week")
  assert status == 200 and data['bucket'] == 'week' and len(data['buckets']) == 6
  status, data = get(dummy_app, api.admin_usage_timeseries, "bucket=month")
  assert status == 400 and 'bucket' in data['error']


def test_admin_period_errors(dummy_app, sample):
  assert get(dummy_app, api.admin_usage_summary, "since=last-week")[0] == 400
  assert get(dummy_app, api.admin_usage_summary, "since=2026-11-02&until=2026-10-04")[0] == 400
  # overflows, extremes
  assert get(dummy_app, api.admin_usage_summary, "until=9999-12-31")[0] == 400
  assert get(dummy_app, api.admin_usage_summary, "since=0001-01-02")[0] == 400
  assert get(dummy_app, api.admin_usage_summary, "since=1000-01-01")[0] == 400
  assert get(dummy_app, api.admin_usage_summary, "since=2000-01-01&until=2100-01-01")[0] == 400


def test_admin_tables_as_csv(dummy_app, sample):
  for handler, name in ((api.admin_usage_users, 'alice'), (api.admin_usage_groups, 'team'), (api.admin_usage_projects, 'repo/sub')):
    status, data = get(dummy_app, handler, "since=2026-10-04&until=2026-11-02")
    assert status == 200 and isinstance(data, dict)
    status, text = get(dummy_app, handler, "since=2026-10-04&until=2026-11-02&format=csv")
    lines = text.splitlines()
    assert status == 200 and name in lines[1] and len(lines) >= 2
  status, text = get(dummy_app, api.admin_usage_users, "format=csv")
  assert text.splitlines()[0] == ",".join(api.USER_COLUMNS)


def test_admin_events_export(dummy_app, sample):
  status, text = get(dummy_app, api.admin_usage_events, "since=2026-10-04&until=2026-11-02")
  lines = text.splitlines()
  assert status == 200 and lines[0] == ",".join(usage.EVENT_COLUMNS) and len(lines) == 15
  assert '"{""route"": ""commit""' in text or '""commit_id""' in text
  status, text = get(dummy_app, api.admin_usage_events, "since=2026-10-04&until=2026-11-02&format=json&limit=2")
  events = [json.loads(line) for line in text.splitlines()]
  assert status == 200 and len(events) == 2 and isinstance(events[0]['properties'], dict) and events[0]['created_at'].endswith('Z')
  assert get(dummy_app, api.admin_usage_events, "limit=0")[0] == 400
  assert get(dummy_app, api.admin_usage_events, "limit=-1")[0] == 400
  assert get(dummy_app, api.admin_usage_events, "limit=x")[0] == 400


def test_user_usage_endpoints(dummy_app, sample):
  status, data = get(dummy_app, api.admin_usage_user, "since=2026-10-04&until=2026-11-02", user_id=1)
  assert status == 200 and data['user_id'] == 1 and data['total'] == 10 and data['unverified'] == 0
  nobody = SimpleNamespace(user=SimpleNamespace(id=99, user_name='nobody'), token=None)
  status, data = get(dummy_app, api.my_usage, "", actor=nobody)
  assert status == 200 and data == {"user_id": 99, "since": data['since'], "until": data['until'], "total": 0, "unverified": 0,
                                    "active_days": 0, "first_seen_at": None, "last_seen_at": None, "by_event": [], "by_project": []}
