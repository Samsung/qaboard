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
  directory = run_dir_of()
  directory.mkdir(parents=True)
  return directory


def run_dir_of(project="group/repo", commit=COMMIT, batch="default", platform="linux", configurations=(), extra_parameters=None, input_path="input", database="/datasets"):
  return uploads.run_dir(project, commit, batch, platform, list(configurations), extra_parameters or {}, input_path, database=database)


def send(run_dir, path, content: bytes, **kwargs):
  return save_file(run_dir, path, io.BytesIO(content), len(content), **kwargs)


# --- where files go ----------------------------------------------------------------------------------------------
def test_disabled_without_a_root(monkeypatch):
  monkeypatch.setattr(config, "upload_root", None)
  assert not uploads.enabled()
  assert uploads.project_of("/uploads/group/repo/-/01/23") is None


def test_run_dir_layout(upload_root):
  directory = run_dir_of(input_path="unit-tests")
  assert directory.parent.parent == upload_root / "group/repo/-/01/23456789abcdef0123456789abcdef01234567/output"
  assert directory.name == "unit-tests"
  labelled = run_dir_of("group/repo/sub", batch="nightly")
  assert labelled.is_relative_to(upload_root / "group/repo/sub/-/01/23456789abcdef0123456789abcdef01234567/output/nightly")


def test_runs_that_differ_have_their_own_folder(upload_root):
  runs = [
    {}, {"input_path": "Input"}, {"input_path": "in/put"}, {"input_path": "in-put"}, {"input_path": "input.jpg"}, {"input_path": "v1.2"}, {"input_path": "v1.3"},
    {"platform": "windows"}, {"configurations": ["O3"]}, {"configurations": ["o3"]}, {"configurations": [{"lr": 0.1}]},
    {"extra_parameters": {"seed": 1}}, {"extra_parameters": {"forwarded_args": ["-v"]}}, {"batch": "nightly"}, {"batch": "Nightly"},
    {"commit": "f" * 40}, {"commit": "<local:alice>"}, {"commit": "<local:bob>"}, {"project": "group/other"},
    {"database": "/other-datasets"},
  ]
  directories = [run_dir_of(**run) for run in runs]
  assert len(set(directories)) == len(runs)
  assert run_dir_of() == run_dir_of()


def test_run_dir_without_a_git_commit(upload_root):
  directory = run_dir_of(commit="<local:alice>")
  assert directory.is_relative_to(upload_root / "group/repo/-/local")


HOSTILE = ["..", ".", "../../../../../../victim/secret/-", "/etc", "a/../../b", "", "-", "\\..\\..", "..%2f..", "." * 70, "../" * 40]


@pytest.mark.parametrize("field", ["input_path", "batch", "platform", "commit", "configurations", "extra_parameters"])
@pytest.mark.parametrize("value", HOSTILE)
def test_nothing_a_client_says_about_a_run_leads_elsewhere(upload_root, field, value):
  value = {"configurations": [value], "extra_parameters": {value: value}}.get(field, value)
  directory = run_dir_of(**{field: value})
  runs = upload_root / "group/repo/-"
  assert os.path.normpath(directory) == str(directory)
  assert directory.is_relative_to(runs) and len(directory.relative_to(runs).parts) >= 4
  assert ".." not in directory.parts and "." not in directory.parts
  assert uploads.is_run_dir(directory, "group/repo") and not uploads.is_run_dir(directory, "victim/secret")


def test_is_run_dir(upload_root):
  runs = upload_root / "group/repo/-"
  assert uploads.is_run_dir(runs / "01/23/output/a/b", "group/repo")
  for directory in (runs, upload_root, upload_root / "group/repo", runs / "../../../victim/secret/-/01", f"{runs}/01/../../../../x", "/etc", "", None,
                    upload_root / "victim/secret/-/01/23/output/a/b"):
    assert not uploads.is_run_dir(directory, "group/repo"), directory
  assert not uploads.is_run_dir(runs / "01", "")
  assert not uploads.is_run_dir(upload_root / "a/-/b/-/01", "a/-/b")


