"""
Tests for the file browser: folder listings (backend/files.py), and who can read files (backend/api/files.py)
"""
import os
import sys
import importlib.util
from pathlib import Path
from unittest.mock import MagicMock

import pytest

from backend import files
from backend.files import normalize, path_from_url, longest_prefix, folder_for, list_directory, is_listable


@pytest.mark.parametrize("path, expected", [
  ("/algo/x", "/algo/x"),
  ("/algo/x/", "/algo/x"),
  ("algo//x/../y/", "/algo/y"),
  ("/../../etc", "/etc"),
  ("", "/"),
])
def test_normalize(path, expected):
  assert normalize(path) == expected


@pytest.mark.parametrize("url, expected", [
  ("/s/algo/a%20b/c.txt", "/algo/a b/c.txt"),
  ("/s/algo/x/?token=abc", "/algo/x"),
  ("/s/algo/../etc/passwd", "/etc/passwd"),
  ("/s/", "/"),
  ("/api/v1/config", None),
  ("/sim/x", None),
])
def test_path_from_url(url, expected):
  assert path_from_url(url) == expected


def test_longest_prefix():
  prefixes = {"/algo": "algo", "/algo/secret/": "secret", "/algo/secret/public": "public"}
  assert longest_prefix("/algo/x", prefixes) == "algo"
  assert longest_prefix("/algo", prefixes) == "algo"
  assert longest_prefix("/algo/secret", prefixes) == "secret"
  assert longest_prefix("/algo/secret/run/log.txt", prefixes) == "secret"
  assert longest_prefix("/algo/secret/public/log.txt", prefixes) == "public"
  # not a folder of the prefix
  assert longest_prefix("/algo/secretive", {"/algo/secret": "secret"}) is None
  assert longest_prefix("/stage/x", prefixes) is None
  assert longest_prefix("/anything", {"/": "root"}) == "root"


@pytest.mark.parametrize("pattern, path, expected", [
  ("/algo/group/repo", "/elsewhere", "/algo/group/repo"), # no {user}: longest_prefix checks the path
  ("/algo/outputs/{user}/group/repo", "/algo/outputs/alice/group/repo/commit/run/log.txt", "/algo/outputs/alice/group/repo"),
  ("/algo/outputs/{user}/group/repo", "/algo/outputs/alice/group/repo", "/algo/outputs/alice/group/repo"),
  ("/algo/outputs/{user}/group/repo", "/algo/outputs/alice/group/repository", None),
  ("/algo/outputs/{user}/group/repo", "/algo/outputs/alice/other/repo", None),
  ("/algo/outputs/{user}/group/repo", "/algo/outputs/alice", None),
  ("/algo/outputs/{user}/group/repo", "/algo/outputs/a/b/group/repo", None), # {user} is 1 folder
  ("/algo/{user}_outputs/repo", "/algo/bob_outputs/repo/x", "/algo/bob_outputs/repo"),
])
def test_folder_for(pattern, path, expected):
  assert folder_for(pattern, path) == expected


def test_list_directory(tmp_path):
  (tmp_path / "folder").mkdir()
  (tmp_path / "file.txt").write_text("hello")
  (tmp_path / "link-to-folder").symlink_to(tmp_path / "folder")
  (tmp_path / "broken-link").symlink_to(tmp_path / "missing")
  listing = list_directory(str(tmp_path))
  assert listing["path"] == str(tmp_path)
  assert listing["truncated"] is False
  entries = {e["name"]: e for e in listing["entries"]}
  assert entries.keys() == {"folder", "file.txt", "link-to-folder", "broken-link"}
  assert entries["folder"]["type"] == "directory"
  assert "size" not in entries["folder"]
  assert entries["file.txt"]["type"] == "file"
  assert entries["file.txt"]["size"] == 5
  assert entries["file.txt"]["mode"].startswith("-rw")
  assert isinstance(entries["file.txt"]["mtime"], int)
  assert entries["file.txt"]["owner"]
  assert entries["link-to-folder"]["type"] == "directory"
  assert entries["link-to-folder"]["link"] == str(tmp_path / "folder")
  assert entries["broken-link"]["broken"] is True
  assert "broken" not in entries["link-to-folder"]


