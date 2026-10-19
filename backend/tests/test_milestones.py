"""
Tests for milestones: their rules (backend/milestones.py) and the API (backend/api/milestones.py), with the database mocked.
See tests/TESTING.md for the mocks.
"""
import datetime
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from backend.milestones import (
  clean_fields, from_legacy, same_results, can_edit, slugify, serialize, MilestoneBatches, normalize_group, run_matcher, summarize_runs,
)

SHA = 'aaaaaaaa11111111aaaaaaaa11111111aaaaaaaa'


def make_milestone(**kwargs):
  defaults = dict(
    id=1, project_id='p', user_id=1, shared=True, label='v1.0', group='', notes='', commit_hexsha=SHA, commit_project_id=None,
    batch='default', filter='', data={}, user=SimpleNamespace(user_name='alice', full_name='Alice A'),
    created_at=datetime.datetime(2026, 1, 15, 10), updated_at=datetime.datetime(2026, 1, 15, 10),
  )
  return SimpleNamespace(**{**defaults, **kwargs})


# ==========================================
# Rules
# ==========================================

class TestCleanFields:
  def test_new_milestone(self):
    fields, error = clean_fields({'commit': SHA, 'label': ' v1.0 ', 'group': ' tuning / denoiser/', 'shared': True, 'branch': 'main', 'unknown': 1})
    assert error is None
    assert fields == {
      'label': 'v1.0', 'group': 'tuning/denoiser', 'notes': '', 'shared': True, 'commit_hexsha': SHA,
      'batch': 'default', 'filter': '', 'commit_project_id': None, 'commit_info': {'branch': 'main'},
    }

  def test_new_milestones_need_a_commit(self):
    assert clean_fields({'label': 'x'})[1] == "`commit` is required: the commit's id"
    assert clean_fields({'commit': 'a b'})[1] is not None

  def test_updates_change_only_what_they_send(self):
    fields, error = clean_fields({'label': 'renamed'}, partial=True)
    assert (fields, error) == ({'label': 'renamed'}, None)

  def test_limits(self):
    assert 'too long' in clean_fields({'commit': SHA, 'label': 'x' * 201})[1]
    assert clean_fields({'commit': SHA, 'notes': 3})[1] == '`notes` must be a string'
    assert clean_fields([])[1] == 'Expected a JSON object'

  def test_groups(self):
    assert normalize_group('/a//b / c/') == 'a/b/c'


class TestLegacy:
  def test_shared_milestone(self):
    legacy = {
      'commit': SHA, 'batch': 'tuning', 'filter': 'gain:3', 'label': 'v1.0', 'notes': 'release', 'branch': 'main', 'committer_name': 'Carol',
      'date': '2026-01-15T10:00:00.000Z', 'owners': [{'user_name': 'alice', 'full_name': 'Alice A'}, {'full_name': 'no user name'}],
    }
    fields = from_legacy(f'p/{SHA}/tuning', legacy, 'p')
    assert fields == {
      'project_id': 'p', 'label': 'v1.0', 'group': '', 'notes': 'release', 'commit_hexsha': SHA, 'commit_project_id': None,
      'batch': 'tuning', 'filter': 'gain:3',
      'data': {'branch': 'main', 'committer_name': 'Carol', 'legacy_key': f'p/{SHA}/tuning', 'legacy_owners': [{'user_name': 'alice', 'full_name': 'Alice A'}]},
      'created_at': datetime.datetime(2026, 1, 15, 10), 'updated_at': datetime.datetime(2026, 1, 15, 10),
    }

  def test_private_milestone_from_another_project(self):
    fields = from_legacy('other/abc/default', {'commit': 'abc', 'project': 'other', 'date': 'not a date'}, 'p')
    assert (fields['commit_project_id'], fields['batch'], fields['label']) == ('other', 'default', '')
    assert 'created_at' not in fields

  def test_not_milestones(self):
    assert from_legacy('k', 'nope', 'p') is None
    assert from_legacy('k', {'label': 'no commit'}, 'p') is None

  def test_same_results(self):
    a = from_legacy('k', {'commit': SHA, 'label': 'v1'}, 'p')
    assert same_results(a, {**a, 'data': {}})
    assert not same_results(a, {**a, 'filter': 'x'})
    assert not same_results(a, {**a, 'commit_project_id': 'other'})