@pytest.mark.parametrize("project", ["group/repo", "group/repo/sub/project", "solo"])
def test_project_of_reads_the_project_from_a_run_file(upload_root, project):
  path = run_dir_of(project) / "plots" / "loss.png"
  assert uploads.project_of(str(path)) == (str(upload_root / project), project)


def test_project_of_other_paths(upload_root):
  assert uploads.project_of(str(upload_root / "group/repo")) is None        # a project's folder, without runs
  assert uploads.project_of(str(upload_root)) is None
  assert uploads.project_of("/elsewhere/group/repo/-/01/23") is None
  # a sub-project can't be mistaken for a commit's folder: the first "-" ends the project
  assert uploads.project_of(str(upload_root / "group/repo/-/ab/-/x"))[1] == "group/repo"


def test_storage_settings_that_say_upload():
  # one definition for `qa` and the server (qaboard/conventions.py)
  from qaboard.conventions import sends_files, storage_setting
  assert sends_files({"storage": "upload"}) and sends_files({"ci_root": " Upload "}) and sends_files(None) and sends_files({})
  assert sends_files({"storage": "/mnt/qaboard"}, qa_storage="upload")
  assert storage_setting({"storage": "/a", "ci_root": "/b"}) == "/b"
  for settings in ({"storage": "/mnt/upload"}, {"storage": {"linux": "upload"}}):
    assert not sends_files(settings)


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


def test_commits_that_start_alike_have_their_own_folders(upload_root):
  # anyone who can send results creates commits: one named like another's first characters must not share its runs
  twin = COMMIT[:16] + "f" * 24
  assert run_dir_of(commit=twin) != run_dir_of()
  assert uploads.commit_artifacts_dir("group/repo", twin) != uploads.commit_artifacts_dir("group/repo", COMMIT)
  # artifacts saved before, in folders named by 16 characters, are still theirs
  assert uploads.is_commit_artifacts_dir(upload_root / "group/repo/-/01/23456789abcdef/artifacts", "group/repo")


def test_names_that_look_hashed_arent_the_folders_of_other_names(upload_root):
  hashed = uploads.folder_name("A/b")
  assert hashed.startswith("a-b-") and len(hashed) == len("a-b-") + uploads.HASH_LENGTH
  assert uploads.folder_name(hashed) != hashed
  assert run_dir_of(input_path=hashed) != run_dir_of(input_path="A/b")
  assert run_dir_of(batch=hashed) != run_dir_of(batch="A/b")
  assert uploads.folder_name("a-b-1f2e3d4c") != "a-b-1f2e3d4c"
  # names without a hash stay readable
  assert uploads.folder_name("unit-tests") == "unit-tests"


def test_symlinks_dont_create_folders_out_of_the_run(run_dir, tmp_path):
  outside = tmp_path / "outside"
  outside.mkdir()
  (run_dir / "link").symlink_to(outside)
  with pytest.raises(UploadError) as e:
    send(run_dir, "link/a/b/stolen.txt", b"x")
  assert e.value.reason == "invalid_path"
  assert list(outside.iterdir()) == []


def test_append_interrupted_leaves_the_file_as_it_was(run_dir):
  class Broken(io.BytesIO):
    def read(self, size=-1):
      if self.tell() >= 2:
        raise OSError("the client went away")
      return super().read(2)
  send(run_dir, "log.txt", b"one\n")
  with pytest.raises(OSError):
    save_file(run_dir, "log.txt", Broken(b"two\n"), 4, offset=4)
  assert (run_dir / "log.txt").read_bytes() == b"one\n"


def test_authorize_upload(outputs_api, dummy_app):
  """What nginx asks before it receives a file: only who may send results"""
  from flask import g
  def ask(actor):
    with dummy_app.test_request_context("/api/v1/uploads/authorize", method="PUT"):
      g.actor = actor
      response = outputs_api.authorize_upload()
    return response[1] if isinstance(response, tuple) else 200
  assert ask(None) == 401
  assert ask(SimpleNamespace(user=None, token=None)) == 401
  scopes = lambda *names: SimpleNamespace(user="u", token="t", has_scope=lambda scope: scope in names)
  assert ask(scopes("read")) == 403
  assert ask(scopes("ingest")) == 204
  assert ask(SimpleNamespace(user="u", token=None)) == 204


