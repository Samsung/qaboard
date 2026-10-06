"""
Tests for backend/storage.py: the server only writes, deletes or runs code in the storage folders.
"""
import os
from pathlib import Path

import pytest

from backend import storage
from backend.storage import check_storage_path, check_inside, is_storage_path, UnsafePathError


@pytest.fixture
def roots(tmp_path, monkeypatch):
  """Two storage roots, and the server's own folders, under tmp_path"""
  for d in ["storage", "datasets", "server/data", "server/shared", "server/git", "server/home", "elsewhere"]:
    (tmp_path / d).mkdir(parents=True)
  monkeypatch.setattr(storage, "storage_roots", [tmp_path / "storage", tmp_path / "datasets"])
  monkeypatch.setattr(storage, "qaboard_data_dir", tmp_path / "server/data")
  monkeypatch.setattr(storage, "qaboard_data_shared_dir", tmp_path / "server/shared")
  monkeypatch.setattr(storage, "qaboard_data_git_dir", tmp_path / "server/git")
  monkeypatch.delenv("QABOARD_IMAGE_CACHE_DIR", raising=False)
  monkeypatch.setattr(storage.pwd, "getpwuid", lambda uid: type("pw", (), {"pw_dir": str(tmp_path / "server/home")}))
  return tmp_path


@pytest.mark.parametrize("path", [
  "storage/project/outputs/run",
  "datasets/x",
  "storage/does/not/exist/yet",
  "storage/a/../b",
])
def test_storage_paths_allowed(roots, path):
  assert check_storage_path(roots / path) == roots / path
  assert is_storage_path(roots / path)


@pytest.mark.parametrize("path", [
  "storage",            # the root itself
  "elsewhere/x",
  "storage/../elsewhere",
  "storage-other/x",    # a prefix of a root isn't the root
  "/etc",
  "/",
])
def test_storage_paths_refused(roots, path):
  with pytest.raises(UnsafePathError):
    check_storage_path(roots / path)
  assert not is_storage_path(roots / path)


def test_relative_paths_are_refused(roots):
  with pytest.raises(UnsafePathError):
    check_storage_path("relative/path")


def test_symlinks_are_resolved(roots):
  (roots / "storage/link").symlink_to(roots / "elsewhere")
  with pytest.raises(UnsafePathError):
    check_storage_path(roots / "storage/link/x")


def test_server_folders_are_refused_even_inside_the_storage(roots, monkeypatch):
  # e.g. at SIRC the git clones and the shared folder are under /algo and /home
  monkeypatch.setattr(storage, "storage_roots", [roots])
  for path in ["server/data/x", "server/shared", "server/git/repo", "server/home/.ssh", "server"]:
    with pytest.raises(UnsafePathError):
      check_storage_path(roots / path)
  check_storage_path(roots / "storage/x")


def test_image_cache_is_refused(roots, monkeypatch):
  monkeypatch.setattr(storage, "storage_roots", [roots])
  monkeypatch.setenv("QABOARD_IMAGE_CACHE_DIR", str(roots / "storage/cache"))
  with pytest.raises(UnsafePathError):
    check_storage_path(roots / "storage/cache/x")


def test_check_inside(roots):
  output_dir = roots / "storage/output"
  assert check_inside(output_dir / "image.png", output_dir) == output_dir / "image.png"
  check_inside(output_dir / "sub/../image.png", output_dir)
  for file in ["../other-output/x", "../../../etc/passwd", "/etc/passwd"]:
    with pytest.raises(UnsafePathError):
      check_inside(output_dir / file, output_dir)


def test_rm_empty_parents_stops_at_the_storage_roots(roots):
  from backend.fs_utils import rm_empty_parents
  run = roots / "storage/project/commit/run"
  run.mkdir(parents=True)
  run.rmdir()
  rm_empty_parents(run)
  assert not (roots / "storage/project").exists()
  assert (roots / "storage").exists()


def test_check_inside_accepts_symlinks_to_elsewhere(roots):
  # e.g. outputs that link to their inputs
  output_dir = roots / "storage/output"
  output_dir.mkdir()
  (output_dir / "input.png").symlink_to(roots / "elsewhere")
  check_inside(output_dir / "input.png", output_dir)
  with pytest.raises(UnsafePathError):
    check_inside(output_dir / "input.png/../../x", output_dir)
  with pytest.raises(UnsafePathError):
    check_inside(output_dir / "..", output_dir)


def test_rmtree_deletes_symlinks_not_their_targets(roots):
  from backend.fs_utils import rmtree
  (roots / "elsewhere/precious.txt").write_text("keep me")
  output_dir = roots / "storage/output"
  output_dir.mkdir()
  (output_dir / "file.txt").write_text("delete me")
  (output_dir / "link-to-dir").symlink_to(roots / "elsewhere")
  (output_dir / "link-to-file").symlink_to(roots / "elsewhere/precious.txt")
  (output_dir / "broken-link").symlink_to(roots / "does-not-exist")
  rmtree(output_dir)
  assert not os.path.lexists(output_dir)
  assert (roots / "elsewhere/precious.txt").read_text() == "keep me"


# ==========================================
# POST /api/v1/output refuses folders outside the storage
# ==========================================

@pytest.fixture
def outputs_api(monkeypatch):
  """Loads the real backend/api/outputs.py"""
  import sys
  import importlib.util
  from unittest.mock import MagicMock
  models = sys.modules['backend.models']
  for name in ("TestInput", "CiCommit", "Output"):
    monkeypatch.setattr(models, name, MagicMock(), raising=False)
  path = Path(__file__).parent.parent / "backend" / "api" / "outputs.py"
  spec = importlib.util.spec_from_file_location("backend.api._outputs_under_test", path)
  module = importlib.util.module_from_spec(spec)
  spec.loader.exec_module(module)
  return module


@pytest.mark.parametrize("field, value", [
  ("output_directory", "/etc/qaboard"),
  ("artifacts_commit", "/tmp"),
  ("output_directory", "STORAGE/../elsewhere"),
])
def test_new_output_refuses_folders_outside_the_storage(roots, outputs_api, dummy_app, field, value):
  body = {
    "git_commit_sha": "0" * 40, "project": "group/project",
    "output_directory": str(roots / "storage/project/output"),
    "artifacts_commit": str(roots / "storage/project/artifacts"),
  }
  body[field] = value.replace("STORAGE", str(roots / "storage"))
  with dummy_app.test_request_context("/api/v1/output/", method="POST", json=body):
    response, status = outputs_api.new_output_webhook()
  assert status == 400
  assert "storage" in response.get_json()["error"]
  outputs_api.CiCommit.get_or_create.assert_not_called()