class TestPermissions:
  def test_owners_edit(self):
    assert can_edit(1, 1)
    assert not can_edit(1, 2)
    assert not can_edit(1, None)

  def test_milestones_without_owner(self):
    assert can_edit(None, 2)
    # e.g. the owner was deleted: their personal milestones stay theirs
    assert not can_edit(None, 2, {}, 'bob', shared=False)
    # imported with owners that never logged in since: only them
    data = {'legacy_owners': [{'user_name': 'zed'}]}
    assert not can_edit(None, 2, data, 'bob')
    assert can_edit(None, 2, data, 'zed')


def test_slugs():
  assert slugify('Release 1.2 — denoiser!') == 'release-1-2-denoiser'
  assert slugify('') == ''


def test_serialize():
  m = make_milestone(data={'branch': 'main', 'message': 'Faster'})
  data = serialize(m, user_id=1, favorite_ids=[1])
  assert data['owner'] == {'user_name': 'alice', 'full_name': 'Alice A'}
  assert (data['is_mine'], data['can_edit'], data['is_favorite'], data['branch'], data['message']) == (True, True, True, 'main', 'Faster')
  assert (data['slug'], data['created_at']) == ('v1-0', '2026-01-15T10:00:00Z')
  data = serialize(m, user_id=2)
  assert (data['is_mine'], data['can_edit'], data['is_favorite']) == (False, False, False)


def test_milestone_batches():
  milestones = [
    make_milestone(batch='default'), make_milestone(batch='tuning'),
    make_milestone(commit_project_id='other', batch='x'), make_milestone(commit_hexsha=SHA[:8], batch='short'),
  ]
  batches = MilestoneBatches(milestones)
  assert batches.by_commit[('p', SHA)] == {'default', 'tuning'}
  assert batches.by_commit[('other', SHA)] == {'x'}
  assert batches.of_commit('p', SHA) == {'default', 'tuning', 'short'}
  assert batches.of_commit('p', 'f' * 40) == set()
  assert batches.of_commit('other', SHA) == {'x'}
  assert len(batches) == 4


# ==========================================
# API
# ==========================================

@pytest.fixture
def api(monkeypatch):
  import backend.api.auth as auth
  import backend.models as models
  monkeypatch.setattr(auth, 'is_authorized_user', MagicMock(return_value=True))
  monkeypatch.setattr(auth, 'get_current_user', MagicMock(return_value={'is_authenticated': True, 'user_id': 2, 'user_name': 'bob'}))
  from backend.api import milestones
  monkeypatch.setattr(milestones, 'is_authorized_user', auth.is_authorized_user)
  monkeypatch.setattr(milestones, 'get_current_user', auth.get_current_user)
  monkeypatch.setattr(milestones, 'favorite_ids', lambda user_id, ids=None: set())
  db_session = MagicMock()
  monkeypatch.setattr(milestones, 'db_session', db_session)
  milestones.db = db_session
  yield milestones
  models.Milestone.reset_mock(return_value=True, side_effect=True)
  models.Project.reset_mock(return_value=True, side_effect=True)


def with_milestone(api, milestone):
  api.Milestone.query.filter.return_value.one_or_none.return_value = milestone


def call(dummy_app, handler, *args, method='GET', json=None, query=''):
  with dummy_app.test_request_context(f'/api/v1/milestones{query}', method=method, json=json):
    response = handler(*args)
    if isinstance(response, tuple):
      response, status = response
      response.status_code = status
    return response