def test_authorize_upload_tells_nginx_it_checked(outputs_api, dummy_app):
  """nginx passes the header of the answer on with the file (snippets/qaboard-uploads-auth.conf)"""
  from flask import g
  with dummy_app.test_request_context("/api/v1/uploads/authorize", method="PUT"):
    g.actor = SimpleNamespace(user="u", token=None)
    _, status, headers = outputs_api.authorize_upload()
  assert status == 204 and headers == {"X-QABoard-Upload-Checked": "1"}
  with dummy_app.test_request_context("/api/v1/uploads/authorize", method="PUT"):
    g.actor = None
    assert len(outputs_api.authorize_upload()) == 2


UWSGI = {"uwsgi.version": b"2.0.28"}


@pytest.mark.parametrize("environ, refused", [
  # through nginx: refused unless it checked the token first
  (UWSGI, True),
  ({**UWSGI, "QABOARD_UPLOAD_CHECKED": ""}, True),  # without snippets/qaboard-files-server.conf
  ({**UWSGI, "QABOARD_UPLOAD_CHECKED": "1"}, False),
  # `flask run` on its own
  ({}, False),
])
def test_uploads_nginx_didnt_check_are_refused(outputs_api, dummy_app, upload_root, environ, refused):
  start(outputs_api, dummy_app)
  directory = Path(outputs_api.test_output.output_dir_override)
  with dummy_app.test_request_context("/api/v1/output/7/files/a.txt", method="PUT", data=b"x", environ_base=environ):
    response = outputs_api.upload_output_file(7, "a.txt")
  response, status = response if isinstance(response, tuple) else (response, 200)
  if refused:
    assert status == 500 and response.get_json()["reason"] == "proxy_misconfigured"
    assert "snippets/qaboard-files-server.conf" in response.get_json()["error"]
    assert not (directory / "a.txt").exists()
  else:
    assert status == 200 and (directory / "a.txt").read_bytes() == b"x"


def test_every_upload_endpoint_needs_nginx_to_check_it():
  """The endpoints behind snippets/qaboard-uploads-auth.conf (services/nginx/conf.d/qaboard.conf)"""
  import ast
  api = Path(__file__).parent.parent / "backend" / "api"
  for file, function in [("outputs.py", "upload_output_file"), ("commit_artifacts.py", "upload_commit_artifact"), ("batch.py", "append_submission_log")]:
    tree = ast.parse((api / file).read_text())
    body = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == function).body
    # the first thing it does, after its docstring
    first = body[1] if isinstance(body[0], ast.Expr) else body[0]
    assert "uploads.unchecked_by_proxy(request.environ)" in ast.unparse(first), (file, function)


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
  uploads.clean_run_dir(run_dir, "group/repo")
  assert run_dir.is_dir() and list(run_dir.iterdir()) == []
  assert (outside / "kept.txt").exists()
  uploads.clean_run_dir(run_dir / "missing", "group/repo")


def test_clean_only_the_projects_own_run_folders(run_dir, upload_root, tmp_path):
  send(run_dir, "kept.txt", b"x")
  victim = run_dir_of("victim/secret")
  victim.mkdir(parents=True)
  (victim / "kept.txt").write_text("kept")
  outside = tmp_path / "outside"
  outside.mkdir()
  (outside / "kept.txt").write_text("kept")
  runs = upload_root / "group/repo/-"
  (runs / "link").symlink_to(victim)
  for directory, project in [
    (victim, "group/repo"), (run_dir, "victim/secret"), (outside, "group/repo"), (upload_root, "group/repo"), (runs, "group/repo"),
    (runs / "../../../victim/secret/-" / victim.relative_to(upload_root / "victim/secret/-"), "group/repo"),
    (runs / "link", "group/repo"),   # a symlink out of the project's runs
  ]:
    uploads.clean_run_dir(Path(directory), project)
  assert (victim / "kept.txt").exists() and (outside / "kept.txt").exists() and (run_dir / "kept.txt").exists()


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
    output_dir_override=None, batch=SimpleNamespace(ci_commit=ci_commit),
  )
  output.to_dict = lambda: {"id": output.id, "output_dir": output.output_dir_override}
  output.set_status = lambda is_pending, is_running, **kwargs: output.__dict__.update(is_pending=bool(is_pending or is_running), is_running=bool(is_running))
  module.Output.get_or_create.return_value = output
  module.Output.query.filter.return_value.one.return_value = output
  module.Output.query.filter.return_value.one_or_none.return_value = output
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
  directory = Path(response.get_json()["output_dir"])
  assert directory == run_dir_of() and uploads.is_run_dir(directory, "group/repo")
  assert outputs_api.test_output.data["uploads_files"] is True
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