def test_list_directory_truncates(tmp_path):
  for i in range(5):
    (tmp_path / f"{i}.txt").touch()
  listing = list_directory(str(tmp_path), max_entries=3)
  assert len(listing["entries"]) == 3
  assert listing["truncated"] is True


def test_list_directory_errors(tmp_path):
  (tmp_path / "file.txt").touch()
  with pytest.raises(FileNotFoundError):
    list_directory(str(tmp_path / "missing"))
  with pytest.raises(NotADirectoryError):
    list_directory(str(tmp_path / "file.txt"))


def test_is_listable(tmp_path, monkeypatch):
  for d in ["storage/project", "server/data", "elsewhere"]:
    (tmp_path / d).mkdir(parents=True)
  (tmp_path / "storage/escape").symlink_to(tmp_path / "elsewhere")
  monkeypatch.setattr(files, "storage_roots", [tmp_path / "storage"])
  monkeypatch.setattr(files, "private_dirs", lambda: [tmp_path / "server/data", tmp_path / "storage/project/.qaboard"])
  assert is_listable(str(tmp_path / "storage"))
  assert is_listable(str(tmp_path / "storage/project"))
  assert not is_listable(str(tmp_path / "storage/project/.qaboard"))
  assert not is_listable(str(tmp_path / "storage/escape"))
  assert not is_listable(str(tmp_path / "elsewhere"))
  assert not is_listable("/etc")


# ==========================================
# Rules from QABOARD_LOGIN_RESTRICTED_YAML
# ==========================================

@pytest.fixture(scope="module")
def auth():
  """Loads the real backend/api/auth.py (conftest.py replaces it by a mock)."""
  stubs = {name: MagicMock() for name in ("ldap", "simplejson")}
  previous = {name: sys.modules.get(name) for name in stubs}
  sys.modules.update(stubs)
  models = sys.modules['backend.models']
  models.User, models.Token = MagicMock(), MagicMock()
  path = Path(__file__).parent.parent / "backend" / "api" / "auth.py"
  spec = importlib.util.spec_from_file_location("backend.api._auth_files_under_test", path)
  module = importlib.util.module_from_spec(spec)
  spec.loader.exec_module(module)
  yield module
  for name, mod in previous.items():
    if mod is None:
      sys.modules.pop(name, None)
    else:
      sys.modules[name] = mod


RESTRICTIONS = {
  "login": {},
  "projects": {
    "secret": {"user_name": ["alice"]},
    "group/repo": {"email": ["bob@example.com"]},
    "group/open": None,
  },
}

def test_restricted_project_key(auth, monkeypatch):
  monkeypatch.setattr(auth, "users_restrict_config", RESTRICTIONS)
  assert auth.restricted_project_key("secret") == "secret"
  assert auth.restricted_project_key("secret/project") == "secret"
  assert auth.restricted_project_key("group/repo/subproject") == "group/repo"
  assert auth.restricted_project_key("group/other") is None
  monkeypatch.setattr(auth, "users_restrict_config", {})
  assert auth.restricted_project_key("secret") is None


def test_is_authorized_user(auth, monkeypatch):
  monkeypatch.setattr(auth, "users_restrict_config", RESTRICTIONS)
  alice = {"user_name": "alice", "email": "alice@example.com"}
  bob = {"user_name": "bob", "email": "bob@example.com"}
  assert auth.is_authorized_user(alice, "secret/project")
  assert not auth.is_authorized_user(bob, "secret/project")
  assert auth.is_authorized_user(bob, "group/repo")
  assert not auth.is_authorized_user(alice, "group/repo")
  assert auth.is_authorized_user(alice, "group/open")
  assert auth.is_authorized_user(alice, "public")
  # no "login" rules: anyone can sign in
  assert auth.is_authorized_user(bob)


