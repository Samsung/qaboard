"""
Tests for backend/api/batch.py: what the CLI sends when it starts a batch of runs.
"""
import sys
import types
import importlib.util
from pathlib import Path
from unittest.mock import MagicMock

import pytest


HEXSHA = "0123456789abcdef0123456789abcdef01234567"


@pytest.fixture
def batch_api(monkeypatch):
  """Loads the real backend/api/batch.py"""
  models = sys.modules['backend.models']
  monkeypatch.setattr(models, "CiCommit", MagicMock())
  export_to_folder = types.ModuleType('backend.api.export_to_folder')
  export_to_folder.filter_outputs = MagicMock()
  monkeypatch.setitem(sys.modules, 'backend.api.export_to_folder', export_to_folder)
  path = Path(__file__).parent.parent / "backend" / "api" / "batch.py"
  spec = importlib.util.spec_from_file_location("backend.api._batch_under_test", path)
  module = importlib.util.module_from_spec(spec)
  spec.loader.exec_module(module)
  ci_commit = module.CiCommit.get_or_create.return_value
  ci_commit.data = {}
  ci_commit.get_or_create_batch.return_value.id = 1
  ci_commit.get_or_create_batch.return_value.data = {}
  return module


@pytest.mark.parametrize("commit", [{"commit_sha": HEXSHA}, {"git_commit_sha": HEXSHA}])
def test_update_batch_commit(batch_api, dummy_app, commit):
  # The CLI also sends git_commit_sha for backward-compatibility, other clients don't have to
  body = {"project": "group/project", "batch_label": "default", **commit}
  with dummy_app.test_request_context("/api/v1/batch/", method="POST", json=body):
    assert batch_api.update_batch().get_json() == {"status": "OK", "id": 1}
  assert batch_api.CiCommit.get_or_create.call_args.kwargs["hexsha"] == HEXSHA