def a_batch_token(batch="default", commit=COMMIT, **data):
  return SimpleNamespace(kind="batch", data={"command_id": "c0ffee00-1", "project": "group/repo", "commit": commit, "batch": batch, **data})


def test_batch_tokens_only_send_their_batchs_runs(outputs_api, dummy_app):
  """The token of a batch QA-Board started (tokens.mint_for_batch) can't reach other batches' runs"""
  from flask import g
  outputs_api.test_output.batch.label = "default"
  def as_token(token, call):
    with dummy_app.test_request_context("/"):
      g.actor = SimpleNamespace(user="alice", token=token)
      return call()
  start(outputs_api, dummy_app)
  # its own batch
  own = a_batch_token()
  assert as_token(own, lambda: start(outputs_api, dummy_app))[1] == 200
  assert as_token(own, lambda: put(outputs_api, dummy_app, "log.txt"))[1] == 200
  # another batch, another commit
  for token in (a_batch_token("nightly"), a_batch_token(commit="f" * 40)):
    response, status = as_token(token, lambda: start(outputs_api, dummy_app))
    assert status == 403 and response.get_json()["reason"] == "batch_token_limited"
    body, status = as_token(token, lambda: put(outputs_api, dummy_app, "log.txt"))
    assert status == 403 and body["reason"] == "batch_token_limited" and "token of a batch" in body["error"]
  # other tokens: as before
  assert as_token(SimpleNamespace(kind="personal", data={}), lambda: put(outputs_api, dummy_app, "log.txt"))[1] == 200


def test_authorize_upload_with_a_batch_token(outputs_api, dummy_app):
  """nginx says which URL (QABOARD_ORIGINAL_URI): a batch token only sends its own batch's files"""
  from flask import g
  outputs_api.test_output.batch.label = "default"
  def ask(token, uri):
    environ = {"QABOARD_ORIGINAL_URI": uri} if uri is not None else {}
    with dummy_app.test_request_context("/api/v1/uploads/authorize", method="PUT", environ_base=environ):
      g.actor = SimpleNamespace(user="u", token=token, has_scope=lambda scope: True)
      response = outputs_api.authorize_upload()
    if isinstance(response, tuple) and response[1] == 403:
      assert response[0].get_json()["reason"] == "batch_token_limited"
    return response[1] if isinstance(response, tuple) else 200
  own, other = a_batch_token(), a_batch_token("nightly")
  assert ask(own, "/api/v1/output/7/files/log.txt?offset=4") == 204
  assert ask(other, "/api/v1/output/7/files/log.txt") == 403
  # artifacts: only `qa save-artifacts` sends them
  assert ask(own, f"/api/v1/commit/{COMMIT}/artifacts/files/qaboard.yaml?project=group/repo") == 403
  # its own log only (tokens.batch_token_for)
  with_log = a_batch_token(log_dir="/logs/x")
  with_log.projects = ["group/repo"]
  assert ask(with_log, "/api/v1/batch/submissions/c0ffee00-1/log?offset=0") == 204
  assert ask(with_log, "/api/v1/batch/submissions/c0ffee00-2/log?offset=0") == 403
  # nginx didn't say
  assert ask(own, None) == 403
  # other tokens don't depend on the URL
  assert ask("t", None) == 204


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


def test_hostile_runs_stay_in_their_projects_folder(outputs_api, dummy_app, upload_root):
  victim = run_dir_of("victim/secret")
  victim.mkdir(parents=True)
  (victim / "kept.txt").write_text("kept")
  # the review's attack: an input that climbs to another project's runs, with is_running so that the folder is emptied
  for attack in ({"input_path": "../../../../../../../victim/secret/-"}, {"input_path": "../" * 12}, {"platform": ".."}, {"batch_label": "../../.."}):
    response, status = start(outputs_api, dummy_app, **attack)
    assert status == 200
    directory = Path(response.get_json()["output_dir"])
    assert uploads.is_run_dir(directory, "group/repo") and os.path.normpath(directory) == str(directory)
    assert put(outputs_api, dummy_app, "kept.txt", b"pwned")[1] == 200
    assert (victim / "kept.txt").read_text() == "kept"
    assert (directory / "kept.txt").read_bytes() == b"pwned"