def test_matches_rules(auth):
  rules = {"user_name": ["alice"], "data": {"Department": ["ISP", "CV"]}}
  assert auth.matches_rules({"user_name": "alice"}, rules)
  assert not auth.matches_rules({"user_name": "bob"}, rules)
  assert auth.matches_rules({"user_name": "bob", "data": {"Department": ["CV"]}}, rules)
  assert not auth.matches_rules({"user_name": "bob", "data": {"Department": ["HR"]}}, rules)


# ==========================================
# Who can read files: backend/api/files.py
# ==========================================

@pytest.fixture
def api_files(monkeypatch):
  import backend.api.files as api_files
  config = {
    "paths": {
      "/algo/secret": {"user_name": ["alice"]},
      "/algo/secret/shared": None, # anyone
    },
    "projects": {"group/repo": {"user_name": ["bob"]}},
  }
  monkeypatch.setattr(api_files, "restrictions", lambda section: config.get(section) or {})
  monkeypatch.setattr(api_files, "restricted_project_dirs", lambda: {"/algo/group/repo": "group/repo", "/algo/outputs/{user}/group/repo": "group/repo"})
  monkeypatch.setattr(api_files, "matches_rules", lambda user_info, rules: user_info.get("user_name") in rules["user_name"])
  monkeypatch.setattr(api_files, "get_current_user", lambda to_jsonify: {"is_authenticated": False})
  api_files.config = config
  return api_files


def login(monkeypatch, api_files, user_name):
  monkeypatch.setattr(api_files, "get_current_user", lambda to_jsonify: {"is_authenticated": True, "user_name": user_name})


def status(response):
  return 200 if response is None else response[1]


def test_file_restriction(api_files):
  assert api_files.file_restriction("/algo/public/x") is None
  assert api_files.file_restriction("/algo/secret/x")[0] == "the folder /algo/secret"
  assert api_files.file_restriction("/algo/secret/shared/x") is None
  assert api_files.file_restriction("/algo/group/repo/commit/output")[0] == "the project group/repo"
  # outputs saved per user, with storage.outputs: /algo/outputs/{user}
  assert api_files.file_restriction("/algo/outputs/alice/group/repo/commit/output")[0] == "the project group/repo"
  assert api_files.file_restriction("/algo/outputs/alice/other/repo/commit/output") is None


def test_check_read_access(api_files, dummy_app, monkeypatch):
  with dummy_app.test_request_context("/"):
    assert status(api_files.check_read_access("/algo/public/x")) == 200
    assert status(api_files.check_read_access("/algo/secret/shared/x")) == 200
    assert status(api_files.check_read_access("/algo/secret/x")) == 401
    assert status(api_files.check_read_access("/algo/group/repo/x")) == 401
    login(monkeypatch, api_files, "alice")
    assert status(api_files.check_read_access("/algo/secret/x")) == 200
    assert status(api_files.check_read_access("/algo/group/repo/x")) == 403
    login(monkeypatch, api_files, "bob")
    assert status(api_files.check_read_access("/algo/secret/x")) == 403
    assert status(api_files.check_read_access("/algo/group/repo/x")) == 200


def test_check_read_access_without_restrictions(api_files, dummy_app, monkeypatch):
  monkeypatch.setattr(api_files, "restrictions", lambda section: {})
  get_current_user = MagicMock()
  monkeypatch.setattr(api_files, "get_current_user", get_current_user)
  with dummy_app.test_request_context("/"):
    assert api_files.check_read_access("/algo/secret/x") is None
  # we don't even look at who the user is
  get_current_user.assert_not_called()


def test_check_read_access_follows_symlinks(api_files, dummy_app, monkeypatch, tmp_path):
  (tmp_path / "secret").mkdir()
  (tmp_path / "public").mkdir()
  (tmp_path / "public/link").symlink_to(tmp_path / "secret")
  api_files.config["paths"] = {str(tmp_path / "secret"): {"user_name": ["alice"]}}
  with dummy_app.test_request_context("/"):
    assert status(api_files.check_read_access(str(tmp_path / "public/link/file"))) == 401
    login(monkeypatch, api_files, "alice")
    assert status(api_files.check_read_access(str(tmp_path / "public/link/file"))) == 200


