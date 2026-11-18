"""
Tests for a commit's artifacts sent over HTTP: where the server saves them (backend/uploads.py), its endpoints
(backend/api/commit_artifacts.py), the commits that then run from there (CiCommit), and the scripts that `cd` there
or fetch them (backend/artifacts.py).
"""
import hashlib
import importlib.util
import json
import os
import subprocess
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from backend import config, uploads
from backend.artifacts import UPLOADED_ARTIFACTS, cd_lines, commit_cd_lines
from .test_ci_commit import ci_commit_model  # noqa: F401 (a fixture)

COMMIT = "0123456789abcdef0123456789abcdef01234567"


@pytest.fixture
def upload_root(tmp_path, monkeypatch):
  root = tmp_path / "uploads"
  root.mkdir()
  monkeypatch.setattr(config, "upload_root", root)
  monkeypatch.setattr(config, "upload_min_free_space", 0)
  return root


# --- where they go -----------------------------------------------------------------------------------------------
def test_commit_artifacts_dir_layout(upload_root):
  directory = uploads.commit_artifacts_dir("group/repo", COMMIT)
  assert directory == upload_root / "group/repo/-/01/23456789abcdef/artifacts"
  # next to the commit's runs, never one of them
  assert directory.parent == uploads.run_dir("group/repo", COMMIT, "default", "linux", [], {}, "input").parent.parent.parent
  assert uploads.is_commit_artifacts_dir(directory, "group/repo")
  # each subproject has its own copy
  assert uploads.commit_artifacts_dir("group/repo/sub", COMMIT) == upload_root / "group/repo/sub/-/01/23456789abcdef/artifacts"


@pytest.mark.parametrize("commit", ["<local:alice>", "0123", COMMIT.upper(), f"../{COMMIT[3:]}", "", None])
def test_artifacts_are_for_git_commits(upload_root, commit):
  with pytest.raises(uploads.UploadError) as error:
    uploads.commit_artifacts_dir("group/repo", commit)
  assert error.value.status == 400 and error.value.reason == "invalid_commit"


def test_is_commit_artifacts_dir(upload_root):
  runs = upload_root / "group/repo/-"
  assert uploads.is_commit_artifacts_dir(runs / "01/23456789abcdef/artifacts", "group/repo")
  for directory in (runs / "01/23456789abcdef/output", runs / "01/23456789abcdef/artifacts/sub", runs / "01/23456789abcdef",
                    runs / "local/alice/artifacts", runs / "01/../01/23456789abcdef/artifacts", upload_root / "other/repo/-/01/23456789abcdef/artifacts",
                    "/etc", "", None):
    assert not uploads.is_commit_artifacts_dir(directory, "group/repo"), directory
  assert not uploads.is_commit_artifacts_dir(runs / "01/23456789abcdef/artifacts", "other/repo")


# --- the endpoints -----------------------------------------------------------------------------------------------
@pytest.fixture
def commit(ci_commit_model):
  """A real CiCommit of group/repo/sub, that the server knows"""
  ci_commit = ci_commit_model.CiCommit.__new__(ci_commit_model.CiCommit)
  ci_commit.hexsha = COMMIT
  ci_commit.project_id = "group/repo/sub"
  ci_commit.project = SimpleNamespace(id="group/repo/sub", id_relative="sub", storage_roots=lambda config: {"artifacts": Path("/nowhere"), "subproject": Path()})
  ci_commit.data = {}
  ci_commit.commit_dir_override = None
  ci_commit.deleted = False
  return ci_commit


@pytest.fixture
def api(monkeypatch, upload_root, commit):
  """The real backend/api/commit_artifacts.py"""
  path = Path(__file__).parent.parent / "backend" / "api" / "commit_artifacts.py"
  spec = importlib.util.spec_from_file_location("backend.api._commit_artifacts_under_test", path)
  module = importlib.util.module_from_spec(spec)
  spec.loader.exec_module(module)
  module.required_tokens = []
  monkeypatch.setattr(module, "ingest_access", lambda project_id, require_token=False: (module.required_tokens.append(require_token), (None, None))[1])
  monkeypatch.setattr(module, "is_authorized_user", lambda user, project_id: True)
  monkeypatch.setattr(module, "invalid_project", lambda project_id: None)
  monkeypatch.setattr(module, "db_session", MagicMock())
  monkeypatch.setattr(module, "flag_modified", lambda *args: None)
  monkeypatch.setattr(module, "find_commit", lambda project_id, hexsha: commit if (project_id, hexsha) == (commit.project_id, commit.hexsha) else None)
  return module


