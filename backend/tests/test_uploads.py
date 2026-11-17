"""
Tests for the files runs send over HTTP: backend/uploads.py, and its endpoints in backend/api/outputs.py.
"""
import hashlib
import importlib.util
import io
import os
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from backend import config, uploads
from backend.uploads import UploadError, save_file

COMMIT = "0123456789abcdef0123456789abcdef01234567"


@pytest.fixture
def upload_root(tmp_path, monkeypatch):
  root = tmp_path / "uploads"
  root.mkdir()
  monkeypatch.setattr(config, "upload_root", root)
  monkeypatch.setattr(config, "upload_min_free_space", 0)
  return root


@pytest.fixture
def run_dir(upload_root):
  directory = uploads.run_dir("group/repo", COMMIT, "default", "abc123/input")
  directory.mkdir(parents=True)
  return directory


def send(run_dir, path, content: bytes, **kwargs):
  return save_file(run_dir, path, io.BytesIO(content), len(content), **kwargs)


# --- where files go ----------------------------------------------------------------------------------------------
def test_disabled_without_a_root(monkeypatch):
  monkeypatch.setattr(config, "upload_root", None)
  assert not uploads.enabled()
  assert uploads.project_of("/uploads/group/repo/-/01/23") is None


def test_run_dir_layout(upload_root):
  assert uploads.run_dir("group/repo", COMMIT, "default", "abc/input") == upload_root / "group/repo/-/01/23456789abcdef/output/abc/input"
  labelled = uploads.run_dir("group/repo/sub", COMMIT, "nightly", "abc/input")
  assert labelled.is_relative_to(upload_root / "group/repo/sub/-/01/23456789abcdef/output")
  assert labelled != uploads.run_dir("group/repo/sub", COMMIT, "default", "abc/input")


def test_run_dir_without_a_git_commit(upload_root):
  directory = uploads.run_dir("group/repo", "<local:alice>", "default", "abc/input")
  assert directory.is_relative_to(upload_root / "group/repo/-/local")
  assert ".." not in directory.parts and "<local:alice>" not in directory.parts


@pytest.mark.parametrize("project", ["group/repo", "group/repo/sub/project", "solo"])
def test_project_of_reads_the_project_from_a_run_file(upload_root, project):
  path = uploads.run_dir(project, COMMIT, "default", "abc/input") / "plots" / "loss.png"
  assert uploads.project_of(str(path)) == (str(upload_root / project), project)


def test_project_of_other_paths(upload_root):
  assert uploads.project_of(str(upload_root / "group/repo")) is None        # a project's folder, without runs
  assert uploads.project_of(str(upload_root)) is None
  assert uploads.project_of("/elsewhere/group/repo/-/01/23") is None
  # a sub-project can't be mistaken for a commit's folder: the first "-" ends the project
  assert uploads.project_of(str(upload_root / "group/repo/-/ab/-/x"))[1] == "group/repo"


def test_storage_settings_that_say_upload():
  assert uploads.is_upload_setting({"storage": "upload"})
  assert uploads.is_upload_setting({"ci_root": " Upload "})
  assert uploads.is_upload_setting({"storage": "/mnt/qaboard"}, qa_storage="upload")
  for settings in (None, {}, {"storage": "/mnt/upload"}, {"storage": {"linux": "upload"}}):
    assert not uploads.is_upload_setting(settings)


def test_projects_with_a_dash_folder_are_not_supported():
  assert uploads.supports_project("group/repo-name/sub-project")
  assert not uploads.supports_project("group/-/repo")


# --- which paths clients can name ---------------------------------------------------------------------------------
@pytest.mark.parametrize("path", [
  "", "/etc/passwd", "../other-run/log.txt", "a/../../b", "a//b", "a/./b", "a/", "a\\b", "a\0b",
  "x" * 2000, "a/" + "x" * 300, ".qaboard-upload-1234", "plots/.qaboard-upload-1234",
])
def test_refused_paths(path):
  with pytest.raises(UploadError) as e:
    uploads.clean_path(path)
  assert e.value.status == 400 and e.value.reason == "invalid_path"


@pytest.mark.parametrize("path", ["log.txt", "plots/loss.png", "a b/é.txt", ".hidden", "deep/er/and/deeper.bin"])
def test_accepted_paths(path):
  assert str(uploads.clean_path(path)) == path


