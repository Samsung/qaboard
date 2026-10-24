"""
Where batches come from and who started them (backend/origins.py), and the lists of my commits and batches
(?scope=mine, ?origin=, backend/mine.py)
"""
from .conftest import bearer, login
from .test_ingest import output_payload, batch_payload, PROJECT, SHA


def batch(label='default', sha=SHA):
  from backend.database import db_session
  from backend.models import CiCommit, Batch
  db_session.remove()
  return Batch.query.join(CiCommit).filter(CiCommit.hexsha == sha, Batch.label == label).one()


def run(client, headers=None, **extra):
  response = client.post('/api/v1/output/', json=output_payload(**extra), headers=headers or {})
  assert response.status_code == 200, response.get_data(as_text=True)


def test_local_runs(client):
  run(client, batch_label='@alice| tries', run_context={"origin": "local"})
  saved = batch('@alice| tries')
  assert (saved.origin, saved.user_name, saved.user_id) == ('local', 'alice', None)
  assert saved.latest_output_datetime is not None
  assert saved.outputs[0].data['origin'] == 'local'


def test_ci_runs_with_custom_labels(client):
  run(client, batch_label='nightly', job_type='ci', user='qaboard', run_context={"origin": "ci", "provider": "gitlab"})
  assert batch('nightly').origin == 'ci'


def test_the_ci_wins_over_local_runs(client):
  """People who share runs before pushing use the CI's labels"""
  run(client, user='alice', run_context={"origin": "local"})
  run(client, user='qaboard', job_type='ci', rel_input_path='inputs/b.txt', run_context={"origin": "ci"})
  run(client, user='alice', rel_input_path='inputs/c.txt', run_context={"origin": "local"})
  assert (batch().origin, batch().user_name) == ('ci', 'qaboard')


def test_commits_are_their_authors(make_user, make_client, client):
  """Commits merged from GitHub have it as committer"""
  make_user('alice')
  commit(client, 'a' * 40, committer='GitHub', email='noreply@github.com', job_type='ci', user='qaboard', commit_author_email='Alice@example.com')
  alice = login(make_client(), 'alice')
  assert set(commits(alice, scope='mine')) == {'a'}


def test_old_clients(client):
  """Without run_context: job_type"""
  run(client, job_type='ci', user='qaboard')
  run(client, batch_label='mine', job_type='local')
  assert (batch().origin, batch('mine').origin) == ('ci', 'local')


def test_service_accounts_are_the_ci(client, make_user):
  """Even when the CLI says otherwise"""
  from backend.database import db_session
  from backend.tokens import mint
  bot = make_user('ci-bot', kind='service')
  _, secret = mint(bot, 'ci', ['read', 'ingest'])
  db_session.commit()
  bot_id = bot.id
  run(client, headers=bearer(secret), user='qaboard', run_context={"origin": "local"})
  saved = batch()
  assert (saved.origin, saved.user_name, saved.user_id) == ('ci', 'ci-bot', bot_id)


def test_webapp_runs(client):
  """The web app's runs export CI=true: they're recognized from their submission, also with old clients"""
  from backend.database import db_session
  from backend.models import CiCommit
  from backend.submissions import record_submission
  client.post('/api/v1/batch/', json={**batch_payload(), 'batch_label': 'tuning'})
  saved = batch('tuning')
  saved.origin = saved.user_name = None  # as if created by `qa batch` before the server knew
  record_submission(saved, {"id": "command-1", "created_at": "2026-10-01T12:00:00Z", "user": "bob"})
  db_session.commit()
  assert (batch('tuning').origin, batch('tuning').user_name) == ('webapp', 'bob')

  # an old CLI, from a submission on the CI's batch: the run is the web app's, the batch stays the CI's
  run(client, job_type='ci', user='qaboard')
  ci = batch()
  record_submission(ci, {"id": "redo-1", "created_at": "2026-10-01T13:00:00Z", "user": "bob"})
  db_session.commit()
  run(client, job_type='ci', user='bob', rel_input_path='inputs/b.txt', data={"root_command_id": "redo-1"})
  ci = batch()
  assert (ci.origin, ci.user_name) == ('ci', 'qaboard')
  assert sorted(o.data['origin'] for o in ci.outputs) == ['ci', 'webapp']
  assert CiCommit.query.one().author_email is None


def commit(client, sha, committer='Alice', email=None, label='default', **extra):
  payload = output_payload(commit_sha=sha, commit_committer_name=committer, batch_label=label, **extra)
  if email:
    payload['commit_committer_email'] = email
  response = client.post('/api/v1/output/', json=payload)
  assert response.status_code == 200, response.get_data(as_text=True)


