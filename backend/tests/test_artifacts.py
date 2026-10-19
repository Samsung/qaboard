"""
Tests for backend/artifacts.py and backend/recreate_artifacts.py:
checking a commit's artifacts are usable, what deleting them must keep, and asking the CI to recreate them.
"""
import json
import datetime
from pathlib import Path
from types import SimpleNamespace

import pytest

from backend.artifacts import artifacts_status, protected_by_siblings, is_kept, rmtree_except, Protected
from backend import recreate_artifacts


def write(path: Path, content="x"):
  path.parent.mkdir(parents=True, exist_ok=True)
  path.write_text(content)


@pytest.fixture
def repo(tmp_path):
  """A commit's artifacts, for a repository with a root project and two subprojects"""
  root = tmp_path / "artifacts/group/repo/commits/ab/cdef"
  write(root / "qaboard.yaml")
  write(root / "build/bin/tool")
  for sub in ("sub/a", "sub/b"):
    write(root / sub / "qaboard.yaml")
    write(root / sub / "batches.yaml")
    manifest = {"qaboard.yaml": {}, f"{sub}/qaboard.yaml": {}, f"{sub}/batches.yaml": {}, "build/bin/tool": {}}
    write(root / sub / "manifests" / "__sub-qaboard.yaml.json", json.dumps(manifest))
  return root


def test_status_ok(repo):
  status = artifacts_status(repo / "sub/a", repo, is_subproject=True)
  assert status["ok"], status["problems"]
  assert status["nb_checked_files"] == 4


def test_status_missing_folder(repo):
  status = artifacts_status(repo / "sub/c", repo, is_subproject=True)
  assert not status["ok"]
  assert "does not exist" in status["problems"][0]


def test_status_missing_subproject_config(repo):
  # qa would find the root qaboard.yaml, and save runs in the root project
  (repo / "sub/a/qaboard.yaml").unlink()
  status = artifacts_status(repo / "sub/a", repo, is_subproject=True)
  assert not status["ok"]
  assert any("wrong project" in p for p in status["problems"])


def test_status_legacy_config_name(repo):
  (repo / "sub/a/qaboard.yaml").rename(repo / "sub/a/qatools.yaml")
  status = artifacts_status(repo / "sub/a", repo, is_subproject=True)
  # only the manifest's entry is missing
  assert status["nb_missing_files"] == 1
  assert not any("wrong project" in p for p in status["problems"])


def test_status_missing_files_only_warn(repo):
  # runs may not need them, and manifests keep entries for files that are gone
  (repo / "build/bin/tool").unlink()
  status = artifacts_status(repo / "sub/a", repo, is_subproject=True)
  assert status["ok"]
  assert status["problems"] == []
  assert status["missing_files"] == ["build/bin/tool"]
  assert "1 artifacts listed in the manifests are missing" in status["warnings"][0]


def test_status_corrupted_manifest(repo):
  write(repo / "sub/a/manifests/bad.json", "{not json")
  assert not artifacts_status(repo / "sub/a", repo, is_subproject=True)["ok"]


def test_siblings_protect_shared_files(repo):
  is_protected = protected_by_siblings(repo, [(repo, repo / "sub/b")])
  # shared with sub/b
  assert is_protected("qaboard.yaml")
  assert is_protected("build/bin/tool")
  assert is_protected("build") # contains a protected file
  # sub/b's own folder
  assert is_protected("sub/b/anything")
  assert is_protected("sub") # contains sub/b
  # only sub/a uses them
  assert not is_protected("sub/a/qaboard.yaml")
  assert not is_protected("sub/a/batches.yaml")


def test_siblings_stored_elsewhere_share_nothing(repo, tmp_path):
  is_protected = protected_by_siblings(repo, [(tmp_path / "elsewhere", tmp_path / "elsewhere/sub/b")])
  assert not is_protected
  assert not is_protected("qaboard.yaml")


def test_root_project_is_not_protecting_everything(repo):
  # the root project's folder is the whole repository: its manifests protect what it uses, not its folder
  is_protected = protected_by_siblings(repo, [(repo, repo)])
  assert not is_protected("sub/a/qaboard.yaml")


def test_unreadable_sibling_manifest_keeps_root_config(repo):
  write(repo / "sub/b/manifests/__sub-qaboard.yaml.json", "{not json")
  is_protected = protected_by_siblings(repo, [(repo, repo / "sub/b")])
  assert is_protected("qaboard.yaml")