def test_others_cannot_edit(api, dummy_app):
  with_milestone(api, make_milestone(user_id=1))
  response = call(dummy_app, api.edit_milestone, 1, method='POST', json={'label': 'mine now'})
  assert response.status_code == 403
  assert 'Only Alice A can edit' in response.get_json()['error']
  response = call(dummy_app, api.edit_milestone, 1, method='DELETE')
  assert response.status_code == 403
  api.db.delete.assert_not_called()


def test_owners_edit(api, dummy_app):
  milestone = make_milestone(user_id=2)
  with_milestone(api, milestone)
  response = call(dummy_app, api.edit_milestone, 1, method='POST', json={'label': 'renamed', 'group': 'a/ b', 'branch': 'dev'})
  assert response.status_code == 200
  assert (milestone.label, milestone.group, milestone.data) == ('renamed', 'a/b', {'branch': 'dev'})
  assert response.get_json()['label'] == 'renamed'
  response = call(dummy_app, api.edit_milestone, 1, method='DELETE')
  assert response.status_code == 200
  api.db.delete.assert_called_once_with(milestone)


def test_editing_a_milestone_without_owner_takes_it(api, dummy_app):
  milestone = make_milestone(user_id=None, user=None)
  with_milestone(api, milestone)
  assert call(dummy_app, api.edit_milestone, 1, method='POST', json={'notes': 'n'}).status_code == 200
  assert milestone.user_id == 2


def test_deleted_milestones(api, dummy_app):
  with_milestone(api, None)
  response = call(dummy_app, api.read_milestone, 7)
  assert response.status_code == 404
  assert 'deleted' in response.get_json()['error']


def test_links_need_access_to_the_project(api, dummy_app):
  with_milestone(api, make_milestone(shared=False, user_id=1))
  assert call(dummy_app, api.read_milestone, 1).status_code == 200
  api.is_authorized_user.return_value = False
  assert call(dummy_app, api.read_milestone, 1).status_code == 403


def test_saving_needs_a_login(api, dummy_app):
  api.get_current_user.return_value = {'is_authenticated': False}
  response = call(dummy_app, api.create_milestone, method='POST', json={'project': 'p', 'commit': SHA})
  assert response.status_code == 401
  assert 'Log in' in response.get_json()['error']


def test_create(api, dummy_app):
  created = []
  api.Milestone.side_effect = lambda **kwargs: created.append(make_milestone(id=3, **{**kwargs, 'user': None})) or created[-1]
  response = call(dummy_app, api.create_milestone, method='POST', json={'project': 'p', 'commit': SHA, 'label': 'best', 'batch': 'tuning', 'message': 'Faster'})
  assert response.status_code == 201
  assert (created[0].user_id, created[0].batch, created[0].shared, created[0].data) == (2, 'tuning', False, {'message': 'Faster'})
  assert response.get_json()['is_mine'] is True
  assert call(dummy_app, api.create_milestone, method='POST', json={'project': 'p'}).status_code == 400


def test_list_needs_a_project(api, dummy_app):
  assert call(dummy_app, api.list_milestones).status_code == 400


def test_import(api, dummy_app):
  projects = MagicMock()
  api.Project.query.filter.return_value = projects
  # the projects, in the body's order once sent as JSON: gone doesn't exist anymore, p does
  projects.one_or_none.side_effect = [None, SimpleNamespace(id='p')]
  # bob already imported v1.0
  api.Milestone.query.filter.return_value.filter.return_value = [make_milestone(user_id=2, label='v1.0')]
  added = []
  api.db.add.side_effect = added.append
  api.Milestone.side_effect = lambda **kwargs: SimpleNamespace(**kwargs)
  body = {'milestones': {
    'p': {f'p/{SHA}/default': {'commit': SHA, 'label': 'v1.0'}, f'p/{SHA}/tuning': {'commit': SHA, 'batch': 'tuning', 'label': 'try'}, 'bad': {}},
    'gone': {'gone/x/default': {'commit': 'x'}},
  }}
  response = call(dummy_app, api.import_milestones, method='POST', json=body)
  data = response.get_json()
  assert (data['imported'], data['done']) == (1, ['gone', 'p'])
  assert [(m.label, m.batch, m.user_id, m.shared) for m in added] == [('try', 'tuning', 2, False)]
  assert [s['reason'] for s in data['skipped']] == ["The project doesn't exist", 'Not a milestone']


