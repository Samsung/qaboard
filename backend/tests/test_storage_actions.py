"""
Tests for backend/jobs/storage_actions.py: importing the untracked runs a scan found. The database is mocked.
"""
import json
import sys
import types
import importlib.util
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest


@pytest.fixture
def storage_actions(monkeypatch):
  """The real backend/jobs/storage_actions.py, with a mocked database session"""
  database = types.ModuleType('backend.database')
  database.db_session = MagicMock(name='db_session')
  database.engine, database.make_engine = MagicMock(name='engine'), MagicMock(name='make_engine')
  monkeypatch.setitem(sys.modules, 'backend.database', database)
  for name in ('storage_usage', 'accounts'):
    module = types.ModuleType(f'backend.{name}')
    monkeypatch.setitem(sys.modules, f'backend.{name}', module)
  sys.modules['backend.storage_usage'].refresh_batches = MagicMock()
  sys.modules['backend.accounts'].resolve = lambda owner: owner
  models = sys.modules['backend.models']
  for name in ('Export', 'Output', 'TestInput', 'StorageScanEntry', 'StorageScan', 'Batch'):
    monkeypatch.setattr(models, name, MagicMock(name=name), raising=False)
  path = Path(__file__).parent.parent / "backend" / "jobs" / "storage_actions.py"
  spec = importlib.util.spec_from_file_location("backend.jobs._storage_actions_under_test", path)
  module = importlib.util.module_from_spec(spec)
  spec.loader.exec_module(module)
  return module


@pytest.fixture
def untracked_run(storage_actions, tmp_path):
  run_dir = tmp_path / 'output' / 'a.jpg'
  run_dir.mkdir(parents=True)
  (run_dir / 'run.json').write_text(json.dumps({"database": "/datasets", "input_path": "a.jpg", "platform": "linux"}))
  (run_dir / 'metrics.json').write_text(json.dumps({"psnr": 30}))
  entry = SimpleNamespace(kind='untracked_run', action=None, ref={"batch_id": 5}, bytes=10, owner='alice', newest_mtime=None)
  storage_actions.db_session.get.side_effect = lambda model, key: entry if model is storage_actions.StorageScanEntry else SimpleNamespace(id=5, ci_commit=SimpleNamespace(project_id='group/project'))
  storage_actions.Output.query.filter.return_value.first.return_value = None
  storage_actions.TestInput.query.filter.return_value.one_or_none.return_value = SimpleNamespace(id=12)
  return SimpleNamespace(path=str(run_dir), entry=entry)


def import_runs(storage_actions, paths):
  report = MagicMock()
  report.should_stop.return_value = False
  storage_actions.ImportRuns.run({"scan_id": 1, "paths": paths, "requested_by": "admin"}, report)
  return report


def test_imported_runs_are_recorded_for_the_inputs_tab(storage_actions, untracked_run, monkeypatch):
  record = MagicMock(return_value=True)
  monkeypatch.setattr(storage_actions, 'record_run_in_savepoint', record)
  report = import_runs(storage_actions, [untracked_run.path])
  assert untracked_run.entry.action == 'imported'
  report.add.assert_called_once()
  (session, input_id, project_id), kwargs = record.call_args
  assert (input_id, project_id) == (12, 'group/project')
  assert session is storage_actions.db_session and kwargs['new_output'] is True and kwargs['now'] is not None


def test_imports_go_on_if_the_input_cannot_be_recorded(storage_actions, untracked_run, monkeypatch):
  # e.g. before the migration that adds input_projects: the savepoint is undone, the run is imported
  from backend import input_catalog
  monkeypatch.setattr(input_catalog, 'record_run', MagicMock(side_effect=RuntimeError("relation input_projects does not exist")))
  session = storage_actions.db_session
  report = import_runs(storage_actions, [untracked_run.path])
  assert untracked_run.entry.action == 'imported'
  report.add.assert_called_once()
  session.begin_nested.assert_called_once()
  session.commit.assert_called_once()
  session.rollback.assert_not_called()
