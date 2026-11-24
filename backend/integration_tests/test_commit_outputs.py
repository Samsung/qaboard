"""
What the commit page and the history page get about runs: /api/v1/commit/<id> and /api/v1/commits?with_outputs=true.
Outputs are serialized from SQL rows (models/Output.py outputs_of_batches), like Output.to_dict() does from ORM objects.
"""
from .test_ingest import PROJECT, SHA, send


# what the web app reads about runs (src/api/normalize.js and the viewers)
OUTPUT_KEYS = {
  'id', 'output_type', 'platform', 'configurations', 'extra_parameters', 'metrics', 'is_failed', 'is_pending',
  'is_running', 'data', 'deleted', 'created_date', 'queued_at', 'started_at', 'finished_at', 'output_dir_url',
  'test_input_database', 'test_input_path', 'test_input_metadata',
}


def send_runs(client, monkeypatch, tmp_path):
  import backend.storage
  monkeypatch.setattr(backend.storage, 'storage_roots', [tmp_path])
  # saved where `qa` says, or where the server expects them
  for extra in (
    {"output_directory": str(tmp_path / "outputs" / "run 1"), "metrics": {"loss": 1.0, "status": "ok"}},
    {"rel_input_path": "inputs/b.txt", "configurations": ["base", {"threshold": 2}], "is_pending": True},
    {"rel_input_path": "inputs/c.txt", "platform": "lsf", "metrics": {"loss": 3.0, "is_failed": True}},
  ):
    response = send(client, 'output', **extra)
    assert response.status_code == 200, response.get_data(as_text=True)


def orm_outputs():
  from backend.database import db_session
  from backend.models import Output
  db_session.remove()
  return {str(o.id): o.to_dict() for o in Output.query.all()}


def test_commit_outputs_are_those_of_the_orm(client, monkeypatch, tmp_path):
  send_runs(client, monkeypatch, tmp_path)
  expected = orm_outputs()
  assert len(expected) == 3 and all(set(o) == OUTPUT_KEYS for o in expected.values())

  response = client.get(f'/api/v1/commit/{SHA}?project={PROJECT}')
  assert response.status_code == 200
  outputs = response.get_json()['batches']['default']['outputs']
  assert outputs == expected
  by_path = {o['test_input_path']: o for o in outputs.values()}
  assert by_path['inputs/a.txt']['output_dir_url'].endswith('/outputs/run%201')
  assert by_path['inputs/b.txt']['configurations'] == ['base', {'threshold': 2}] and by_path['inputs/b.txt']['is_pending']
  assert by_path['inputs/c.txt']['is_failed'] and by_path['inputs/c.txt']['metrics'] == {'loss': 3.0, 'is_failed': True}

  # the latest commit on a branch
  response = client.get(f'/api/v1/commit/?project={PROJECT}&branch=master')
  assert response.status_code == 200 and response.get_json()['batches']['default']['outputs'] == expected

  # the history page
  response = client.get(f'/api/v1/commits/master?project={PROJECT}&with_outputs=true&only_ci_batches=true&from=2026-09-01T00:00:00.000Z&to=2026-10-02T00:00:00.000Z')
  assert response.status_code == 200
  commit, = response.get_json()
  assert commit['batches']['default']['outputs'] == expected
  assert commit['batches']['default']['valid_outputs'] == 1 and commit['batches']['default']['pending_outputs'] == 1

  # without outputs
  response = client.get(f'/api/v1/commit/{SHA}?project={PROJECT}&with_outputs=false')
  assert 'outputs' not in response.get_json()['batches']['default']


def test_commits_without_outputs_have_none(client):
  assert send(client, 'batch').status_code == 200
  response = client.get(f'/api/v1/commit/{SHA}?project={PROJECT}')
  assert response.get_json()['batches']['default']['outputs'] == {}
  response = client.get(f'/api/v1/commits?project={PROJECT}&with_outputs=true&from=2026-09-01T00:00:00.000Z&to=2026-10-02T00:00:00.000Z')
  assert response.get_json()[0]['batches']['default']['outputs'] == {}