def put(api, dummy_app, path, content=b"data", sha256=None, commit=COMMIT, project="group/repo/sub"):
  headers = {"X-Content-SHA256": sha256 if sha256 is not None else hashlib.sha256(content).hexdigest()}
  with dummy_app.test_request_context(f"/api/v1/commit/{commit}/artifacts/files/{path}?project={project}", method="PUT", data=content, headers=headers):
    response = api.upload_commit_artifact(commit, path)
  response, status = response if isinstance(response, tuple) else (response, 200)
  return response.get_json(), status


def listing(api, dummy_app, commit=COMMIT, project="group/repo/sub"):
  with dummy_app.test_request_context(f"/api/v1/commit/{commit}/artifacts?project={project}"):
    response = api.get_commit_artifacts(commit)
  response, status = response if isinstance(response, tuple) else (response, 200)
  return response.get_json(), status


def send_artifacts(api, dummy_app, files: dict, manifest="sub/manifests/__qaboard.yaml.json", executables=()):
  """What `qa save-artifacts` sends: the files, then their manifest"""
  for path, content in files.items():
    assert put(api, dummy_app, path, content)[1] == 200
  listed = {path: {"sha256": hashlib.sha256(content).hexdigest(), "st_size": len(content), "executable": path in executables} for path, content in files.items()}
  assert put(api, dummy_app, manifest, json.dumps(listed).encode())[1] == 200


def test_sent_artifacts_are_the_commits(api, dummy_app, upload_root, commit):
  send_artifacts(api, dummy_app, {"qaboard.yaml": b"project: {name: group/repo}\n", "sub/qaboard.yaml": b"inputs: {}\n", "build/tool": b"\x7fELF"}, executables={"build/tool"})
  directory = upload_root / "group/repo/sub/-/01/23456789abcdef/artifacts"
  assert (directory / "build/tool").read_bytes() == b"\x7fELF"
  assert api.required_tokens and all(api.required_tokens)
  # the commit runs from there: checks, batch files, deletion all read that folder
  assert commit.data[UPLOADED_ARTIFACTS] == str(directory)
  assert commit.repo_artifacts_dir == directory and commit.artifacts_dir == directory / "sub"
  assert commit.artifacts_status()["ok"]

  body, status = listing(api, dummy_app)
  assert status == 200 and body["subproject"] == "sub"
  assert set(body["files"]) == {"qaboard.yaml", "sub/qaboard.yaml", "build/tool", "sub/manifests/__qaboard.yaml.json"}
  assert body["files"]["build/tool"] == {"sha256": hashlib.sha256(b"\x7fELF").hexdigest(), "size": 4, "executable": True}
  assert body["files"]["qaboard.yaml"]["executable"] is False
  assert body["url"] == f"/s{directory}"
  # clients compute the same hash: they cache the artifacts by it
  from qaboard.commit_artifacts import bundle_hash
  assert body["hash"] == bundle_hash(body["files"])
  # a file that changes changes the hash
  send_artifacts(api, dummy_app, {"build/tool": b"\x7fELF2"}, manifest="sub/manifests/binaries.json", executables={"build/tool"})
  assert listing(api, dummy_app)[0]["hash"] != body["hash"]


def test_listed_files_are_hashed_when_the_manifest_doesnt_say(api, dummy_app, upload_root, commit):
  # e.g. artifacts the server restored from the source code (`qa save-artifacts --out`)
  send_artifacts(api, dummy_app, {"qaboard.yaml": b"a"})
  manifest = commit.artifacts_dir / "manifests/__qaboard.yaml.json"
  manifest.write_text(json.dumps({"qaboard.yaml": {"st_size": 1, "md5": "x"}, "../../../../etc/passwd": {}, "missing.txt": {}}))
  files = listing(api, dummy_app)[0]["files"]
  assert files["qaboard.yaml"]["sha256"] == hashlib.sha256(b"a").hexdigest()
  assert set(files) == {"qaboard.yaml", "sub/manifests/__qaboard.yaml.json"}


