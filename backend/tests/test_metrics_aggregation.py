"""
Tests for backend/metrics_aggregation.py: the per-batch medians and averages of the runs' metrics,
e.g. for the chart above a branch's commits.

The SQL itself runs only against a real PostgreSQL: set QABOARD_TEST_DATABASE_URL (postgresql://user:password@host/db).
It works in temporary tables, in a transaction that is rolled back: nothing is written.
"""
import os
import re
import sys
from unittest.mock import MagicMock

import pytest

from backend.metrics_aggregation import aggregated_metrics, aggregation_query, metric_names


@pytest.fixture
def sql_text(monkeypatch):
  # conftest.py replaces sqlalchemy with an empty module
  monkeypatch.setattr(sys.modules['sqlalchemy'], 'text', lambda sql: sql, raising=False)


def test_no_query_without_metrics(sql_text):
  session = MagicMock()
  assert aggregated_metrics(session, [1, 2], {}) == {1: {}, 2: {}}
  assert aggregated_metrics(session, [1, 2], None) == {1: {}, 2: {}}
  assert aggregated_metrics(session, [], {'loss': 0.1}) == {}
  session.execute.assert_not_called()


def test_metric_names():
  assert metric_names({'loss': 0.1, 'recall': None}) == ['loss', 'recall']
  assert metric_names(['loss', 'loss', 3, '', None]) == ['loss']
  assert metric_names('loss') == []
  assert metric_names(None) == []


def test_one_query_for_all_batches(sql_text):
  session = MagicMock()
  session.execute.return_value.fetchall.return_value = [
    # batch_id, loss median, loss average, recall median, recall average
    (1, 0.5, 0.75, 0.9, 0.8),
    (2, None, None, float('nan'), 0.6),
  ]
  aggregated = aggregated_metrics(session, [1, 2, 3, 1], {'loss': 0.1, 'recall': 0.5})
  assert aggregated == {
    1: {'loss_median': 0.5, 'loss_average': 0.75, 'recall_median': 0.9, 'recall_average': 0.8},
    2: {'recall_average': 0.6},
    # no valid run
    3: {},
  }
  session.execute.assert_called_once()
  sql, params = session.execute.call_args.args
  assert params == {'metric_0': 'loss', 'metric_1': 'recall', 'batch_ids': [1, 2, 3]}
  assert 'GROUP BY batch_id' in sql


def test_metric_names_are_parameters():
  sql, params = aggregation_query(["it's"])
  assert "it's" not in sql
  assert params == {'metric_0': "it's"}


@pytest.fixture
def postgres(sql_text):
  url = os.environ.get('QABOARD_TEST_DATABASE_URL')
  if not url:
    pytest.skip("QABOARD_TEST_DATABASE_URL is not set")
  psycopg2 = pytest.importorskip('psycopg2')
  connection = psycopg2.connect(url)
  try:
    cursor = connection.cursor()
    # A temporary table hides the real one, if any
    cursor.execute("""
      CREATE TEMPORARY TABLE outputs (
        id serial PRIMARY KEY, batch_id integer,
        is_failed boolean, is_pending boolean, deleted boolean,
        metrics json NOT NULL DEFAULT '{}'::json
      ) ON COMMIT DROP
    """)
    yield connection, cursor
  finally:
    connection.rollback()
    connection.close()


class Session:
  """Runs the queries made with sqlalchemy.text (:name parameters) with psycopg2 (%(name)s)"""
  def __init__(self, cursor):
    self.cursor = cursor
    self.queries = 0

  def execute(self, sql, params):
    self.queries += 1
    self.cursor.execute(re.sub(r'(?<![:\w]):(\w+)', r'%(\1)s', sql.replace('%', '%%')), params)
    return self.cursor


def test_postgres_aggregation(postgres):
  connection, cursor = postgres
  def run(batch_id, metrics, is_failed=False, is_pending=False, deleted=False):
    cursor.execute(
      "INSERT INTO outputs (batch_id, is_failed, is_pending, deleted, metrics) VALUES (%s, %s, %s, %s, %s)",
      (batch_id, is_failed, is_pending, deleted, metrics),
    )
  for value in (1, 2, 3, 10):
    run(1, f'{{"loss": {value}, "recall": 0.5}}')
  # runs from old clients may have NULL statuses: they count
  run(1, '{"loss": 4}', is_failed=None, is_pending=None, deleted=None)
  # not valid runs
  run(1, '{"loss": 100}', is_failed=True)
  run(1, '{"loss": 100}', is_pending=True)
  run(1, '{"loss": 100}', deleted=True)
  # values that aren't numbers
  for metrics in ('{"loss": null}', '{"loss": "7"}', '{"loss": "n/a"}', '{"loss": true}', '{"loss": [1]}',
                  '{"loss": {"value": 1}}', '{}'):
    run(1, metrics)
  # a batch without any number
  run(2, '{"loss": "n/a"}')
  run(2, '{"recall": 0.25}', is_failed=True)
  # a batch we don't ask for
  run(3, '{"loss": 1000}')

  session = Session(cursor)
  aggregated = aggregated_metrics(session, [1, 2, 4], {'loss': 5, 'recall': 0.4, "it's": 1})
  assert session.queries == 1
  assert aggregated == {
    1: {'loss_median': 3.0, 'loss_average': 4.0, 'recall_median': 0.5, 'recall_average': 0.5},
    2: {},
    4: {},
  }
  # medians interpolate, like numpy's
  aggregated = aggregated_metrics(session, [1], {'recall': None})
  assert aggregated == {1: {'recall_median': 0.5, 'recall_average': 0.5}}
  run(5, '{"x": 1}')
  run(5, '{"x": 2}')
  assert aggregated_metrics(session, [5], {'x': None}) == {5: {'x_median': 1.5, 'x_average': 1.5}}