def test_the_database_cant_send_files_elsewhere(outputs_api, dummy_app, upload_root, tmp_path):
  """Other clients say where they saved their runs: a PUT only writes in a folder we could have chosen for the project"""
  start(outputs_api, dummy_app)
  victim = run_dir_of("victim/secret")
  victim.mkdir(parents=True)
  own = Path(outputs_api.test_output.output_dir_override)
  for directory in (victim, f"{own}/../../../../../../../victim/secret/-/x", tmp_path / "elsewhere", upload_root, f"{upload_root}/../outside"):
    outputs_api.test_output.output_dir_override = str(directory)
    body, status = put(outputs_api, dummy_app, "a.txt")
    assert (status, body["reason"]) == (409, "not_uploaded"), directory
  assert list(victim.iterdir()) == []
  # nor a run that didn't say it uploads, even in a folder of its project
  outputs_api.test_output.output_dir_override = str(own)
  outputs_api.test_output.data.pop("uploads_files")
  assert put(outputs_api, dummy_app, "a.txt")[0]["reason"] == "not_uploaded"


def test_clients_cant_say_their_results_are_in_the_uploads_folders(outputs_api, dummy_app, upload_root, monkeypatch):
  monkeypatch.setattr(outputs_api, "check_storage_path", lambda path: path)
  victim = run_dir_of("victim/secret")
  monkeypatch.setattr(outputs_api, "all_project_ids", lambda: ["victim/secret", "group/repo"])
  # nor above them: deleting the run would delete all the project's uploaded runs
  for directory in (victim, f"{upload_root}/x/../victim/secret/-/01", upload_root / "victim/secret", upload_root / "victim", upload_root, upload_root.parent):
    response, status = start(outputs_api, dummy_app, storage=None, output_directory=str(directory))
    assert status == 400 and response.get_json()["reason"] == "uploads_folder", directory
    response, status = start(outputs_api, dummy_app, storage=None, output_directory="/mnt/storage/x", artifacts_commit=str(directory))
    assert status == 400 and response.get_json()["reason"] == "uploads_folder", directory
  # through a symlink too
  (upload_root / "victim/secret").mkdir(parents=True)
  link = upload_root.parent / "link"
  link.symlink_to(upload_root / "victim", target_is_directory=True)
  for directory in (link, link / "secret"):
    response, status = start(outputs_api, dummy_app, storage=None, output_directory=str(directory))
    assert status == 400, directory
  response, status = start(outputs_api, dummy_app, storage=None, output_directory="/mnt/storage/group/repo/01/23/output/x")
  assert status == 200 and "uploads_files" not in outputs_api.test_output.data
  # the uploads folder can also be a storage that runs write to directly, like the quickstart's
  for directory in (upload_root / "group/repo/01/23456789abcdef0123456789abcdef01234567/output/linux/red", upload_root / "victim/secret/ab/cdef/output"):
    response, status = start(outputs_api, dummy_app, storage=None, output_directory=str(directory), artifacts_commit=str(directory.parent))
    assert status == 200, (directory, response.get_json())
  # and clients can't say that a run uploads
  start(outputs_api, dummy_app, storage=None, output_directory="/mnt/storage/x", data={"uploads_files": True})
  assert "uploads_files" not in outputs_api.test_output.data


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


# --- storage locations (backend/locations.py) --------------------------------------------------------------------
@pytest.fixture
def team_bucket(monkeypatch, tmp_path, upload_root):
  """group/'s runs go to a bucket, mounted on the server"""
  from backend import locations
  mount = tmp_path / "team-bucket"
  mount.mkdir()
  monkeypatch.setattr(locations, "_load", lambda: (locations.Location("s3://team-bucket/qaboard/", mount, ("group/",), id=1),))
  locations.invalidate()
  yield mount
  locations.invalidate()