def test_put_refusals(api, dummy_app, monkeypatch):
  assert put(api, dummy_app, "a.txt", sha256="")[0]["reason"] == "digest_required"
  body, status = put(api, dummy_app, "a.txt", sha256="0" * 64)
  assert status == 422 and body["reason"] == "digest_mismatch"
  assert put(api, dummy_app, "../a.txt")[0]["reason"] == "invalid_path"
  assert put(api, dummy_app, "a.txt", commit="f" * 40)[1] == 404
  assert put(api, dummy_app, "a.txt", commit="master")[0]["reason"] == "invalid_commit"
  monkeypatch.setattr(config, "upload_root", None)
  assert put(api, dummy_app, "a.txt")[0]["reason"] == "uploads_disabled"


def test_put_needs_a_token_and_access(api, dummy_app, monkeypatch, commit):
  monkeypatch.setattr(api, "ingest_access", lambda project_id, require_token=False: (None, ("refused", 401)))
  with dummy_app.test_request_context(f"/api/v1/commit/{COMMIT}/artifacts/files/a.txt?project=group/repo/sub", method="PUT", data=b"x", headers={"X-Content-SHA256": hashlib.sha256(b"x").hexdigest()}):
    assert api.upload_commit_artifact(COMMIT, "a.txt") == ("refused", 401)
  monkeypatch.setattr(api, "is_authorized_user", lambda user, project_id: False)
  monkeypatch.setattr(api, "forbidden_project", lambda project_id: ("hidden", 403))
  with dummy_app.test_request_context(f"/api/v1/commit/{COMMIT}/artifacts?project=group/repo/sub"):
    assert api.get_commit_artifacts(COMMIT) == ("hidden", 403)
  assert UPLOADED_ARTIFACTS not in commit.data


def test_listing_without_uploaded_artifacts(api, dummy_app, commit):
  body, status = listing(api, dummy_app)
  assert status == 404 and body["reason"] == "not_uploaded"
  assert listing(api, dummy_app, commit="f" * 40)[1] == 404


def test_artifacts_stay_where_they_were_sent(api, dummy_app, upload_root, commit, tmp_path, monkeypatch):
  send_artifacts(api, dummy_app, {"qaboard.yaml": b"a"})
  # the project's new runs now go to a bucket: its commits' artifacts don't move
  from backend import locations
  mount = tmp_path / "bucket"
  mount.mkdir()
  monkeypatch.setattr(locations, "_load", lambda: (locations.Location("s3://bucket/", mount, ("group/",), id=1),))
  locations.invalidate()
  try:
    send_artifacts(api, dummy_app, {"sub/qaboard.yaml": b"b"})
    assert (upload_root / "group/repo/sub/-/01/23456789abcdef/artifacts/sub/qaboard.yaml").exists()
    assert not list(mount.iterdir())
  finally:
    locations.invalidate()


def test_the_database_cant_send_artifacts_elsewhere(api, dummy_app, upload_root, commit, tmp_path):
  for location in ("/etc", str(tmp_path), str(upload_root / "other/repo/-/01/23456789abcdef/artifacts"), str(upload_root / "group/repo/sub/-/01/23456789abcdef/output")):
    commit.data = {UPLOADED_ARTIFACTS: location}
    assert commit.uploaded_artifacts_dir is None
    assert commit.repo_artifacts_dir != Path(location)
  put(api, dummy_app, "a.txt")
  assert (upload_root / "group/repo/sub/-/01/23456789abcdef/artifacts/a.txt").exists()


# --- running from them -------------------------------------------------------------------------------------------
def run_lines(lines, cwd, path_dirs=()):
  script = "\n".join(["set -e", *lines, "pwd", "echo envrc=${FROM_ENVRC:-}"])
  env = {**os.environ, "PATH": os.pathsep.join([*map(str, path_dirs), os.environ["PATH"]])}
  result = subprocess.run(["bash", "-c", script], cwd=cwd, env=env, capture_output=True, text=True)
  return result.returncode, result.stdout, result.stderr