def test_saving_needs_access_to_the_results_project(api, dummy_app):
  api.Project.query.filter.return_value = MagicMock(**{'one_or_none.return_value': SimpleNamespace(id='p')})
  api.is_authorized_user.side_effect = lambda user, project: project != 'secret'
  response = call(dummy_app, api.create_milestone, method='POST', json={'project': 'p', 'commit': SHA, 'commit_project': 'secret'})
  assert response.status_code == 403
  api.db.add.assert_not_called()


def test_favorite_groups(api, dummy_app):
  api.Project.query.filter.return_value = MagicMock(**{'one_or_none.return_value': SimpleNamespace(id='p')})
  api.MilestoneGroupFavorite.query.filter_by.return_value.one_or_none.return_value = None
  added = []
  api.db.add.side_effect = added.append
  api.MilestoneGroupFavorite.side_effect = lambda **kwargs: SimpleNamespace(**kwargs)
  response = call(dummy_app, api.favorite_group, method='POST', json={'project': 'p', 'section': 'mine', 'group': ' tuning / denoiser ', 'is_favorite': True})
  assert response.get_json() == {'section': 'mine', 'group': 'tuning/denoiser', 'is_favorite': True}
  assert [(f.user_id, f.project_id, f.section, f.group) for f in added] == [(2, 'p', 'mine', 'tuning/denoiser')]
  assert call(dummy_app, api.favorite_group, method='POST', json={'project': 'p', 'section': 'others', 'group': 'x'}).status_code == 400



RUNS = [
  {'path': 'indoor/kitchen.raw', 'database': '/data/indoor', 'platform': 'linux', 'batch': 'nightly', 'configurations': [{'gain': 3}], 'metadata': {'light': 'low'}},
  {'path': 'indoor/office.raw', 'database': '/data/indoor', 'platform': 'linux', 'batch': 'nightly', 'configurations': [{'gain': 4}], 'is_failed': True},
  {'path': 'night/street.raw', 'database': '/data/night', 'platform': 'arm', 'batch': 'night-set', 'configurations': [{'gain': 3}]},
  {'path': 'iteration', 'database': '/data/night', 'output_type': 'optim_iteration'},
]


def test_run_filter_is_the_web_apps():
  assert run_matcher('')(RUNS[0])
  assert run_matcher('indoor')(RUNS[0]) and not run_matcher('indoor')(RUNS[2])
  assert run_matcher('gain:3')(RUNS[0]) and not run_matcher('gain:3')(RUNS[1])
  assert run_matcher('-street')(RUNS[0]) and not run_matcher('-street')(RUNS[2])
  assert run_matcher('light:low')(RUNS[0])
  assert run_matcher('fail')(RUNS[1]) and not run_matcher('fail')(RUNS[0])
  # not a valid regular expression: searched as text
  assert not run_matcher('gain[')(RUNS[0])


def test_summarize_runs():
  summary = summarize_runs(RUNS)
  assert (summary['count'], summary['failed'], summary['inputs']) == (3, 1, 3)
  assert summary['databases'] == [{'name': '/data/indoor', 'runs': 2}, {'name': '/data/night', 'runs': 1}]
  assert summary['batches'] == [{'name': 'nightly', 'runs': 2}, {'name': 'night-set', 'runs': 1}]
  assert summary['platforms'] == [{'name': 'linux', 'runs': 2}, {'name': 'arm', 'runs': 1}]
  # with the milestone's filter
  filtered = summarize_runs(RUNS, 'gain:3')
  assert filtered['count'] == 2
  assert [d['name'] for d in filtered['databases']] == ['/data/indoor', '/data/night']