def test_projects_runs_go_to_their_location(team_bucket, upload_root):
  directory = run_dir_of()
  assert directory.is_relative_to(team_bucket / "group/repo/-")
  assert uploads.is_run_dir(directory, "group/repo")
  assert uploads.project_of(str(directory / "log.txt")) == (str(team_bucket / "group/repo"), "group/repo")
  # their older runs are still theirs
  assert uploads.is_run_dir(upload_root / "group/repo/-/01/23/output/a/b", "group/repo")
  # the others' go to the upload root
  assert run_dir_of("other/repo").is_relative_to(upload_root / "other/repo/-")
  # a project's folder in a location is its own, wherever its new runs go
  assert not uploads.is_run_dir(team_bucket / "group/repo/-/01/23/output/a/b", "other/repo")


def test_projects_with_a_location_upload_without_an_upload_root(team_bucket, monkeypatch):
  monkeypatch.setattr(config, "upload_root", None)
  assert uploads.enabled("group/repo") and uploads.enabled()
  assert not uploads.enabled("other/repo")


def test_runs_in_a_location_store_its_url(outputs_api, dummy_app, team_bucket):
  response, status = start(outputs_api, dummy_app)
  assert status == 200
  location = outputs_api.test_output.output_dir_override
  assert location.startswith("s3://team-bucket/qaboard/group/repo/-/01/23456789abcdef0123456789abcdef01234567/output/")
  assert put(outputs_api, dummy_app, "log.txt", b"one\n", "?offset=0")[1] == 200
  assert list(team_bucket.rglob("log.txt"))[0].read_bytes() == b"one\n"
  # a run whose location the server can't reach takes no file
  outputs_api.test_output.output_dir_override = "s3://another-bucket/qaboard/group/repo/-/01/run"
  body, status = put(outputs_api, dummy_app, "a.txt")
  assert status == 409 and body["reason"] == "not_uploaded"


def test_a_location_that_takes_no_new_runs_still_owns_its_files(team_bucket, monkeypatch, upload_root):
  from backend import locations
  directory = run_dir_of()
  monkeypatch.setattr(locations, "_load", lambda: (locations.Location("s3://team-bucket/qaboard/", team_bucket, (), id=1),))
  locations.invalidate()
  # who can read them, and where the run's files can be written, don't change
  assert uploads.project_of(str(directory / "log.txt")) == (str(team_bucket / "group/repo"), "group/repo")
  assert uploads.is_run_dir(directory, "group/repo")
  # new runs go to the upload root
  assert run_dir_of().is_relative_to(upload_root)


def test_a_run_that_ends_stays_where_it_sent_its_files(outputs_api, dummy_app, upload_root, team_bucket, monkeypatch):
  from backend import locations
  monkeypatch.setattr(locations, "_load", lambda: ())
  locations.invalidate()
  start(outputs_api, dummy_app)
  started_in = outputs_api.test_output.output_dir_override
  assert started_in.startswith(str(upload_root))
  # meanwhile, the project's new runs go to a bucket
  monkeypatch.setattr(locations, "_load", lambda: (locations.Location("s3://team-bucket/qaboard/", team_bucket, ("group/",), id=1),))
  locations.invalidate()
  start(outputs_api, dummy_app, is_pending=False, is_running=False)
  assert outputs_api.test_output.output_dir_override == started_in
  # its next attempt goes there
  start(outputs_api, dummy_app)
  assert outputs_api.test_output.output_dir_override.startswith("s3://team-bucket/")


@pytest.fixture
def default_storage(tmp_path, monkeypatch):
  monkeypatch.setattr(config, "default_storage_root", tmp_path)
  return tmp_path


def test_a_server_with_the_default_storage_takes_uploads(default_storage):
  assert config._upload_root({}) == (default_storage, None)
  assert config._upload_root({"QABOARD_UPLOAD_ROOT": " "}) == (default_storage, None)


def test_sites_that_chose_their_storage_choose_where_uploads_go(default_storage):
  root, reason = config._upload_root({"QABOARD_STORAGE_ROOTS": "/algo:/data"})
  assert root is None and "QABOARD_UPLOAD_ROOT" in reason
  assert config._upload_root({"QABOARD_STORAGE_ROOTS": "/algo", "QABOARD_UPLOAD_ROOT": "/algo/uploads"}) == (Path("/algo/uploads"), None)


