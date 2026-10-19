"""
Tests for backend/metrics_definitions.py: the metrics runs declare in code, saved in their commit and project.
"""
from types import SimpleNamespace
from unittest.mock import MagicMock

from backend.metrics_definitions import clean_definitions, merged_definitions, available_metrics, save_metrics_definitions


def test_clean_definitions():
  assert clean_definitions(None) == {}
  assert clean_definitions([{"a": 1}]) == {}
  assert clean_definitions({"a": {"suffix": "%"}, "b": 1, 2: {}}) == {"a": {"suffix": "%"}, "2": {}}
  assert clean_definitions({str(i): {} for i in range(5001)}) == {}


def test_merged_definitions():
  known = {"a": {"suffix": "%", "target": 1}, "b": {}}
  assert merged_definitions(known, {"a": {"suffix": "%", "target": 1}}) is None
  # replaced as a whole: a target removed from the code is removed
  assert merged_definitions(known, {"a": {"suffix": "%"}, "c": {}}) == {"a": {"suffix": "%"}, "b": {}, "c": {}}
  assert merged_definitions(None, {"a": {}}) == {"a": {}}


def test_available_metrics():
  metrics_file = {"available_metrics": {"psnr": {"label": "PSNR", "smaller_is_better": False}, "loss": {}}}
  merged = available_metrics(metrics_file, {"psnr": {"suffix": " dB"}, "frames": {"smaller_is_better": None}})
  assert merged == {
    "psnr": {"label": "PSNR", "smaller_is_better": False, "suffix": " dB"},
    "loss": {},
    "frames": {"smaller_is_better": None},
  }
  assert metrics_file["available_metrics"]["psnr"] == {"label": "PSNR", "smaller_is_better": False}
  assert available_metrics(None, None) == {}


def make_commit(commit_data=None, project_data=None):
  project = SimpleNamespace(data=project_data)
  return SimpleNamespace(data=commit_data, project=project)


def run_data(definitions, branch="feature"):
  return {
    "metrics_definitions": definitions,
    "commit_branch": branch,
    "qaboard_config": {"project": {"reference_branch": "main"}},
  }


def test_saves_in_the_commit_and_the_reference_branch():
  session = MagicMock()
  commit = make_commit({"qatools_config": {}}, {"metrics_definitions": {"old": {}}})
  save_metrics_definitions(session, commit, run_data({"psnr": {"smaller_is_better": False}}))
  assert commit.data == {"qatools_config": {}, "metrics_definitions": {"psnr": {"smaller_is_better": False}}}
  # not on the reference branch: the project keeps its definitions
  assert commit.project.data == {"metrics_definitions": {"old": {}}}
  # the row is locked before it's updated
  session.refresh.assert_called_once_with(commit, with_for_update=True)

  save_metrics_definitions(session, commit, run_data({"psnr": {"smaller_is_better": False}}, branch="main"))
  assert commit.project.data == {"metrics_definitions": {"old": {}, "psnr": {"smaller_is_better": False}}}


def test_projects_without_definitions_get_them():
  commit = make_commit(None, None)
  save_metrics_definitions(MagicMock(), commit, run_data({"psnr": {}}))
  assert commit.data == {"metrics_definitions": {"psnr": {}}}
  assert commit.project.data == {"metrics_definitions": {"psnr": {}}}


def test_nothing_new_writes_nothing():
  session = MagicMock()
  definitions = {"psnr": {"suffix": " dB"}}
  commit = make_commit({"metrics_definitions": definitions}, {"metrics_definitions": definitions})
  save_metrics_definitions(session, commit, run_data(definitions, branch="main"))
  save_metrics_definitions(session, commit, run_data({}, branch="main"))
  session.refresh.assert_not_called()
  session.commit.assert_not_called()