def test_is_kept():
  assert is_kept("coverage_report", "coverage/index.html", ["coverage_report"])
  assert is_kept("binaries", "build/my_binary", ["build/my_binary"])
  assert is_kept("binaries", "build/bin/tool", ["build/"])
  assert is_kept("binaries", "build/bin/tool", ["build/*/tool"])
  assert not is_kept("binaries", "build/bin/tool", ["coverage_report"])
  assert not is_kept("binaries", "build/bin/tool", None)


def test_rmtree_except(repo):
  deleted = []
  def rmtree(path):
    deleted.append(path.relative_to(repo).as_posix())
    return 1
  is_protected = protected_by_siblings(repo, [(repo, repo / "sub/b")])
  nb_deleted = rmtree_except(repo, repo, is_protected, rmtree)
  assert sorted(deleted) == ["sub/a"]
  assert nb_deleted == 1
  # dryrun deletes nothing
  deleted.clear()
  assert rmtree_except(repo, repo, is_protected, rmtree, dryrun=True) == 1
  assert deleted == []


def test_protected_is_falsy_when_empty():
  assert not Protected()
  assert not Protected(dirs=[""])
  assert Protected(files=["a"])



def commit(tmp_path, **data):
  return SimpleNamespace(
    hexsha="0123456789abcdef0123456789abcdef01234567",
    branch="origin/feature/x",
    artifacts_dir=tmp_path / "sub/a",
    repo_artifacts_dir=tmp_path,
    project=SimpleNamespace(id="group/repo/sub/a", id_relative="sub/a", id_git="group/repo", data=data),
  )


def test_recreate_settings_prefers_the_first_config():
  assert recreate_artifacts.recreate_settings({}, {"recreate_artifacts": {"webhook": {"url": "https://b"}}}) == {"webhook": {"url": "https://b"}}
  assert recreate_artifacts.recreate_settings({"recreate_artifacts": {"jenkins": {}}}, {"recreate_artifacts": {"webhook": {}}}) == {"jenkins": {}}
  assert recreate_artifacts.recreate_settings(None, {}) is None


def test_template_variables(tmp_path):
  variables = recreate_artifacts.template_variables(commit(tmp_path), user="arthur")
  assert variables["commit.branch"] == "feature/x"
  assert variables["subproject"] == "sub/a"
  assert recreate_artifacts.fill({"a": ["${commit.id}", "${ user }"]}, variables) == {"a": [variables["commit.id"], "arthur"]}
  with pytest.raises(KeyError):
    recreate_artifacts.fill("${commit.nope}", variables)


@pytest.mark.parametrize("settings,error", [
  ("build", "should be a mapping"),
  ({}, "exactly one of"),
  ({"jenkins": {"build_url": "x"}, "webhook": {"url": "https://x"}}, "exactly one of"),
  ({"gitlabCI": {}}, "job_name"),
  ({"jenkins": {}}, "build_url"),
  ({"webhook": {"url": "ftp://x"}}, "http"),
  ({"webhook": {"url": "https://x", "json": {"c": "${commit.sha}"}}}, "Unknown variable"),
])
def test_validate_errors(tmp_path, settings, error):
  errors = recreate_artifacts.validate(settings, recreate_artifacts.template_variables(commit(tmp_path)))
  assert errors and error in " ".join(errors)


def test_validate_ok(tmp_path):
  settings = {"jenkins": {"build_url": "http://jenkins/job/x", "params": {"commit": "${commit.id}"}}}
  assert recreate_artifacts.validate(settings, recreate_artifacts.template_variables(commit(tmp_path))) == []


def test_trigger_webhook(tmp_path, monkeypatch):
  calls = []
  class Response:
    def raise_for_status(self): pass
    def json(self): return {"web_url": "https://ci/build/1"}
  def request(method, url, **kwargs):
    calls.append((method, url, kwargs))
    return Response()
  monkeypatch.setattr(recreate_artifacts.requests, "request", request)
  settings = {"webhook": {"url": "https://ci/hooks/build", "json": {"commit": "${commit.id}"}}}
  recreation = recreate_artifacts.trigger(settings, commit(tmp_path), user="arthur")
  assert recreation["status"] == "triggered"
  assert recreation["web_url"] == "https://ci/build/1"
  assert recreation["by"] == "arthur"
  method, url, kwargs = calls[0]
  assert method == "POST" and url == "https://ci/hooks/build"
  assert kwargs["json"] == {"commit": "0123456789abcdef0123456789abcdef01234567"}
  assert kwargs["timeout"]