@pytest.mark.parametrize("value", ["off", "OFF", "false", "0", "none"])
def test_uploads_can_be_turned_off(default_storage, value):
  root, reason = config._upload_root({"QABOARD_UPLOAD_ROOT": value})
  assert root is None and "off" in reason


def test_no_uploads_where_the_server_cant_write(tmp_path, monkeypatch):
  monkeypatch.setattr(config, "default_storage_root", tmp_path / "missing")
  root, reason = config._upload_root({})
  assert root is None and "can't write" in reason


def test_refusals_say_why_and_where_to_read_more(monkeypatch):
  monkeypatch.setattr(config, "upload_off_reason", "QABOARD_UPLOAD_ROOT is off")
  message = uploads.disabled_message()
  assert "QABOARD_UPLOAD_ROOT is off" in message and "/docs/backend-admin/uploads" in message


@pytest.mark.parametrize("layout", ["uploaded", "shared-storage"])
def test_the_storage_scan_finds_commit_folders(layout):
  # the storage scan's (jobs/scan.py's commit_dirs_re)
  from qaboard.conventions import commit_dir_name
  commit_dirs_re = uploads.COMMIT_FOLDERS_IN_PATH
  hexsha = "0123456789abcdef0123456789abcdef01234567"
  # uploaded runs: the commit's full id; a shared storage: 16 characters of it
  commit_dir = uploads.commit_folder(hexsha) if layout == "uploaded" else commit_dir_name(hexsha)
  for path in (f"/root/group/repo/{commit_dir}", f"/root/group/repo/-/{commit_dir}/output/run/log.txt"):
    match = commit_dirs_re.search(path)
    assert match is not None, path
    assert hexsha.startswith(match.group('a') + match.group('b'))
    assert len(match.group('a') + match.group('b')) == len(str(commit_dir)) - 1
  # not folders that only start like one
  assert commit_dirs_re.search(f"/root/{commit_dir}0") is None


def test_is_commit_artifacts_dir_in_both_layouts(upload_root):
  hexsha = "0123456789abcdef0123456789abcdef01234567"
  directory = uploads.commit_artifacts_dir("group/repo", hexsha)
  assert uploads.is_commit_artifacts_dir(directory, "group/repo")
  short = directory.parent.parent / hexsha[2:16] / directory.name
  assert uploads.is_commit_artifacts_dir(short, "group/repo")
  assert not uploads.is_commit_artifacts_dir(directory.parent.parent / hexsha[2:20] / directory.name, "group/repo")


def test_nginx_snippets_refuse_without_their_server_snippet():
  """The checks nginx makes are locations of snippets/qaboard-files-server.conf: without it, they'd say yes to all"""
  import re
  snippets = Path(__file__).parent.parent.parent / "services" / "nginx" / "snippets"
  server = (snippets / "qaboard-files-server.conf").read_text()
  assert "set $qaboard_files_server_included 1;" in server
  checked = []
  for snippet in snippets.glob("*.conf"):
    text = snippet.read_text()
    for uri in re.findall(r'^\s*auth_request\s+(\S+);', text, re.M):
      if f"location = {uri} " in text:
        continue  # e.g. pgadmin.conf: its own check
      assert f"location = {uri} " in server, (snippet.name, uri)
      assert "if ($qaboard_files_server_included != 1) {" in text, snippet.name
      checked.append(snippet.name)
  assert {"qaboard-uploads-auth.conf", "qaboard-files-auth.conf", "qaboard-admins-only.conf"} <= set(checked)
  # and the backend's yes reaches the endpoints that receive files (uploads.unchecked_by_proxy)
  uploads_auth = (snippets / "qaboard-uploads-auth.conf").read_text()
  header = uploads.PROXY_CHECKED_HEADER.lower().replace('-', '_')
  assert f"auth_request_set $qaboard_upload_checked $upstream_http_{header};" in uploads_auth
  assert "uwsgi_param QABOARD_UPLOAD_CHECKED $qaboard_upload_checked;" in uploads_auth