# --- saving files -------------------------------------------------------------------------------------------------
def test_save_replaces_the_file(run_dir):
  assert send(run_dir, "plots/loss.json", b"first") == 5
  assert send(run_dir, "plots/loss.json", b"second!") == 7
  assert (run_dir / "plots/loss.json").read_bytes() == b"second!"
  assert [p.name for p in (run_dir / "plots").iterdir()] == ["loss.json"]   # no temporary file left


def test_save_checks_the_digest(run_dir):
  send(run_dir, "a.bin", b"kept")
  assert send(run_dir, "b.bin", b"data", sha256=hashlib.sha256(b"data").hexdigest().upper()) == 4
  with pytest.raises(UploadError) as e:
    send(run_dir, "a.bin", b"corrupted", sha256=hashlib.sha256(b"other").hexdigest())
  assert e.value.status == 422 and e.value.reason == "digest_mismatch"
  # the previous file is still there, and nothing else
  assert (run_dir / "a.bin").read_bytes() == b"kept"
  assert sorted(p.name for p in run_dir.iterdir()) == ["a.bin", "b.bin"]


def test_save_refuses_incomplete_uploads(run_dir):
  with pytest.raises(UploadError) as e:
    save_file(run_dir, "a.bin", io.BytesIO(b"short"), 100)
  assert e.value.reason == "incomplete"
  assert list(run_dir.iterdir()) == []


def test_save_ignores_what_follows_the_declared_size(run_dir):
  save_file(run_dir, "a.bin", io.BytesIO(b"0123456789"), 4)
  assert (run_dir / "a.bin").read_bytes() == b"0123"


def test_save_refuses_large_files(run_dir, monkeypatch):
  monkeypatch.setattr(config, "upload_max_file_size", 10)
  with pytest.raises(UploadError) as e:
    send(run_dir, "a.bin", b"x" * 11)
  assert e.value.status == 413 and e.value.details == {"max_file_size": 10}
  send(run_dir, "log.txt", b"x" * 8, offset=0)
  with pytest.raises(UploadError) as e:
    send(run_dir, "log.txt", b"x" * 3, offset=8)
  assert e.value.status == 413


def test_save_refuses_when_the_disk_is_full(run_dir, monkeypatch):
  monkeypatch.setattr(config, "upload_min_free_space", 10 ** 18)
  with pytest.raises(UploadError) as e:
    send(run_dir, "a.bin", b"x")
  assert e.value.status == 507


def test_a_file_cant_replace_a_folder_or_be_under_a_file(run_dir):
  send(run_dir, "plots/loss.json", b"{}")
  for path in ("plots", "plots/loss.json/nested.txt"):
    with pytest.raises(UploadError) as e:
      send(run_dir, path, b"x")
    assert e.value.status == 409 and e.value.reason == "path_conflict"
  assert (run_dir / "plots/loss.json").read_bytes() == b"{}"


def test_symlinks_dont_take_files_out_of_the_run(run_dir, tmp_path):
  outside = tmp_path / "outside"
  outside.mkdir()
  (run_dir / "link").symlink_to(outside)
  with pytest.raises(UploadError) as e:
    send(run_dir, "link/stolen.txt", b"x")
  assert e.value.reason == "invalid_path"
  assert list(outside.iterdir()) == []
  # a link named like the file is replaced, not followed
  (outside / "target.txt").write_text("untouched")
  (run_dir / "file.txt").symlink_to(outside / "target.txt")
  send(run_dir, "file.txt", b"new")
  assert (outside / "target.txt").read_text() == "untouched"
  assert not (run_dir / "file.txt").is_symlink() and (run_dir / "file.txt").read_bytes() == b"new"
  # and never appended through
  (run_dir / "log.txt").symlink_to(outside / "target.txt")
  with pytest.raises((UploadError, OSError)):
    send(run_dir, "log.txt", b"more", offset=9)
  assert (outside / "target.txt").read_text() == "untouched"


def test_append(run_dir):
  assert send(run_dir, "log.txt", b"one\n", offset=0) == 4
  assert send(run_dir, "log.txt", b"two\n", offset=4) == 8
  assert (run_dir / "log.txt").read_bytes() == b"one\ntwo\n"


@pytest.mark.parametrize("offset", [0, 2, 100])
def test_append_at_the_wrong_offset_says_the_size(run_dir, offset):
  send(run_dir, "log.txt", b"one\n")
  with pytest.raises(UploadError) as e:
    send(run_dir, "log.txt", b"two\n", offset=offset)
  assert e.value.status == 409 and e.value.details == {"size": 4}
  assert (run_dir / "log.txt").read_bytes() == b"one\n"


