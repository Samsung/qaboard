"""
What the home page needs (webapp/src/home/): my running and failed batches, my recent ones with their project's default
metric, teammates' batches in my projects (?projects=, ?scope=others), and my projects (my_latest_activity)
"""
import datetime

from .test_ingest import output_payload, PROJECT


OTHER = 'other/repo'


def run(client, **extra):
  response = client.post('/api/v1/output/', json=output_payload(**extra))
  assert response.status_code == 200, response.get_data(as_text=True)


def labels(client, **params):
  response = client.get('/api/v1/batches', query_string=params)
  assert response.status_code == 200, response.get_data(as_text=True)
  return sorted((b['project'], b['label']) for b in response.get_json())


def set_batch(label, **fields):
  from backend.database import db_session
  from backend.models import Batch
  db_session.remove()
  batch = Batch.query.filter(Batch.label == label).one()
  for key, value in fields.items():
    setattr(batch, key, value)
  db_session.commit()


def test_others_batches_in_my_projects(logged_in, client, monkeypatch):
  monkeypatch.setenv('QABOARD_ADMINS', 'root')
  root, alice = logged_in('root'), logged_in('alice')
  run(client, batch_label='@alice| try', user='alice')
  run(client, batch_label='@bob| try', user='bob')
  run(client, batch_label='nightly', user='qaboard', job_type='ci', run_context={"origin": "ci"})
  run(client, project=OTHER, batch_label='@bob| other', user='bob')
  run(client, project='secret/repo', batch_label='@bob| secret', user='bob')
  assert root.post('/api/v1/project/access/visibility', json={"project": 'secret/repo', "visibility": "private"}).status_code == 200

  projects = f'{PROJECT},{OTHER},secret/repo'
  assert labels(alice, projects=projects, scope='others', origin='webapp,local') == [(PROJECT, '@bob| try'), (OTHER, '@bob| other')]
  assert labels(alice, projects=projects) == [(PROJECT, '@alice| try'), (PROJECT, '@bob| try'), (PROJECT, 'nightly'), (OTHER, '@bob| other')]
  # only projects alice can't read
  assert labels(alice, projects='secret/repo') == []
  # the CI's batches have no user: they're not mine either
  assert (PROJECT, 'nightly') in labels(alice, projects=PROJECT, scope='others')

  assert client.get('/api/v1/batches', query_string={"projects": PROJECT, "scope": "others"}).status_code == 401
  assert alice.get('/api/v1/batches', query_string={"projects": PROJECT, "project": PROJECT}).status_code == 400
  # across all projects: only mine
  assert alice.get('/api/v1/batches', query_string={"scope": "others"}).status_code == 400
  # anonymous visitors (a public instance): public projects only
  assert labels(client, projects=projects, origin='webapp,local') == [(PROJECT, '@alice| try'), (PROJECT, '@bob| try'), (OTHER, '@bob| other')]


def test_status_filters_are_recent(logged_in, client):
  """Filters on runs only look at the batches of the last 30 days by default, at most 90"""
  alice = logged_in('alice')
  run(client, batch_label='old', user='alice', is_failed=True)
  set_batch('old', latest_output_datetime=datetime.datetime.utcnow() - datetime.timedelta(days=40))
  assert labels(alice, scope='mine', status='failed') == []
  assert labels(alice, scope='mine', status='failed', since_days=60) == [(PROJECT, 'old')]
  set_batch('old', latest_output_datetime=datetime.datetime.utcnow() - datetime.timedelta(days=100))
  assert labels(alice, scope='mine', status='failed', since_days=365) == []


def test_my_running_and_failed_batches(logged_in, client):
  alice = logged_in('alice')
  run(client, batch_label='running', user='alice', is_pending=True)
  run(client, batch_label='failed', user='alice', is_failed=True)
  run(client, batch_label='failed long ago', user='alice', is_failed=True)
  run(client, batch_label='ok', user='alice')
  set_batch('failed long ago', latest_output_datetime=datetime.datetime.utcnow() - datetime.timedelta(days=10))

  assert labels(alice, scope='mine', status='pending') == [(PROJECT, 'running')]
  assert labels(alice, scope='mine', status='failed') == [(PROJECT, 'failed'), (PROJECT, 'failed long ago')]
  assert labels(alice, scope='mine', status='failed', since_days=7) == [(PROJECT, 'failed')]
  assert alice.get('/api/v1/batches', query_string={"scope": "mine", "status": "nope"}).status_code == 400


def test_each_projects_default_metric(logged_in, client):
  from backend.database import db_session
  from backend.models import Project
  alice = logged_in('alice')
  run(client, batch_label='a', user='alice', metrics={"loss": 2.0, "psnr": 30})
  run(client, project=OTHER, batch_label='b', user='alice', metrics={"loss": 2.0, "psnr": 30})
  run(client, project='third/repo', batch_label='c', user='alice')
  db_session.remove()
  for project_id, metric in [(PROJECT, 'loss'), (OTHER, 'psnr')]:
    project = db_session.get(Project, project_id)
    project.data = {**project.data, 'qatools_metrics': {'default_metric': metric, 'available_metrics': {'psnr': {'label': 'PSNR', 'suffix': 'dB'}}}}
  db_session.commit()

  batches = alice.get('/api/v1/batches', query_string={"scope": "mine", "metrics": "default"}).get_json()
  metrics = {b['label']: (b['default_metric'], b['default_metric_info'], b['aggregated_metrics'], b['valid_outputs']) for b in batches}
  assert metrics == {
    'a': ('loss', None, {'loss_median': 2.0, 'loss_average': 2.0, 'loss_sum': 2.0}, 1),
    'b': ('psnr', {'label': 'PSNR', 'suffix': 'dB'}, {'psnr_median': 30.0, 'psnr_average': 30.0, 'psnr_sum': 30.0}, 1),
    'c': (None, None, {}, 1),
  }


def test_my_projects(logged_in, client):
  alice = logged_in('alice', email='alice@example.com')
  run(client, batch_label='@alice| try', user='alice')
  # a commit alice wrote, the CI ran
  run(client, project=OTHER, commit_sha='c' * 40, commit_author_email='alice@example.com', user='qaboard', job_type='ci')
  run(client, project='third/repo', user='bob')

  projects = alice.get('/api/v1/projects?summary=true').get_json()
  assert projects[PROJECT]['my_latest_activity'] is not None
  assert projects[OTHER]['my_latest_activity'].startswith('2026-10-01')
  assert projects['third/repo']['my_latest_activity'] is None
  # only for signed-in users
  assert 'my_latest_activity' not in client.get('/api/v1/projects?summary=true').get_json()[PROJECT]
