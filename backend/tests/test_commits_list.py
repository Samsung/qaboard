"""
Tests for the lists of commits and branches in backend/api/api.py (pagination, search),
and for the search syntax in backend/search.py
"""
import sys
import types
import datetime
import importlib
from unittest.mock import MagicMock

import pytest

from backend.search import parse_query, escape_like, Term


# ==========================================
# Search syntax
# ==========================================

class TestParseQuery:
  def test_free_text_terms_are_anded(self):
    assert parse_query('fix  crash') == [Term('text', 'fix', False), Term('text', 'crash', False)]

  def test_negated_terms(self):
    assert parse_query('fix -wip') == [Term('text', 'fix', False), Term('text', 'wip', True)]

  def test_qualifiers(self):
    assert parse_query('branch:dev committer:alice author:bob batch:tuning label:x message:speed msg:up id:3fa2 commit:ab sha:cd') == [
      Term('branch', 'dev', False),
      Term('committer', 'alice', False),
      Term('committer', 'bob', False),
      Term('batch', 'tuning', False),
      Term('batch', 'x', False),
      Term('message', 'speed', False),
      Term('message', 'up', False),
      Term('id', '3fa2', False),
      Term('id', 'ab', False),
      Term('id', 'cd', False),
    ]

  def test_qualifiers_are_case_insensitive_and_can_be_negated(self):
    assert parse_query('-Branch:feature/x') == [Term('branch', 'feature/x', True)]

  def test_quotes(self):
    assert parse_query('message:"fix the crash" "two words" -"not this"') == [
      Term('message', 'fix the crash', False),
      Term('text', 'two words', False),
      Term('text', 'not this', True),
    ]

  def test_unclosed_quotes(self):
    assert parse_query('"fix the') == [Term('text', 'fix the', False)]

  def test_unknown_qualifiers_are_text(self):
    # e.g. conventional commit messages, URLs
    assert parse_query('fix:crash https://example.com') == [Term('text', 'fix:crash', False), Term('text', 'https://example.com', False)]

  def test_incomplete_terms_are_ignored(self):
    # what we get while users type
    assert parse_query('branch: - ""') == []
    assert parse_query('') == []
    assert parse_query(None) == []
    assert parse_query('   ') == []

  def test_limits(self):
    assert len(parse_query(' '.join(f'word{i}' for i in range(100)))) == 20
    assert parse_query('x' * 1000)[0].value == 'x' * 200


def test_escape_like():
  assert escape_like('50%_off\\') == '50\\%\\_off\\\\'
  assert escape_like('plain') == 'plain'


# ==========================================
# Routes
# ==========================================

def query_chain(results=(), scalar=None):
  """A mock of SQLAlchemy queries: filter(), order_by()... return the query itself"""
  query = MagicMock()
  for method in ['filter', 'filter_by', 'options', 'order_by', 'offset', 'limit', 'distinct', 'group_by', 'join']:
    getattr(query, method).return_value = query
  query.all.return_value = list(results)
  query.__iter__.side_effect = lambda: iter(list(results))
  query.yield_per.return_value = list(results)
  query.scalar.return_value = scalar
  return query


def mock_commit(id):
  commit = MagicMock()
  commit.batches = []
  commit.to_dict.return_value = {'id': id}
  return commit


@pytest.fixture
def api(monkeypatch):
  """Imports backend/api/api.py with SQLAlchemy mocked (conftest.py replaces it with an empty module)"""
  for name in ('func', 'and_', 'asc', 'or_', 'not_', 'text'):
    monkeypatch.setattr(sys.modules['sqlalchemy'], name, MagicMock(), raising=False)
  sa_sql = types.ModuleType('sqlalchemy.sql')
  sa_sql.label = MagicMock()
  monkeypatch.setitem(sys.modules, 'sqlalchemy.sql', sa_sql)
  sys.modules.pop('backend.api.api', None)
  api = importlib.import_module('backend.api.api')
  api.is_authorized_user.return_value = True
  api.batches_stats.return_value = {}
  # comparisons on mocked columns
  api.CiCommit.authored_datetime.__ge__ = MagicMock(return_value=MagicMock())
  api.CiCommit.authored_datetime.__le__ = MagicMock(return_value=MagicMock())
  monkeypatch.setattr(api, 'commits_search_filter', MagicMock(return_value='search filter'))
  yield api
  api.db_session.reset_mock(return_value=True, side_effect=True)
  sys.modules.pop('backend.api.api', None)


latest_commit_date = datetime.datetime(2026, 10, 1, tzinfo=datetime.timezone.utc)