def test_authorize_files_from_nginx(api_files, dummy_app):
  def authorize(original_uri):
    with dummy_app.test_request_context("/api/v1/files/authorize", environ_base={"QABOARD_ORIGINAL_URI": original_uri}):
      response = api_files.authorize_files()
      return response[1]
  assert authorize("/s/algo/public/log.txt") == 204
  assert authorize("/s/algo/secret/log.txt?download=1") == 401
  # nginx normalizes URLs, but let's not rely on it
  assert authorize("/s/algo/public/../secret/log.txt") == 401
  assert authorize("/s/algo/sec%72et/log.txt") == 401


def test_authorize_files_from_users(api_files, dummy_app):
  with dummy_app.test_request_context("/api/v1/files/authorize?path=/algo/secret/x"):
    assert api_files.authorize_files()[1] == 401
  with dummy_app.test_request_context("/api/v1/files/authorize?path=/algo/public/x"):
    assert api_files.authorize_files()[1] == 204
  with dummy_app.test_request_context("/api/v1/files/authorize"):
    assert api_files.authorize_files()[1] == 400


def test_list_files(api_files, dummy_app, monkeypatch, tmp_path):
  (tmp_path / "run").mkdir()
  (tmp_path / "run/log.txt").write_text("hello")
  (tmp_path / "secret").mkdir()
  api_files.config["paths"] = {str(tmp_path / "secret"): {"user_name": ["alice"]}}
  monkeypatch.setattr(api_files, "is_listable", lambda path: path.startswith(str(tmp_path)))
  with dummy_app.test_request_context("/"):
    response = api_files.list_files(f"{tmp_path}/run/")
    assert response.status_code == 200
    assert response.get_json()["path"] == f"{tmp_path}/run"
    assert [e["name"] for e in response.get_json()["entries"]] == ["log.txt"]
    assert api_files.list_files(f"{tmp_path}/missing/")[1] == 404
    assert api_files.list_files(f"{tmp_path}/run/log.txt/")[1] == 404
    assert api_files.list_files("etc/")[1] == 403
    response, status_code = api_files.list_files(f"{tmp_path}/secret/")
    assert status_code == 401
    assert response.get_json()["reason"] == "login"


@pytest.mark.skipif(os.geteuid() == 0, reason="root can read anything")
def test_list_files_without_permissions(api_files, dummy_app, monkeypatch, tmp_path):
  (tmp_path / "locked").mkdir(mode=0o000)
  monkeypatch.setattr(api_files, "is_listable", lambda path: True)
  try:
    with dummy_app.test_request_context("/"):
      response, status_code = api_files.list_files(f"{tmp_path}/locked/")
      assert status_code == 403
      assert response.get_json()["reason"] == "permissions"
  finally:
    (tmp_path / "locked").chmod(0o700)


def fake_output(id, folder, project="group/repo", label="default"):
  from types import SimpleNamespace
  ci_commit = SimpleNamespace(project_id=project, hexsha="a" * 40)
  return SimpleNamespace(
    id=id, output_dir_override=folder, is_failed=True, is_pending=False, is_running=False, deleted=False,
    platform="linux", configurations=["base"], data={"user": "alice"},
    test_input=SimpleNamespace(path=Path("inputs/a b.raw")), batch=SimpleNamespace(label=label, ci_commit=ci_commit),
  )


