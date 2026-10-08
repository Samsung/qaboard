"""
Tests for backend/api/outputs.py: how the CLI's updates change an output's status.
"""
import importlib.util
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest


@pytest.fixture
def outputs_api(monkeypatch):
  """Loads the real backend/api/outputs.py, with an existing output that failed"""
  models = sys.modules['backend.models']
  for name in ("TestInput", "CiCommit", "Output"):
    monkeypatch.setattr(models, name, MagicMock(), raising=False)
  path = Path(__file__).parent.parent / "backend" / "api" / "outputs.py"
  spec = importlib.util.spec_from_file_location("backend.api._outputs_status_under_test", path)
  module = importlib.util.module_from_spec(spec)
  spec.loader.exec_module(module)
  monkeypatch.setattr(module, "check_storage_path", lambda path: path)
  module.CiCommit.get_or_create.return_value.project.latest_output_datetime = None
  module.CiCommit.get_or_create.return_value.latest_output_datetime = None
  output = SimpleNamespace(data={}, deleted=False, is_failed=True, is_pending=False, is_running=False, metrics={"psnr": 30})
  output.to_dict = lambda: {"is_failed": output.is_failed, "is_pending": output.is_pending, "is_running": output.is_running}
  module.Output.get_or_create.return_value = output
  module.test_output = output
  return module


def notify(outputs_api, dummy_app, **data):
  body = {
    "git_commit_sha": "0" * 40, "project": "group/project", "batch_label": "default", "job_type": "ci",
    "user": "ci", "platform": "linux", "configurations": [], "extra_parameters": {},
    "input_path": "a.jpg", "database": "/datasets", "output_directory": "/storage/project/output",
    **data,
  }
  with dummy_app.test_request_context("/api/v1/output/", method="POST", json=body):
    response = outputs_api.new_output_webhook()
  return response.get_json()


@pytest.mark.parametrize("status", [{"is_pending": True}, {"is_pending": True, "is_running": True}])
def test_failed_output_running_again_is_not_failed(outputs_api, dummy_app, status):
  # qa batch says the run is pending, then qa run says it's running
  assert notify(outputs_api, dummy_app, **status) == {"is_failed": False, "is_pending": True, "is_running": status.get("is_running", False)}


@pytest.mark.parametrize("data, is_failed", [
  ({"metrics": {"is_failed": True}}, True),
  ({"metrics": {"is_failed": False}}, False),
  ({"is_failed": True}, True),
])
def test_finished_output_status(outputs_api, dummy_app, data, is_failed):
  notify(outputs_api, dummy_app, is_pending=True)
  assert notify(outputs_api, dummy_app, is_pending=False, **data)["is_failed"] == is_failed