def test_trigger_reports_errors(tmp_path, monkeypatch):
  def request(*args, **kwargs):
    raise ConnectionError("connection refused")
  monkeypatch.setattr(recreate_artifacts.requests, "request", request)
  recreation = recreate_artifacts.trigger({"webhook": {"url": "https://ci"}}, commit(tmp_path))
  assert recreation["status"] == "failed"
  assert "connection refused" in recreation["error"]
  # invalid settings fail before any request
  assert recreate_artifacts.trigger({"webhook": {}}, commit(tmp_path))["status"] == "failed"


def test_in_progress():
  now = datetime.datetime(2026, 10, 6, 12, tzinfo=datetime.timezone.utc)
  recent = (now - datetime.timedelta(minutes=10)).isoformat()
  old = (now - datetime.timedelta(hours=5)).isoformat()
  assert recreate_artifacts.in_progress({"status": "triggered", "at": recent}, now=now)
  assert not recreate_artifacts.in_progress({"status": "triggered", "at": old}, now=now)
  assert not recreate_artifacts.in_progress({"status": "failed", "at": recent}, now=now)
  assert not recreate_artifacts.in_progress(None, now=now)


@pytest.mark.parametrize("settings", [{"gitlabCI": "build"}, {"webhook": None}, {"jenkins": ["x"]}, "build", None, [1]])
def test_describe_never_raises(settings):
  assert isinstance(recreate_artifacts.describe(settings), str)


def test_recreate_settings_ignores_invalid_configs():
  assert recreate_artifacts.recreate_settings("x", ["y"], None) is None


def test_gitlab_project_must_be_the_project_repository(tmp_path):
  errors = recreate_artifacts.validate({"gitlabCI": {"job_name": "deploy", "project_id": "ops/infra"}})
  assert any("project_id" in e for e in errors)


def test_values_are_quoted_in_urls(tmp_path):
  c = commit(tmp_path)
  c.branch = "a&token=x/../../other"
  variables = recreate_artifacts.template_variables(c)
  filled = recreate_artifacts.fill({"url": "https://ci/hook?b=${commit.branch}", "json": {"b": "${commit.branch}"}}, variables)
  assert filled["url"] == "https://ci/hook?b=a%26token%3Dx%2F..%2F..%2Fother"
  assert filled["json"]["b"] == "a&token=x/../../other"


def test_webhook_does_not_follow_redirects_nor_echo_other_hosts(tmp_path, monkeypatch):
  seen = {}
  class Response:
    def raise_for_status(self): pass
    def json(self): return {"url": "http://internal-service/secret"}
  def request(method, url, **kwargs):
    seen.update(kwargs)
    return Response()
  monkeypatch.setattr(recreate_artifacts.requests, "request", request)
  recreation = recreate_artifacts.trigger({"webhook": {"url": "https://ci/hook", "verify": False}}, commit(tmp_path))
  assert recreation["status"] == "triggered" and recreation["web_url"] is None
  assert seen["allow_redirects"] is False and "verify" not in seen


def test_in_progress_rejects_forged_timestamps():
  now = datetime.datetime(2026, 10, 6, 12, tzinfo=datetime.timezone.utc)
  assert not recreate_artifacts.in_progress({"status": "triggered", "at": "2099-01-01T00:00:00+00:00"}, now=now)
  assert not recreate_artifacts.in_progress({"status": "triggered", "at": "2026-10-06T11:59:00"}, now=now) # no timezone
  assert not recreate_artifacts.in_progress("triggered", now=now)


def test_sibling_without_manifests_keeps_everything_but_our_folder(repo):
  # e.g. the root project's artifacts were saved before manifests existed
  is_protected = protected_by_siblings(repo, [(repo, repo)], own_dir=repo / "sub/a")
  assert is_protected("qaboard.yaml")
  assert is_protected("build/bin/tool")
  assert is_protected("sub/b/qaboard.yaml")
  assert not is_protected("sub/a/qaboard.yaml")
  deleted = []
  rmtree_except(repo, repo, is_protected, lambda p: deleted.append(p.relative_to(repo).as_posix()) or 1)
  assert deleted == ["sub/a"]


def test_dotdot_paths_are_normalized(repo):
  is_protected = protected_by_siblings(repo, [(repo, repo / "sub/b")])
  assert is_protected("sub/a/../b/data.bin")
  assert is_protected("./qaboard.yaml")