def test_run_of_folder(api_files, dummy_app, monkeypatch):
  queried = []
  outputs = [fake_output(1, "/algo/public/batch/run"), fake_output(2, "/algo/public/batch/run/nested", label="tuning")]
  def query(folders):
    queried.append(folders)
    return [o for o in outputs if o.output_dir_override in folders]
  monkeypatch.setattr(api_files, "Output", MagicMock())
  api_files.Output.query.filter.side_effect = lambda condition: MagicMock(all=lambda: query(condition.folders))
  api_files.Output.output_dir_override.in_ = lambda folders: MagicMock(folders=folders)
  monkeypatch.setattr(api_files, "is_authorized_user", lambda user_info, project: project != "secret/repo")
  def run(path):
    with dummy_app.test_request_context(f"/api/v1/files/run?path={path}"):
      response = api_files.run_of_folder()
    return response if isinstance(response, tuple) else response.get_json()

  # the run's folder, or a folder inside it
  assert run("/algo/public/batch/run/")["run"]["id"] == 1
  assert run("/algo/public/batch/run/images/")["run"]["id"] == 1
  assert {"/algo/public/batch/run/images", "/algo/public/batch/run", "/algo/public/batch", "/algo/public", "/algo"} <= queried[-1]
  # the most specific run
  described = run("/algo/public/batch/run/nested/x")["run"]
  assert described["id"] == 2
  assert described["url"] == f"/group/repo/commit/{'a' * 40}?batch=tuning&filter=inputs%2Fa+b.raw&selected_views=logs"
  assert described["is_failed"] and described["input"] == "inputs/a b.raw" and described["user"] == "alice"
  assert run("/algo/public/batch/")["run"] is None
  # projects users can't see
  outputs.append(fake_output(3, "/algo/public/secret-run", project="secret/repo"))
  assert run("/algo/public/secret-run")["run"] is None
  # folders users can't read
  assert run("/algo/secret/run")[1] == 401


def test_restricted_project_dirs(api_files, monkeypatch):
  import backend.api.files as module
  monkeypatch.undo() # the real restricted_project_dirs
  monkeypatch.setattr(module, "_project_dirs", {"expires": 0.0, "dirs": {}})
  monkeypatch.setattr(module, "restrictions", lambda section: {"projects": {"group": {"user_name": ["bob"]}}}.get(section, {}))
  monkeypatch.setattr(module, "restricted_project_key", lambda project: "group" if project.startswith("group") else None)
  def project(id, outputs, artifacts):
    p = MagicMock()
    p.id = id
    p.storage_roots.return_value = {"outputs": Path(outputs), "artifacts": Path(artifacts)}
    return p
  projects = [
    project("group/repo", "/algo/outputs/group/repo", "/algo/artifacts/group/repo/"),
    project("group/repo/subproject", "/algo/outputs/group/repo", "/algo/artifacts/group/repo"),
    project("other/repo", "/algo/outputs/other/repo", "/algo/artifacts/other/repo"),
    project("group/misconfigured", "group/misconfigured", "group/misconfigured"),
  ]
  monkeypatch.setattr(module.Project, "query", MagicMock())
  module.Project.query.all.return_value = projects
  expected = {"/algo/outputs/group/repo": "group", "/algo/artifacts/group/repo": "group"}
  assert module.restricted_project_dirs() == expected
  # Folders per user stay patterns, see test_folder_for
  projects[0].storage_roots.assert_called_with(user_name="{user}")
  # cached
  module.Project.query.all.return_value = []
  assert module.restricted_project_dirs() == expected


# ==========================================
# Unix permissions (QABOARD_FILES_UNIX_PERMISSIONS)
# ==========================================

from backend.files import UnixAccount, NOBODY, unix_can_read, unix_account


@pytest.fixture
def home(tmp_path):
  """A home folder with private and shared files, owned by the user running the tests"""
  home = tmp_path / "home"
  (home / "alice/private").mkdir(parents=True)
  (home / "alice/shared").mkdir(parents=True)
  (home / "alice/private/secret.txt").write_text("x")
  (home / "alice/shared/notes.txt").write_text("x")
  (home / "alice/group.txt").write_text("x")
  (home / "alice/public.txt").write_text("x")
  home.chmod(0o755)
  (home / "alice").chmod(0o711)  # others can traverse, not list
  (home / "alice/private").chmod(0o700)
  (home / "alice/private/secret.txt").chmod(0o644)  # readable, but behind a private folder
  (home / "alice/shared").chmod(0o755)
  (home / "alice/shared/notes.txt").chmod(0o644)
  (home / "alice/group.txt").chmod(0o640)
  (home / "alice/public.txt").chmod(0o600)
  yield home
  (home / "alice/private").chmod(0o700)


