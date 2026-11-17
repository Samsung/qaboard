"""Requests with ids or fields that don't make sense are answered 400 or 404, not 500"""
import pytest

from .test_ingest import send, batch_payload


@pytest.mark.parametrize("method, url", [
  ('get', '/api/v1/output/not-a-number/'),
  ('get', '/api/v1/output/not-a-number/manifest/'),
  ('put', '/api/v1/output/not-a-number/'),
  ('delete', '/api/v1/output/not-a-number/'),
  ('patch', '/api/v1/output/not-a-number/metrics/'),
  ('patch', '/api/v1/output/not-a-number/progress/'),
  ('post', '/api/v1/output/redo/not-a-number/'),
  ('delete', '/api/v1/batch/not-a-number/'),
])
def test_ids_that_are_not_numbers(logged_in, method, url):
  alice = logged_in('alice')
  assert getattr(alice, method)(url, json={}).status_code == 404


@pytest.mark.parametrize("action", ['stop', 'redo', 'rename', 'move'])
@pytest.mark.parametrize("batch_id", ['not-a-number', {"id": 1}, [1]])
def test_batch_actions_on_ids_that_are_not_numbers(logged_in, action, batch_id):
  alice = logged_in('alice')
  response = alice.post(f'/api/v1/batch/{action}/', json={"id": batch_id, "label": "new"})
  assert response.status_code == 404, response.get_json()


@pytest.mark.parametrize("label", [None, "", 1])
def test_batches_need_a_label(client, label):
  response = client.post('/api/v1/batch/', json={**batch_payload(), "batch_label": label})
  assert response.status_code == 400, response.get_json()
  assert 'batch_label' in response.get_json()['error']


def test_moving_runs_needs_a_label(logged_in, make_client):
  from backend.models import Batch
  alice = logged_in('alice')
  assert send(make_client(), 'batch').status_code == 200
  batch_id = Batch.query.one().id
  for body in [{}, {"label": ""}, {"label": 1}]:
    response = alice.post('/api/v1/batch/move/', json={"id": batch_id, **body})
    assert response.status_code == 400, response.get_json()
