"""
Tests for a commit's artifacts sent over HTTP: where the server saves them (backend/uploads.py), its endpoints
(backend/api/commit_artifacts.py), the commits that then run from there (CiCommit), and the scripts that `cd` there
or fetch them (backend/artifacts.py).
"""
import datetime
import hashlib
import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import MagicMock

import pytest

from backend import config, uploads
from backend.artifacts import UPLOADED_ARTIFACTS, EXIT_TRAP, cd_lines, runner_unsupported
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
  assert directory == upload_root / "group/repo/-/01/23456789abcdef0123456789abcdef01234567/artifacts"
  # next to the commit's runs, never one of them
  assert directory.parent == uploads.run_dir("group/repo", COMMIT, "default", "linux", [], {}, "input").parent.parent.parent
  assert uploads.is_commit_artifacts_dir(directory, "group/repo")
  # each subproject has its own copy
  assert uploads.commit_artifacts_dir("group/repo/sub", COMMIT) == upload_root / "group/repo/sub/-/01/23456789abcdef0123456789abcdef01234567/artifacts"


@pytest.mark.parametrize("commit", ["<local:alice>", "0123", COMMIT.upper(), f"../{COMMIT[3:]}", "", None])
def test_artifacts_are_for_git_commits(upload_root, commit):
  with pytest.raises(uploads.UploadError) as error:
    uploads.commit_artifacts_dir("group/repo", commit)
  assert error.value.status == 400 and error.value.reason == "invalid_commit"