@pytest.fixture
def fake_qa(tmp_path):
  """A `qa` whose fetch-artifacts prints a fetched copy of group/repo/sub's artifacts"""
  fetched = tmp_path / "cache" / "abc"
  (fetched / "sub").mkdir(parents=True)
  (fetched / ".envrc").write_text("export FROM_ENVRC=root\n")
  (fetched / "sub/.envrc").write_text("export FROM_ENVRC=$FROM_ENVRC,sub\n")
  bin_dir = tmp_path / "bin"
  bin_dir.mkdir()
  qa = bin_dir / "qa"
  qa.write_text(f'#!/bin/sh\necho "$@" > {tmp_path}/qa-args\necho {fetched}/sub\n')
  qa.chmod(0o755)
  return SimpleNamespace(bin_dir=bin_dir, fetched=fetched, args=tmp_path / "qa-args")


def test_scripts_fetch_uploaded_artifacts_where_they_arent_mounted(tmp_path, fake_qa):
  lines = cd_lines(tmp_path / "not mounted", ("group/repo/sub", COMMIT, "sub"), source_envrc=True)
  code, out, err = run_lines(lines, tmp_path, [fake_qa.bin_dir])
  assert code == 0, err
  assert f"{fake_qa.fetched}/sub\nenvrc=root,sub" in out
  assert fake_qa.args.read_text().split() == ["fetch-artifacts", "--project", "group/repo/sub", "--commit", COMMIT]


def test_scripts_use_the_folder_where_it_is_mounted(tmp_path, fake_qa):
  mounted = tmp_path / "mounted artifacts"
  mounted.mkdir()
  code, out, err = run_lines(cd_lines(mounted, ("group/repo/sub", COMMIT, "sub")), tmp_path, [fake_qa.bin_dir])
  assert code == 0 and f"{mounted}\n" in out
  assert not fake_qa.args.exists()


def test_scripts_stop_when_the_artifacts_cant_be_fetched(tmp_path):
  bin_dir = tmp_path / "bin"
  bin_dir.mkdir()
  (bin_dir / "qa").write_text("#!/bin/sh\necho 'ERROR: no artifacts' >&2\nexit 1\n")
  (bin_dir / "qa").chmod(0o755)
  code, out, err = run_lines(cd_lines(tmp_path / "missing", ("group/repo", COMMIT, "")), tmp_path, [bin_dir])
  assert code == 1 and "could not fetch the commit's artifacts" in err


def test_artifacts_in_a_shared_storage_dont_change(tmp_path):
  assert cd_lines(Path("/storage/artifacts/x y")) == ["mkdir -p '/storage/artifacts/x y'", "cd '/storage/artifacts/x y'"]
  ci_commit = SimpleNamespace(artifacts_dir=Path("/storage/a"), project_id="p", hexsha=COMMIT, project=SimpleNamespace(id_relative=""))
  assert commit_cd_lines(ci_commit) == ["mkdir -p /storage/a", "cd /storage/a"]
  ci_commit.uploaded_artifacts_dir = Path("/uploads/p/-/01/23/artifacts")
  assert "qa fetch-artifacts --project p" in "\n".join(commit_cd_lines(ci_commit))


def test_deleting_the_commits_artifacts_deletes_what_was_sent(api, dummy_app, upload_root, commit):
  # retention rules and the Storage page delete artifacts like those in a shared storage: by their manifests
  send_artifacts(api, dummy_app, {"qaboard.yaml": b"a", "sub/qaboard.yaml": b"b", "build/tool": b"c"})
  commit.authored_datetime = None
  summary = commit.delete(by="test")
  assert summary["errors"] == [] and summary["nb_deleted"] == 3
  assert not (commit.repo_artifacts_dir / "build/tool").exists()
  assert commit.deleted
  body, status = listing(api, dummy_app)
  assert status == 404 and body["reason"] == "deleted"
  # sent again, they are back
  send_artifacts(api, dummy_app, {"qaboard.yaml": b"a", "sub/qaboard.yaml": b"b"})
  commit.deleted = False  # what POST /api/v1/commit/ does after checking them, at the end of `qa save-artifacts`
  assert commit.artifacts_status()["ok"]


def test_qa_board_doesnt_start_runs_that_cant_send_results(api, dummy_app, commit):
  # until the batches the server starts get a token: uploading runs always need one
  from backend.artifacts import runs_cant_send_results
  assert runs_cant_send_results(commit) is None
  send_artifacts(api, dummy_app, {"qaboard.yaml": b"a", "sub/qaboard.yaml": b"b"})
  assert "token" in runs_cant_send_results(commit)