class TestCommitsPagination:
  def test_pages_tell_if_there_are_more(self, dummy_app, api):
    query = query_chain([mock_commit(i) for i in range(3)], scalar=latest_commit_date)
    api.db_session.query.return_value = query
    with dummy_app.test_request_context('/api/v1/commits?project=p&limit=2&offset=4'):
      response = api.get_commits()
    assert response.status_code == 200
    assert response.get_json() == [{'id': 0}, {'id': 1}]
    assert response.headers['X-Has-More'] == 'true'
    # we fetch one more than asked
    query.limit.assert_called_with(3)
    query.offset.assert_called_with(4)

  def test_last_page(self, dummy_app, api):
    api.db_session.query.return_value = query_chain([mock_commit(0)], scalar=latest_commit_date)
    with dummy_app.test_request_context('/api/v1/commits?project=p&limit=2'):
      response = api.get_commits()
    assert response.get_json() == [{'id': 0}]
    assert response.headers['X-Has-More'] == 'false'

  def test_without_pagination(self, dummy_app, api):
    query = query_chain([mock_commit(0)], scalar=latest_commit_date)
    api.db_session.query.return_value = query
    with dummy_app.test_request_context('/api/v1/commits?project=p'):
      response = api.get_commits()
    assert response.get_json() == [{'id': 0}]
    assert 'X-Has-More' not in response.headers
    query.limit.assert_called_with(api.max_commits)

  @pytest.mark.parametrize('params', ['limit=abc', 'limit=0', 'offset=-1', 'limit=-5'])
  def test_invalid_pagination(self, dummy_app, api, params):
    with dummy_app.test_request_context(f'/api/v1/commits?project=p&{params}'):
      response, status = api.get_commits()
    assert status == 400

  def test_limit_is_capped(self, dummy_app, api):
    query = query_chain([], scalar=latest_commit_date)
    api.db_session.query.return_value = query
    with dummy_app.test_request_context('/api/v1/commits?project=p&limit=100000'):
      api.get_commits()
    query.limit.assert_called_with(api.max_commits + 1)

  def test_no_commits(self, dummy_app, api):
    api.db_session.query.return_value = query_chain([], scalar=None)
    with dummy_app.test_request_context('/api/v1/commits?project=p&limit=10'):
      response = api.get_commits()
    assert response.get_json() == []
    assert response.headers['X-Has-More'] == 'false'

  def test_forbidden(self, dummy_app, api):
    api.is_authorized_user.return_value = False
    with dummy_app.test_request_context('/api/v1/commits?project=p'):
      _, status = api.get_commits()
    assert status == 403


class TestCommitsSearch:
  def test_search_looks_at_the_whole_history(self, dummy_app, api):
    query = query_chain([mock_commit(0)])
    api.db_session.query.return_value = query
    with dummy_app.test_request_context('/api/v1/commits?project=p&q=fix -wip&limit=50'):
      response = api.get_commits()
    assert response.get_json() == [{'id': 0}]
    api.commits_search_filter.assert_called_once_with([Term('text', 'fix', False), Term('text', 'wip', True)])
    query.filter.assert_any_call('search filter')
    # no date range: we don't look for the latest commit to adjust it, and don't compare dates
    query.scalar.assert_not_called()
    api.CiCommit.authored_datetime.__ge__.assert_not_called()
    api.CiCommit.authored_datetime.__le__.assert_not_called()

  def test_search_in_a_date_range(self, dummy_app, api):
    api.db_session.query.return_value = query_chain([])
    with dummy_app.test_request_context('/api/v1/commits?project=p&q=fix&from=2026-09-01T00:00:00.000Z&to=2026-09-03T00:00:00.000Z'):
      api.get_commits()
    api.CiCommit.authored_datetime.__ge__.assert_called_once()
    api.CiCommit.authored_datetime.__le__.assert_called_once()

  def test_empty_search_is_the_usual_list(self, dummy_app, api):
    query = query_chain([], scalar=latest_commit_date)
    api.db_session.query.return_value = query
    with dummy_app.test_request_context('/api/v1/commits?project=p&q=branch:'):
      api.get_commits()
    api.commits_search_filter.assert_not_called()
    query.scalar.assert_called_once()


class TestBranches:
  def test_all_branches_by_default(self, dummy_app, api):
    query = query_chain([('master',), ('dev',)])
    api.db_session.query.return_value = query
    with dummy_app.test_request_context('/api/v1/project/branches?project=p'):
      response = api.get_branches()
    assert response.get_json() == ['master', 'dev']
    query.distinct.assert_called_once()
    query.limit.assert_not_called()

  def test_search_branches(self, dummy_app, api):
    query = query_chain([('feature/a', latest_commit_date), ('feature/b', latest_commit_date)])
    api.db_session.query.return_value = query
    with dummy_app.test_request_context('/api/v1/project/branches?project=p&q=feat%_'):
      response = api.get_branches()
    assert response.get_json() == ['feature/a', 'feature/b']
    query.limit.assert_called_with(50)
    # users search for text, not LIKE patterns, in the names we show (without origin/)
    api.func.regexp_replace.return_value.ilike.assert_called_with('%feat\\%\\_%', escape='\\')

  def test_branches_limit(self, dummy_app, api):
    query = query_chain([])
    api.db_session.query.return_value = query
    with dummy_app.test_request_context('/api/v1/project/branches?project=p&limit=10'):
      api.get_branches()
    query.limit.assert_called_with(10)

  def test_forbidden(self, dummy_app, api):
    api.is_authorized_user.return_value = False
    with dummy_app.test_request_context('/api/v1/project/branches?project=p'):
      _, status = api.get_branches()
    assert status == 403