def test_unix_can_read(home):
  alice = UnixAccount(uid=os.getuid(), gids=frozenset())
  colleague = UnixAccount(uid=os.getuid() + 12345, gids=frozenset([(home / "alice/group.txt").stat().st_gid]))
  stranger = UnixAccount(uid=os.getuid() + 12345, gids=frozenset())
  root = str(home)
  for account in (alice, colleague, stranger, NOBODY):
    assert unix_can_read(str(home / "alice/shared/notes.txt"), root, account)
    assert unix_can_read(str(home / "alice/shared"), root, account)
  assert unix_can_read(str(home / "alice/private/secret.txt"), root, alice)
  assert not unix_can_read(str(home / "alice/private/secret.txt"), root, stranger)
  assert not unix_can_read(str(home / "alice/private"), root, stranger)
  # alice's home can be traversed, but not listed
  assert unix_can_read(str(home / "alice"), root, alice)
  assert not unix_can_read(str(home / "alice"), root, stranger)
  assert unix_can_read(str(home / "alice/group.txt"), root, colleague)
  assert not unix_can_read(str(home / "alice/group.txt"), root, stranger)
  assert not unix_can_read(str(home / "alice/public.txt"), root, colleague)
  # nginx will answer 404
  assert unix_can_read(str(home / "alice/missing.txt"), root, stranger)


def test_unix_account(monkeypatch):
  import pwd
  from backend import accounts
  monkeypatch.setattr(accounts, "accounts_dir", Path("/does/not/exist"))
  monkeypatch.setattr(accounts, "_state", {**accounts._state, "checked": 0.0})
  files._unix_account.cache_clear()
  entry = type("pw", (), {"pw_uid": 1000, "pw_gid": 100})
  monkeypatch.setattr(pwd, "getpwnam", lambda name: entry if name == "alice" else (_ for _ in ()).throw(KeyError(name)))
  monkeypatch.setattr(os, "getgrouplist", lambda name, gid: [gid, 10])
  assert unix_account("alice") == UnixAccount(uid=1000, gids=frozenset([100, 10]))
  assert unix_account("unknown") == NOBODY
  assert unix_account(None) == NOBODY
  files._unix_account.cache_clear()


def test_check_read_access_unix_permissions(api_files, dummy_app, monkeypatch, home):
  api_files.config["paths"] = {}
  api_files.config["projects"] = {}
  monkeypatch.setattr(api_files, "restricted_project_dirs", lambda: {})
  monkeypatch.setattr(api_files, "files_unix_permissions_roots", [str(home)])
  me = UnixAccount(uid=os.getuid(), gids=frozenset())
  stranger = UnixAccount(uid=os.getuid() + 12345, gids=frozenset())
  monkeypatch.setattr(api_files, "unix_account", lambda user_name: {"alice": me, "bob": stranger}.get(user_name, NOBODY))
  secret = str(home / "alice/private/secret.txt")
  with dummy_app.test_request_context("/"):
    assert status(api_files.check_read_access(str(home / "alice/shared/notes.txt"))) == 200
    assert status(api_files.check_read_access(secret)) == 401
    login(monkeypatch, api_files, "bob")
    assert status(api_files.check_read_access(secret)) == 403
    login(monkeypatch, api_files, "alice")
    assert status(api_files.check_read_access(secret)) == 200
  # symlinks into a private folder don't help
  (home.parent / "link").symlink_to(home / "alice/private")
  login(monkeypatch, api_files, "bob")
  with dummy_app.test_request_context("/"):
    assert status(api_files.check_read_access(str(home.parent / "link/secret.txt"))) == 403