def test_is_commit_artifacts_dir(upload_root):
  runs = upload_root / "group/repo/-"
  assert uploads.is_commit_artifacts_dir(runs / "01/23456789abcdef/artifacts", "group/repo")
  for directory in (runs / "01/23456789abcdef/output", runs / "01/23456789abcdef/artifacts/sub", runs / "01/23456789abcdef",
                    runs / "local/alice/artifacts", runs / "01/../01/23456789abcdef0123456789abcdef01234567/artifacts", upload_root / "other/repo/-/01/23456789abcdef0123456789abcdef01234567/artifacts",
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
  ci_commit.artifacts_deleted = False
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
  directory = upload_root / "group/repo/sub/-/01/23456789abcdef0123456789abcdef01234567/artifacts"
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



def test_files_sent_again_without_their_manifest_are_hashed_again(api, dummy_app, commit):
  # a save that failed before its manifest, or a file of another group sent again: the listing must not be stale,
  # else every fetch fails on the SHA-256
  send_artifacts(api, dummy_app, {"build/tool": b"v1"})
  put(api, dummy_app, "build/tool", b"v2")
  later = (commit.artifacts_dir / "manifests/__qaboard.yaml.json").stat().st_mtime + 1
  os.utime(commit.repo_artifacts_dir / "build/tool", (later, later))
  assert listing(api, dummy_app)[0]["files"]["build/tool"]["sha256"] == hashlib.sha256(b"v2").hexdigest()

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
    assert (upload_root / "group/repo/sub/-/01/23456789abcdef0123456789abcdef01234567/artifacts/sub/qaboard.yaml").exists()
    assert not list(mount.iterdir())
  finally:
    locations.invalidate()


def test_the_database_cant_send_artifacts_elsewhere(api, dummy_app, upload_root, commit, tmp_path):
  for location in ("/etc", str(tmp_path), str(upload_root / "other/repo/-/01/23456789abcdef0123456789abcdef01234567/artifacts"), str(upload_root / "group/repo/sub/-/01/23456789abcdef0123456789abcdef01234567/output")):
    commit.data = {UPLOADED_ARTIFACTS: location}
    assert commit.uploaded_artifacts_dir is None
    assert commit.repo_artifacts_dir != Path(location)
  put(api, dummy_app, "a.txt")
  assert (upload_root / "group/repo/sub/-/01/23456789abcdef0123456789abcdef01234567/artifacts/a.txt").exists()


# --- running from them -------------------------------------------------------------------------------------------
def a_commit(uploaded=True, artifacts_dir="/storage/artifacts/x y", id_relative="sub"):
  return SimpleNamespace(
    artifacts_dir=Path(artifacts_dir), project_id="group/repo/sub", hexsha=COMMIT, project=SimpleNamespace(id_relative=id_relative),
    uploaded_artifacts_dir=Path("/uploads/group/repo/sub/-/01/23456789abcdef0123456789abcdef01234567/artifacts") if uploaded else None,
    outputs_dir=Path("/storage/outputs/group/repo/01/23456789abcdef0123456789abcdef01234567/sub"),
  )


def run_lines(lines, cwd, path_dirs=()):
  script = "\n".join([EXIT_TRAP, "set -e", *lines, "pwd", "echo envrc=${FROM_ENVRC:-}", "echo tmp=$QABOARD_BATCH_TMP"])
  env = {**os.environ, "PATH": os.pathsep.join([*map(str, path_dirs), os.environ["PATH"]])}
  result = subprocess.run(["bash", "-c", script], cwd=cwd, env=env, capture_output=True, text=True)
  return result.returncode, result.stdout, result.stderr


@pytest.fixture
def fake_qa(tmp_path):
  """A `qa` whose fetch-artifacts makes a copy of group/repo/sub's artifacts in its cache, and prints its folder"""
  bin_dir = tmp_path / "bin"
  bin_dir.mkdir()
  qa = bin_dir / "qa"
  qa.write_text(f"""#!/bin/sh
echo "$@" > {tmp_path}/qa-args
mkdir -p "$QABOARD_ARTIFACTS_CACHE/abc/sub"
echo 'export FROM_ENVRC=root' > "$QABOARD_ARTIFACTS_CACHE/abc/.envrc"
echo 'export FROM_ENVRC=$FROM_ENVRC,sub' > "$QABOARD_ARTIFACTS_CACHE/abc/sub/.envrc"
echo "$QABOARD_ARTIFACTS_CACHE/abc/sub"
""")
  qa.chmod(0o755)
  return SimpleNamespace(bin_dir=bin_dir, args=tmp_path / "qa-args")


def test_batches_run_in_their_own_copy_of_uploaded_artifacts(tmp_path, fake_qa):
  # wherever they run, the server's machine or a pod: their runs' files go there, and it is removed when they end
  code, out, err = run_lines(cd_lines(a_commit(), source_envrc=True), tmp_path, [fake_qa.bin_dir])
  assert code == 0, err
  copy = Path(out.split("tmp=")[1].split()[0])
  assert f"{copy}/abc/sub\nenvrc=root,sub" in out
  assert fake_qa.args.read_text().split() == ["fetch-artifacts", "--project", "group/repo/sub", "--commit", COMMIT]
  assert not copy.exists() and "qa batch exited with code 0" in out


def test_scripts_stop_when_the_artifacts_cant_be_fetched(tmp_path):
  bin_dir = tmp_path / "bin"
  bin_dir.mkdir()
  (bin_dir / "qa").write_text("#!/bin/sh\necho 'ERROR: no artifacts' >&2\nexit 1\n")
  (bin_dir / "qa").chmod(0o755)
  code, out, err = run_lines(cd_lines(a_commit()), tmp_path, [bin_dir])
  assert code == 1 and "could not fetch the commit's artifacts" in err and "exited with code 1" in out


def test_artifacts_in_a_shared_storage_dont_change():
  assert cd_lines(a_commit(uploaded=False)) == ["mkdir -p '/storage/artifacts/x y'", "cd '/storage/artifacts/x y'"]


def test_runs_from_uploaded_artifacts_save_their_files_in_the_copy():
  # QA_OUTPUTS_COMMIT would send the runs' files to a server folder the pods don't have
  from backend.api.tuning import _generate_batch_script
  from backend.redo import redo_script
  for commit, expected in ((a_commit(uploaded=False), True), (a_commit(), False)):
    for script in (_generate_batch_script(commit, "alice", commit.artifacts_dir, "id", "qa batch ci", {}), redo_script(commit, "alice", "id", "qa batch ci")):
      assert ("QA_OUTPUTS_COMMIT" in script) is expected
      assert ("qa fetch-artifacts" in script) is not expected
      assert script.index("cd ") < script.index("qa batch ci")


def test_deleting_the_commits_artifacts_deletes_what_was_sent(api, dummy_app, upload_root, commit):
  # retention rules and the Storage page delete artifacts like those in a shared storage: by their manifests
  send_artifacts(api, dummy_app, {"qaboard.yaml": b"a", "sub/qaboard.yaml": b"b", "build/tool": b"c"})
  commit.authored_datetime = None
  summary = commit.delete(by="test")
  assert summary["errors"] == [] and summary["nb_deleted"] == 3
  assert not (commit.repo_artifacts_dir / "build/tool").exists()
  assert commit.artifacts_deleted
  body, status = listing(api, dummy_app)
  assert status == 404 and body["reason"] == "deleted"
  # sent again, they are back
  send_artifacts(api, dummy_app, {"qaboard.yaml": b"a", "sub/qaboard.yaml": b"b"})
  commit.artifacts_deleted = False  # what POST /api/v1/commit/ does after checking them, at the end of `qa save-artifacts`
  assert commit.artifacts_status()["ok"]



# --- the batches QA-Board starts from them --------------------------------------------------------------------------
def test_runs_from_uploaded_artifacts_need_a_runner_that_fetches_them(monkeypatch):
  # results without tokens: else LSF jobs, which can't get the batch's token, are refused anyway
  monkeypatch.setenv('QABOARD_INGEST_AUTH', 'off')
  assert runner_unsupported(a_commit(uploaded=False), "lsf") is None
  assert runner_unsupported(a_commit(), "local") is None and runner_unsupported(a_commit(), "kubernetes") is None
  assert "lsf runner" in runner_unsupported(a_commit(), "lsf") and "qa batch" in runner_unsupported(a_commit(), "bridge")


def test_batch_tokens(monkeypatch):
  from backend import tokens
  minted = []
  monkeypatch.setattr(tokens, "mint", lambda user, **kwargs: (minted.append((user, kwargs)), (None, "qab_bat_secret"))[1])
  monkeypatch.setitem(sys.modules["backend"].__dict__, "db_session", MagicMock())
  alice = SimpleNamespace(id=1, user_name="alice")
  # projects with a shared storage: nothing changes
  assert tokens.mint_for_batch(SimpleNamespace(user=alice), a_commit(uploaded=False), "c0ffee00-1", "local", batch_label="tuning") is None
  with pytest.raises(ValueError, match="Sign in"):
    tokens.mint_for_batch(None, a_commit(), "c0ffee00-1", "local", batch_label="tuning")
  assert tokens.mint_for_batch(SimpleNamespace(user=alice), a_commit(), "c0ffee00-1", "kubernetes", batch_label="tuning") == "qab_bat_secret"
  user, options = minted[0]
  assert user is alice and options["kind"] == "batch" and options["projects"] == ["group/repo/sub"]
  assert options["scopes"] == ["read", "ingest"] and options["idle_expiry_days"] == 1
  assert tokens.is_well_formed(tokens.generate(tokens.BATCH_PREFIX))
  # its batch, where its driver may send its log, and whether its runs' end ends it (not for `qa optimize` and redo)
  its_batch = {"project": "group/repo/sub", "commit": COMMIT, "batch": "tuning"}
  assert options["data"] == {"command_id": "c0ffee00-1", **its_batch}
  tokens.mint_for_batch(SimpleNamespace(user=alice), a_commit(), "c0ffee00-2", "local", batch_label="tuning", log_dir=Path("/logs/x"), until_stopped=True, optimize=True)
  assert minted[1][1]["data"] == {"command_id": "c0ffee00-2", "log_dir": "/logs/x", "until_stopped": True, **its_batch, "optimize": True}
  # LSF jobs don't get the server's environment
  assert tokens.mint_for_batch(SimpleNamespace(user=alice), a_commit(), "c0ffee00-3", "lsf", batch_label="tuning") is None
  assert len(minted) == 2


def test_batch_tokens_with_a_shared_storage_when_the_server_requires_tokens(monkeypatch):
  from backend import tokens, settings
  monkeypatch.setattr(tokens, "mint", lambda user, **kwargs: (None, "qab_bat_secret"))
  monkeypatch.setitem(sys.modules["backend"].__dict__, "db_session", MagicMock())
  alice = SimpleNamespace(id=1, user_name="alice")
  for mode, expected in (("off", None), ("warn", None), ("token", "qab_bat_secret")):
    monkeypatch.setattr(settings, "setting", lambda key, mode=mode: mode if key == "ingest.auth" else None)
    assert tokens.batch_needs_token(a_commit(uploaded=False)) == (expected is not None)
    assert tokens.mint_for_batch(SimpleNamespace(user=alice), a_commit(uploaded=False), "c0ffee00-1", "local", batch_label="tuning") == expected
    # without a shared storage, always
    assert tokens.batch_needs_token(a_commit())
    # LSF can't get one: refused before it starts
    problem = runner_unsupported(a_commit(uploaded=False), "lsf")
    assert (problem is not None) == (mode == "token")
    assert runner_unsupported(a_commit(uploaded=False), "local") is None


def test_batch_tokens_only_send_their_own_batch():
  from backend import tokens
  token = batch_token(project="group/repo", commit=COMMIT, batch="tuning")
  allows = lambda project="group/repo", hexsha=COMMIT, label="tuning", **kwargs: tokens.batch_allows(token, project, hexsha, label, **kwargs)
  assert allows()
  # exactly its id: commits are looked up by prefix and case-sensitively, another spelling would be another commit
  assert not allows(hexsha=COMMIT.upper()) and not allows(hexsha=COMMIT + "0") and not allows(hexsha=f" {COMMIT}")
  short = batch_token(project="group/repo", commit=COMMIT[:8], batch="tuning")
  assert not tokens.batch_allows(short, "group/repo", COMMIT[:8], "tuning")
  # a batch can run its sub-projects' runs
  assert allows(project="group/repo/sub") and not allows(project="group/other") and not allows(project="group/repository")
  assert not allows(project=None) and not allows(hexsha="f" * 40) and not allows(hexsha=COMMIT[:8]) and not allows(hexsha=None)
  assert not allows(label="default") and not allows(label=None) and not allows(label="tuning|iter1")
  # commits: any batch, still only its own
  assert allows(label=None, any_batch=True) and not allows(hexsha="f" * 40, any_batch=True)
  # `qa optimize` runs each iteration in its own batch
  optimize = batch_token(project="group/repo", commit=COMMIT, batch="tuning", optimize=True)
  assert tokens.batch_allows(optimize, "group/repo", COMMIT, "tuning")
  assert tokens.batch_allows(optimize, "group/repo", COMMIT, "tuning|iter12")
  for label in ("tuning|iter", "tuning|iter1x", "tuning|iter1|iter2", "other|iter1", "tuning|other"):
    assert not tokens.batch_allows(optimize, "group/repo", COMMIT, label), label
  # labels are text, not patterns
  dots = batch_token(project="group/repo", commit=COMMIT, batch="a.b", optimize=True)
  assert not tokens.batch_allows(dots, "group/repo", COMMIT, "axb|iter1")
  # batch tokens that don't say their batch send nothing
  assert not tokens.batch_allows(batch_token(), "group/repo", COMMIT, "tuning")
  assert not tokens.batch_allows(batch_token(commit=COMMIT, batch="tuning"), "group/repo", COMMIT, "tuning")
  assert 'the batch "tuning" (and its iterations, tuning|iter<N>) of the commit 01234567' in tokens.batch_description(optimize)


def test_batch_tokens_cant_send_artifacts(api, dummy_app):
  from flask import g
  token = batch_token(project="group/repo/sub", commit=COMMIT, batch="tuning")
  headers = {"X-Content-SHA256": hashlib.sha256(b"x").hexdigest()}
  with dummy_app.test_request_context(f"/api/v1/commit/{COMMIT}/artifacts/files/a.txt?project=group/repo/sub", method="PUT", data=b"x", headers=headers):
    g.actor = SimpleNamespace(user="alice", token=token)
    response, status = api.upload_commit_artifact(COMMIT, "a.txt")
  assert status == 403 and response.get_json()["reason"] == "batch_token_limited"
  assert "token of a batch" in response.get_json()["error"]


def batch_token(command_id="c0ffee00-1", **data):
  return SimpleNamespace(id=1, name="Batch", kind="batch", revoked=False, revoked_at=None, user=None, idle_expiry_days=None,
                         expires_at=datetime.datetime(2100, 1, 1), data={"command_id": command_id, **data})


def test_batch_tokens_end_soon_after_the_last_run_ends(monkeypatch):
  from backend import tokens
  token, other = batch_token(), batch_token("c0ffee00-opt", until_stopped=True)
  found = {"c0ffee00-1": [token], "c0ffee00-opt": [other]}
  monkeypatch.setattr(tokens, "active_batch_tokens", lambda ids: [t for i in ids for t in found.get(i, [])])
  session = MagicMock()
  # runs are still pending
  session.execute.return_value.first.return_value = (1,)
  tokens.end_batch_token(session, "c0ffee00-1")
  assert token.expires_at.year == 2100
  # the last one ended: its driver may still send the end of its log
  session.execute.return_value.first.return_value = None
  tokens.end_batch_token(session, "c0ffee00-1")
  assert not token.revoked and token.expires_at <= tokens.utcnow() + tokens.ENDED_BATCH_GRACE and session.commit.called
  # `qa optimize` starts its next batch after this one ends: it keeps its token until stopped
  tokens.end_batch_token(session, "c0ffee00-opt")
  assert other.expires_at.year == 2100
  # runs that weren't started by QA-Board
  tokens.end_batch_token(session, None)
  tokens.end_batch_token(session, "unknown")
  # it never gets in the way of saving results
  monkeypatch.setattr(tokens, "active_batch_tokens", MagicMock(side_effect=RuntimeError("db down")))
  tokens.end_batch_token(session, "c0ffee00-1")
  assert session.rollback.called


def test_only_the_batchs_own_token_sends_its_log():
  from backend.tokens import batch_token_for
  token = batch_token(log_dir="/logs/x")
  token.projects = ["group/repo"]
  assert batch_token_for(SimpleNamespace(token=token), "c0ffee00-1") is token
  assert batch_token_for(SimpleNamespace(token=token), "c0ffee00-2") is None
  assert batch_token_for(SimpleNamespace(token=None), "c0ffee00-1") is None
  assert batch_token_for(None, "c0ffee00-1") is None
  personal = SimpleNamespace(**{**vars(token), "kind": "personal"})
  assert batch_token_for(SimpleNamespace(token=personal), "c0ffee00-1") is None
  without_folder = batch_token()
  without_folder.projects = ["group/repo"]
  assert batch_token_for(SimpleNamespace(token=without_folder), "c0ffee00-1") is None


def test_the_batch_token_is_in_the_environment_of_qa_batch():
  from backend.local_jobs import qa_environment
  server = {"PATH": "/bin", "QABOARD_TOKEN": "the server's", "QABOARD_SECRET_KEY": "x"}
  assert "QABOARD_TOKEN" not in qa_environment("c0ffee00", environ=server)
  assert qa_environment("c0ffee00", environ=server, token="qab_bat_x")["QABOARD_TOKEN"] == "qab_bat_x"