def test_append_that_fails_leaves_the_file_as_it_was(run_dir):
  send(run_dir, "log.txt", b"one\n")
  with pytest.raises(UploadError):
    send(run_dir, "log.txt", b"two\n", offset=4, sha256="0" * 64)
  with pytest.raises(UploadError):
    save_file(run_dir, "log.txt", io.BytesIO(b"tw"), 10, offset=4)
  assert (run_dir / "log.txt").read_bytes() == b"one\n"


def test_clean_run_dir(run_dir, upload_root, tmp_path):
  send(run_dir, "a.txt", b"x")
  send(run_dir, "plots/b.txt", b"x")
  outside = tmp_path / "outside"
  outside.mkdir()
  (outside / "kept.txt").write_text("kept")
  (run_dir / "link").symlink_to(outside)
  uploads.clean_run_dir(run_dir)
  assert run_dir.is_dir() and list(run_dir.iterdir()) == []
  assert (outside / "kept.txt").exists()
  # never outside the upload folder, whatever the database says
  uploads.clean_run_dir(outside)
  assert (outside / "kept.txt").exists()
  uploads.clean_run_dir(run_dir / "missing")


# --- the API ------------------------------------------------------------------------------------------------------
@pytest.fixture
def outputs_api(monkeypatch, upload_root):
  """The real backend/api/outputs.py, with one run of group/repo"""
  models = sys.modules['backend.models']
  for name in ("TestInput", "CiCommit", "Output"):
    monkeypatch.setattr(models, name, MagicMock(), raising=False)
  path = Path(__file__).parent.parent / "backend" / "api" / "outputs.py"
  spec = importlib.util.spec_from_file_location("backend.api._outputs_uploads_under_test", path)
  module = importlib.util.module_from_spec(spec)
  spec.loader.exec_module(module)
  module.required_tokens = []
  monkeypatch.setattr(module, "ingest_access", lambda project_id, require_token=False: (module.required_tokens.append(require_token), (None, None))[1])
  monkeypatch.setattr(module, "is_authorized_user", lambda user, project_id: True)
  monkeypatch.setattr(module, "invalid_project", lambda project_id: None)
  ci_commit = module.CiCommit.get_or_create.return_value
  ci_commit.project.latest_output_datetime = None
  ci_commit.latest_output_datetime = None
  ci_commit.project_id = "group/repo"
  ci_commit.hexsha = COMMIT
  ci_commit.get_or_create_batch.return_value.label = "default"
  output = SimpleNamespace(
    id=7, data={}, deleted=False, is_failed=False, is_pending=False, is_running=False, metrics={},
    output_folder="abc123/input", output_dir_override=None, batch=SimpleNamespace(ci_commit=ci_commit),
  )
  output.to_dict = lambda: {"id": output.id, "output_dir": output.output_dir_override}
  output.set_status = lambda is_pending, is_running: output.__dict__.update(is_pending=bool(is_pending or is_running), is_running=bool(is_running))
  module.Output.get_or_create.return_value = output
  module.Output.query.filter.return_value.one.return_value = output
  module.test_output = output
  return module


def start(outputs_api, dummy_app, **data):
  body = {
    "git_commit_sha": COMMIT, "project": "group/repo", "batch_label": "default", "job_type": "ci",
    "user": "ci", "platform": "linux", "configurations": [], "extra_parameters": {},
    "input_path": "input", "database": "/datasets", "storage": "upload", "is_pending": True, "is_running": True,
    **data,
  }
  with dummy_app.test_request_context("/api/v1/output/", method="POST", json=body):
    response = outputs_api.new_output_webhook()
  return response if isinstance(response, tuple) else (response, 200)


def put(outputs_api, dummy_app, path, content=b"data", query="", headers=None, output_id=7):
  with dummy_app.test_request_context(f"/api/v1/output/{output_id}/files/{path}{query}", method="PUT", data=content, headers=headers or {}):
    response = outputs_api.upload_output_file(output_id, path)
  response, status = response if isinstance(response, tuple) else (response, 200)
  return response.get_json(), status


def test_run_that_uploads_gets_its_folder_from_the_server(outputs_api, dummy_app, upload_root):
  # what the client says about folders is ignored
  response, status = start(outputs_api, dummy_app, output_directory="/etc", artifacts_commit="/etc")
  assert status == 200
  expected = upload_root / "group/repo/-/01/23456789abcdef/output/abc123/input"
  assert response.get_json()["output_dir"] == str(expected)
  assert outputs_api.CiCommit.get_or_create.return_value.commit_dir_override is None