def commits(client, **params):
  response = client.get('/api/v1/commits', query_string={"project": PROJECT, "from": "2026-09-01T00:00:00.000Z", "to": "2026-10-30T00:00:00.000Z", **params})
  assert response.status_code == 200, response.get_data(as_text=True)
  return {c['id'][:1]: sorted(c['batches']) for c in response.get_json()}


def test_my_commits(make_user, make_client, client):
  """Results are sent anonymously (signed-in, alice would be their verified sender), alice reads"""
  make_user('alice', email='Alice@Example.com')
  alice = login(make_client(), 'alice')
  commit(client, 'a' * 40, email='alice@example.com', job_type='ci', user='qaboard')         # I wrote it
  commit(client, 'b' * 40, committer='Bob', email='bob@example.com', job_type='ci', user='qaboard')
  commit(client, 'b' * 40, committer='Bob', label='@alice| try', user='alice')               # I ran it
  commit(client, 'c' * 40, committer='Bob', email='bob@example.com', user='qaboard', job_type='ci')
  commit(client, 'd' * 40, committer='alice', user='qaboard', job_type='ci')                 # an old commit, my name
  commit(client, 'e' * 40, committer='Carol', email='carol@home.org', user='qaboard', job_type='ci')

  assert set(commits(alice)) == set('abcde')
  assert set(commits(alice, scope='mine')) == set('abd')
  # without the CI's: only the commits with other batches, with those batches
  assert commits(alice, origin='webapp,local') == {'b': ['@alice| try']}

  # git emails users add to their preferences
  alice.post('/api/v1/user/preferences', json={"preferences": {"git_emails": ["carol@home.org"]}})
  assert set(commits(alice, scope='mine')) == set('abde')

  counts = alice.get('/api/v1/commit-counts', query_string={"project": PROJECT}).get_json()
  assert counts == {"all": 5, "mine": 4, "without_ci": 1}

  batches = alice.get('/api/v1/batches', query_string={"scope": "mine"}).get_json()
  assert [(b['label'], b['project'], b['commit']['id'][:1], b['origin']) for b in batches] == [('@alice| try', PROJECT, 'b', 'local')]
  assert batches[0]['valid_outputs'] == 1


def test_scope_mine_needs_users(client):
  assert client.get('/api/v1/commits', query_string={"project": PROJECT, "scope": "mine"}).status_code == 401
  assert client.get('/api/v1/batches', query_string={"scope": "mine"}).status_code == 401
  assert client.get('/api/v1/batches').status_code == 400
  assert client.get('/api/v1/commits', query_string={"project": PROJECT, "origin": "nope"}).status_code == 400
  assert client.get('/api/v1/commit-counts', query_string={"project": PROJECT}).get_json()["mine"] is None


def test_my_batches_only_in_projects_i_can_read(logged_in, client, monkeypatch):
  """dave's batches in a project made private, where he has no role, aren't listed anymore"""
  monkeypatch.setenv('QABOARD_ADMINS', 'root')
  root, dave = logged_in('root'), logged_in('dave')
  commit(client, 'a' * 40, label='@dave| try', user='dave')
  assert len(dave.get('/api/v1/batches', query_string={"scope": "mine"}).get_json()) == 1
  assert root.post('/api/v1/project/access/visibility', json={"project": PROJECT, "visibility": "private"}).status_code == 200
  assert dave.get('/api/v1/batches', query_string={"scope": "mine"}).get_json() == []
  assert dave.get('/api/v1/batches', query_string={"scope": "mine", "project": PROJECT}).status_code in (403, 404)


def test_search_by_origin_and_user(client):
  commit(client, 'a' * 40, job_type='ci', user='qaboard')
  commit(client, 'b' * 40, label='@alice| try', user='alice')
  assert set(commits(client, q='origin:local')) == {'b'}
  assert set(commits(client, q='-origin:local')) == {'a'}
  assert set(commits(client, q='user:ali')) == {'b'}


def test_ci_batches_link_to_their_pipeline(client):
  context = {"origin": "ci", "provider": "gitlab", "pipeline_url": "https://gitlab.example.com/p/-/pipelines/1", "job_url": "javascript:alert(1)"}
  response = client.post('/api/v1/batch/', json={**batch_payload(), 'job_type': 'ci', 'run_context': context, 'data': {'run_context': {'job_url': 'javascript:alert(2)'}}})
  assert response.status_code == 200, response.get_data(as_text=True)
  assert batch().data['run_context'] == {"origin": "ci", "provider": "gitlab", "pipeline_url": "https://gitlab.example.com/p/-/pipelines/1"}