def test_uploads_always_need_a_token(outputs_api, dummy_app):
  start(outputs_api, dummy_app)
  put(outputs_api, dummy_app, "log.txt")
  assert outputs_api.required_tokens == [True, True]
  # runs saved in a shared storage: what ingest.auth says
  start(outputs_api, dummy_app, storage=None, output_directory=None)
  assert outputs_api.required_tokens[-1] is False


def test_uploads_need_the_server_to_accept_them(outputs_api, dummy_app, monkeypatch):
  monkeypatch.setattr(config, "upload_root", None)
  response, status = start(outputs_api, dummy_app)
  assert status == 400 and response.get_json()["reason"] == "uploads_disabled"
  body, status = put(outputs_api, dummy_app, "log.txt")
  assert status == 400 and body["reason"] == "uploads_disabled"


def test_starting_again_removes_the_previous_files(outputs_api, dummy_app, upload_root):
  start(outputs_api, dummy_app)
  assert put(outputs_api, dummy_app, "plots/a.png") == ({"path": "plots/a.png", "size": 4}, 200)
  directory = Path(outputs_api.test_output.output_dir_override)
  # the end of the run, `qa batch` saying it's pending again, a run that continues: the files stay
  start(outputs_api, dummy_app, is_pending=False, is_running=False)
  start(outputs_api, dummy_app, is_pending=True, is_running=False)
  start(outputs_api, dummy_app, keep_previous=True)
  assert (directory / "plots/a.png").exists()
  start(outputs_api, dummy_app)
  assert directory.is_dir() and list(directory.iterdir()) == []


def test_put_saves_appends_and_checks(outputs_api, dummy_app):
  start(outputs_api, dummy_app)
  directory = Path(outputs_api.test_output.output_dir_override)
  assert put(outputs_api, dummy_app, "log.txt", b"one\n", "?offset=0")[0] == {"path": "log.txt", "size": 4}
  assert put(outputs_api, dummy_app, "log.txt", b"two\n", "?offset=4")[0]["size"] == 8
  body, status = put(outputs_api, dummy_app, "log.txt", b"three\n", "?offset=4")
  assert status == 409 and body["reason"] == "offset_mismatch" and body["size"] == 8
  assert (directory / "log.txt").read_bytes() == b"one\ntwo\n"
  body, status = put(outputs_api, dummy_app, "a.bin", b"data", headers={"X-Content-SHA256": "0" * 64})
  assert status == 422 and body["reason"] == "digest_mismatch"
  assert put(outputs_api, dummy_app, "../a.bin")[1] == 400
  assert put(outputs_api, dummy_app, "log.txt", query="?offset=abc")[1] == 400


def test_put_only_for_running_runs_that_upload(outputs_api, dummy_app):
  start(outputs_api, dummy_app)
  start(outputs_api, dummy_app, is_pending=False, is_running=False)
  body, status = put(outputs_api, dummy_app, "late.txt")
  assert status == 409 and body["reason"] == "not_running"
  # a run saved in a shared storage
  outputs_api.test_output.is_pending = True
  outputs_api.test_output.output_dir_override = "/mnt/storage/group/repo/output"
  body, status = put(outputs_api, dummy_app, "a.txt")
  assert status == 409 and body["reason"] == "not_uploaded"
  assert not os.path.exists("/mnt/storage/group/repo/output/a.txt")


def test_put_needs_access_to_the_project(outputs_api, dummy_app, monkeypatch):
  start(outputs_api, dummy_app)
  directory = Path(outputs_api.test_output.output_dir_override)
  monkeypatch.setattr(outputs_api, "ingest_access", lambda project_id, require_token=False: (None, ("refused", 403)))
  with dummy_app.test_request_context("/api/v1/output/7/files/a.txt", method="PUT", data=b"x"):
    assert outputs_api.upload_output_file(7, "a.txt") == ("refused", 403)
  monkeypatch.setattr(outputs_api, "is_authorized_user", lambda user, project_id: False)
  monkeypatch.setattr(outputs_api, "forbidden_project", lambda project_id: ("hidden", 403))
  with dummy_app.test_request_context("/api/v1/output/7/files/a.txt", method="PUT", data=b"x"):
    assert outputs_api.upload_output_file(7, "a.txt") == ("hidden", 403)
  assert not (directory / "a.txt").exists()
