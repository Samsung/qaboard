"""
Tests for backend/shell_utils.py and the `login_required` decorator in backend/api/auth.py
"""
import sys
import json
import types
import subprocess
import importlib.util
from pathlib import Path
from unittest.mock import MagicMock

import pytest
import requests # before the auth fixture stubs simplejson, that requests would use
from flask import g

from backend.shell_utils import quote, is_shell_safe, shell_safe, safe_user_name, lsf_bridge_command

from .git_payloads import gitlab_push, github_push, gitea_push, bitbucket_push
from .test_git_hosts import FakeProjects


# Values with characters that are special to the shell
AWKWARD_VALUES = [
  "simple",
  "with space",
  "single'quote",
  'double"quote',
  "dollar $HOME ${HOME}",
  "backtick `id`",
  "subshell $(id)",
  "semi;colon && pipe | redirect > /dev/null",
  "new\nline",
  "-starts-with-dash",
  "",
]


@pytest.mark.parametrize("value", AWKWARD_VALUES)
def test_quote_roundtrips_through_bash(value):
  out = subprocess.run(["bash", "-c", f"printf '%s' {quote(value)}"], capture_output=True, encoding="utf-8", check=True)
  assert out.stdout == value


@pytest.mark.parametrize("value", AWKWARD_VALUES)
def test_double_quote_roundtrips_through_two_shells(value):
  # Like the command we give to bsub, that is parsed again on the execution host
  inner = f"printf '%s' {quote(value)}"
  out = subprocess.run(["bash", "-c", f"bash -c {quote(inner)}"], capture_output=True, encoding="utf-8", check=True)
  assert out.stdout == value


def test_is_shell_safe():
  assert is_shell_safe("/mnt/qaboard/outputs/user/abc/output/redo.sh")
  assert is_shell_safe("a-b_c.d@e%f+g=h:i,j")
  for value in AWKWARD_VALUES:
    if value != "simple" and value != "-starts-with-dash":
      assert not is_shell_safe(value), value
  with pytest.raises(ValueError):
    shell_safe("with space")


@pytest.mark.parametrize("user", ["arthurf", "first.last", "user_1", "a-b"])
def test_safe_user_name_valid(user):
  assert safe_user_name(user) == user


@pytest.mark.parametrize("user", ["", None, "../etc", "a/b", "a b", "-rf", ".hidden", "a;b", "a'b", "$USER", "a" * 65])
def test_safe_user_name_invalid(user):
  with pytest.raises(ValueError):
    safe_user_name(user)


def test_lsf_bridge_command(monkeypatch):
  monkeypatch.delenv("QA_RUNNERS_LSF_BRIDGE", raising=False)
  assert lsf_bridge_command("arthurf", Path("/a/b/redo.sh")) == "bash /a/b/redo.sh"

  monkeypatch.setenv("QA_RUNNERS_LSF_BRIDGE", "ssh ispq@host 'bsub_su {user} -I {bsub_command}'")
  assert lsf_bridge_command("arthurf", Path("/a/b/redo.sh")) == "ssh ispq@host 'bsub_su arthurf -I bash /a/b/redo.sh'"

  with pytest.raises(ValueError):
    lsf_bridge_command("arthurf", Path("/a/with space/redo.sh"))
  with pytest.raises(ValueError):
    lsf_bridge_command("arthurf", Path("/a/it's/redo.sh"))
  with pytest.raises(ValueError):
    lsf_bridge_command("a'b", Path("/a/b/redo.sh"))



# ==========================================
# login_required
# ==========================================

@pytest.fixture(scope="module")
def auth():
  """Loads the real backend/api/auth.py (conftest.py replaces it by a mock)."""
  stubs = {name: MagicMock() for name in ("ldap", "ldap.filter", "simplejson")}
  previous = {name: sys.modules.get(name) for name in stubs}
  sys.modules.update(stubs)
  models = sys.modules['backend.models']
  models.User, models.Token = MagicMock(), MagicMock()

  path = Path(__file__).parent.parent / "backend" / "api" / "auth.py"
  spec = importlib.util.spec_from_file_location("backend.api._auth_under_test", path)
  module = importlib.util.module_from_spec(spec)
  spec.loader.exec_module(module)
  yield module
  for name, mod in previous.items():
    if mod is None:
      sys.modules.pop(name, None)
    else:
      sys.modules[name] = mod


def test_login_required_rejects_anonymous(auth, dummy_app, monkeypatch):
  monkeypatch.setattr(auth, "get_current_user", lambda to_jsonify: {"is_authenticated": False})
  handler = MagicMock(return_value="OK")
  with dummy_app.test_request_context("/api/v1/batch/redo/", method="POST"):
    response, status = auth.login_required(handler)()
  assert status == 401
  handler.assert_not_called()


def test_login_required_allows_logged_in_users(auth, dummy_app, monkeypatch):
  user_info = {"is_authenticated": True, "user_name": "arthurf"}
  monkeypatch.setattr(auth, "get_current_user", lambda to_jsonify: user_info)
  monkeypatch.setattr(auth, "is_login_restricted", False)
  with dummy_app.test_request_context("/api/v1/batch/redo/", method="POST"):
    assert auth.login_required(lambda: g.user["user_name"])() == "arthurf"


def test_login_required_checks_project_permissions(auth, dummy_app, monkeypatch):
  monkeypatch.setattr(auth, "get_current_user", lambda to_jsonify: {"is_authenticated": True, "user_name": "arthurf"})
  monkeypatch.setattr(auth, "is_login_restricted", True)
  monkeypatch.setattr(auth, "is_authorized_user", lambda user_info, project: project != "secret")
  handler = MagicMock(return_value="OK")
  with dummy_app.test_request_context("/api/v1/commit/abc/batch?project=secret", method="POST"):
    response, status = auth.login_required(handler)()
  assert status == 403
  handler.assert_not_called()
  with dummy_app.test_request_context("/api/v1/commit/abc/batch?project=public", method="POST"):
    assert auth.login_required(handler)() == "OK"


# ==========================================
# Signup and login errors don't leak secrets
# ==========================================

SIGNUP_FORM = {"user_name": "newuser", "password": "hunter2-secret", "email": "new@example.com"}

class IntegrityError(Exception):
  """Like sqlalchemy.exc.IntegrityError, whose message has the SQL query and its parameters"""


@pytest.fixture
def signup(auth, dummy_app, monkeypatch):
  monkeypatch.delenv("QABOARD_DISABLE_SIGNUP", raising=False)
  monkeypatch.setattr(auth, "User", MagicMock())
  monkeypatch.setattr(auth, "db_session", MagicMock())
  auth.User.query.filter_by.return_value.one_or_none.return_value = None
  def post(form=SIGNUP_FORM):
    with dummy_app.test_request_context("/api/v1/user/signup/", method="POST", data=form):
      return auth.signup()
  return post


def assert_no_secrets(text):
  for secret in ["hunter2-secret", "scrypt:", "new@example.com", "INSERT", "parameters"]:
    assert secret not in text


def test_signup_existing_user_name(auth, signup, monkeypatch, capsys):
  auth.User.query.filter_by.return_value.one_or_none.return_value = MagicMock()
  monkeypatch.setattr(auth, "create_user", MagicMock())
  response, status = signup()
  assert status == 409
  assert response.get_json() == {"error": "This user name is already taken"}
  auth.create_user.assert_not_called()


@pytest.mark.parametrize("error, expected_status", [
  (IntegrityError("(psycopg2.errors.UniqueViolation) duplicate key value violates unique constraint \"users_email_key\"\n"
                  "[SQL: INSERT INTO users ...] [parameters: {'email': 'new@example.com', 'password': 'scrypt:32768:8:1$abc'}]"), 409),
  (Exception("connection to server failed, form: user_name=newuser&password=hunter2-secret"), 500),
])
def test_signup_errors_dont_leak_secrets(auth, signup, monkeypatch, capsys, error, expected_status):
  monkeypatch.setattr(auth, "create_user", MagicMock(side_effect=error))
  response, status = signup()
  assert status == expected_status
  assert_no_secrets(response.get_data(as_text=True))
  assert_no_secrets(capsys.readouterr().out)
  auth.db_session.rollback.assert_called_once()


@pytest.mark.parametrize("form", [{"user_name": "newuser"}, {"password": "hunter2-secret"}, {"user_name": "", "password": "x"}])
def test_signup_requires_user_name_and_password(auth, signup, monkeypatch, form):
  monkeypatch.setattr(auth, "create_user", MagicMock())
  response, status = signup(form)
  assert status == 400
  auth.create_user.assert_not_called()


def test_signup_creates_users(auth, signup, monkeypatch):
  user = MagicMock(id=1, email="new@example.com", user_name="newuser", full_name=None, login_type="LOCAL")
  monkeypatch.setattr(auth, "create_user", MagicMock(return_value=user))
  response = signup()
  assert response.get_json()["user_name"] == "newuser"
  assert "password" not in response.get_json()


@pytest.mark.parametrize("form", [{"username": "arthurf", "password": ""}, {"username": "arthurf"}, {"password": "x"}])
def test_login_refuses_empty_passwords(auth, dummy_app, monkeypatch, form):
  # With LDAP, a bind with an empty password can succeed as an anonymous bind
  monkeypatch.setattr(auth, "current_user", MagicMock(is_authenticated=False))
  monkeypatch.setattr(auth, "auth", MagicMock())
  with dummy_app.test_request_context("/api/v1/user/auth/", method="POST", data=form):
    response, status = auth.auth_post()
  assert status == 403
  auth.auth.assert_not_called()


def test_unauthorized_login_error_has_no_user_info(auth, dummy_app, monkeypatch):
  monkeypatch.setattr(auth, "is_login_restricted", True)
  monkeypatch.setattr(auth, "is_authorized_user", lambda user_info: False)
  monkeypatch.setattr(auth, "session", MagicMock())
  with dummy_app.test_request_context("/api/v1/user/auth/", method="POST"):
    info = auth.auth_local("arthurf", "password")
  assert not info["login_success"]
  assert info["error"] == auth.not_authorized_error


# ==========================================
# Endpoints that change things need a logged-in user
# ==========================================

# Endpoints that change things without login_required, and why
UNAUTHENTICATED_ENDPOINTS = {
  # login, signup... or checks the login itself
  ("auth.py", "create_token"), ("auth.py", "signup"), ("auth.py", "auth_post"), ("auth.py", "logout"), ("auth.py", "saml_auth"),
  # the CLI sends results without authentication (see "Known issues" in SECURITY.md)
  ("outputs.py", "new_output_webhook"), ("batch.py", "update_batch"), ("commit.py", "api_ci_commit"),
  ("integrations.py", "jenkins_build_trigger"),
  # read-only, POST is only used to send parameters
  ("image.py", "get_pixel"), ("image.py", "get_rois"), ("image.py", "get_report"),
  ("integrations.py", "gitlab_job"), ("integrations.py", "jenkins_build"), ("integrations.py", "github_workflow_run"),
  # checks the login itself when writing
  ("tuning.py", "groups"),
  # authenticated with the git host's webhook secret (QABOARD_WEBHOOK_SECRET by default)
  ("webhooks.py", "gitlab_webhook"), ("webhooks.py", "github_webhook"), ("webhooks.py", "gitea_webhook"), ("webhooks.py", "bitbucket_webhook"),
  # TODO: require a login, check the web app first
  ("milestones.py", "crud_milestones"),
}

def test_endpoints_that_change_things_require_login():
  import ast
  import warnings
  missing = []
  for path in sorted((Path(__file__).parent.parent / "backend" / "api").glob("*.py")):
    with warnings.catch_warnings():
      warnings.simplefilter("ignore", SyntaxWarning)
      tree = ast.parse(path.read_text())
    for node in ast.walk(tree):
      if not isinstance(node, ast.FunctionDef):
        continue
      decorators = [ast.unparse(d) for d in node.decorator_list]
      methods = set()
      for d in node.decorator_list:
        if isinstance(d, ast.Call) and ast.unparse(d.func) == "app.route":
          methods |= {m for kw in d.keywords if kw.arg == "methods" for m in ast.literal_eval(kw.value)}
      if not methods - {"GET", "HEAD", "OPTIONS"}:
        continue
      if "login_required" not in decorators and (path.name, node.name) not in UNAUTHENTICATED_ENDPOINTS:
        missing.append(f"{path.name}:{node.name}")
  assert not missing, f"These endpoints change things without login_required: {missing}"


# ==========================================
# Git repositories named by webhooks
# ==========================================

@pytest.fixture
def git_utils():
  import backend.git_utils as git_utils
  return git_utils


@pytest.mark.parametrize("project_path", ["group/repo", "group/sub-group/repo.name", "CDE-Users/HW_ALG/KITT_ISP", "_x/y"])
def test_check_project_path_valid(git_utils, project_path):
  git_utils.check_project_path(project_path)


@pytest.mark.parametrize("project_path", [
  "/stage/algo_data", "../../etc", "group/../../x", "group/./repo", ".hidden/repo", "group//repo",
  "group/repo/", "", "-option/repo", "group/repo\n", "group/re po", "group/$(id)",
])
def test_check_project_path_invalid(git_utils, project_path):
  with pytest.raises(ValueError):
    git_utils.check_project_path(project_path)


def hosts_from(env):
  """Git hosts configured by these environment variables"""
  from backend.git_hosts import load_git_hosts
  return load_git_hosts(lambda key, default=None: env.get(key, default))


def test_repos_refuse_paths_outside_the_clone_directory(git_utils, tmp_path):
  repos = git_utils.Repos(hosts_from({"GITLAB_HOST": "https://gitlab.example.com"}), tmp_path / "git")
  for project_path in ["/tmp/x", "../outside"]:
    with pytest.raises(ValueError):
      repos.get(project_path)
  assert not (tmp_path / "outside").exists()


def git(*args, cwd=None):
  env = {"GIT_AUTHOR_NAME": "a", "GIT_AUTHOR_EMAIL": "a@example.com", "GIT_COMMITTER_NAME": "a", "GIT_COMMITTER_EMAIL": "a@example.com", "HOME": str(cwd or "/tmp")}
  return subprocess.run(["git", *args], cwd=cwd, env={**__import__("os").environ, **env}, check=True, capture_output=True, encoding="utf-8").stdout


class LocalHost:
  """A git host whose repositories are local folders"""
  def __init__(self, root):
    self.root = root
  def for_repo(self, git=None, project_url=None):
    return self
  def clone_url(self, path):
    return str(self.root / path)
  def git_env(self):
    return {}
  def redact(self, text):
    return text


@pytest.fixture
def local_repos(git_utils, tmp_path):
  """Repos that clone from tmp_path/remote/<path> to tmp_path/git/<path>"""
  for path in ("org/repo", "org/other", "org/broken"):
    git("init", "-q", str(tmp_path / "remote" / path))
    (tmp_path / "remote" / path / "src").mkdir()
    (tmp_path / "remote" / path / "src" / "file.txt").write_text("content")
    git("add", ".", cwd=tmp_path / "remote" / path)
    git("commit", "-q", "-m", "init", cwd=tmp_path / "remote" / path)
  return git_utils.Repos(LocalHost(tmp_path / "remote"), tmp_path / "git")


def test_repos_never_delete_what_they_did_not_clone(local_repos, tmp_path):
  clones = tmp_path / "git"
  assert local_repos.get("org/repo").working_tree_dir == str(clones / "org" / "repo")
  local_repos.get("org/other")
  # e.g. push webhooks for repositories named "org" or "org/repo/src"
  for path in ["org", "org/repo/src", "org/repo/src/file.txt", "org/repo/missing", "org/repo/src/missing/x"]:
    with pytest.raises(ValueError):
      local_repos.get(path)
  assert (clones / "org" / "repo" / "src" / "file.txt").read_text() == "content"
  assert local_repos.get("org/other").head.commit
  # A folder that is not a clone
  (clones / "org" / "folder").mkdir()
  (clones / "org" / "folder" / "data.txt").write_text("data")
  with pytest.raises(ValueError):
    local_repos.get("org/folder")
  assert (clones / "org" / "folder" / "data.txt").exists()
  # ...unless it's empty
  (clones / "org" / "broken").mkdir()
  assert local_repos.get("org/broken").head.commit
  assert not list(clones.glob("org/.*"))


def test_repos_replace_broken_clones(local_repos, tmp_path):
  clones = tmp_path / "git"
  local_repos.get("org/broken")
  (clones / "org" / "broken" / ".git" / "HEAD").unlink() # git can't read it anymore
  (clones / "org" / "broken" / "untracked.txt").write_text("x")
  repo = local_repos.get("org/broken")
  assert repo.head.commit and not (clones / "org" / "broken" / "untracked.txt").exists()
  assert not list(clones.glob("org/.*")) # temporary folders are removed
  # A broken clone with other clones inside is not ours to delete
  local_repos.get("org/repo")
  (clones / "org" / "broken" / ".git" / "HEAD").unlink()
  (clones / "org" / "broken" / "nested").mkdir()
  (clones / "org" / "broken" / "nested" / ".git").mkdir()
  with pytest.raises(ValueError):
    local_repos.get("org/broken")
  assert (clones / "org" / "broken" / "nested" / ".git").exists()


def test_failed_clones_leave_nothing_behind(local_repos, tmp_path):
  with pytest.raises(RuntimeError):
    local_repos.get("org/does-not-exist")
  assert sorted(p.name for p in (tmp_path / "git" / "org").iterdir()) == []


UNTRUSTED_URLS = ["https://attacker.example.com/org/repo", "ext::sh -c id", "file:///etc", "git@attacker.example.com:org/repo"]

def credentials(host):
  """What git gets from its credential helper: (the URLs where it can be used, user:password)"""
  env = host.git_env()
  if not env:
    return None
  config = {env[f"GIT_CONFIG_KEY_{i}"]: env[f"GIT_CONFIG_VALUE_{i}"] for i in range(int(env["GIT_CONFIG_COUNT"]))}
  assert config.pop("credential.helper") == "" # no other helpers
  urls = [key.removeprefix("credential.").removesuffix(".helper") for key in config]
  assert all("QABOARD_GIT_PASSWORD" in helper for helper in config.values())
  assert not any(key.startswith("http.") for key in config)
  return (urls[0] if len(urls) == 1 else urls), f"{env['QABOARD_GIT_USERNAME']}:{env['QABOARD_GIT_PASSWORD']}"


def test_tokens_are_only_sent_to_their_hosts():
  hosts = hosts_from({
    "GITLAB_HOST": "https://gitlab.example.com", "GITLAB_ACCESS_TOKEN": "gitlab-token",
    "GITHUB_ACCESS_TOKEN": "secret-token", "QABOARD_GITHUB_HOSTS": "github.corp.example.com",
  })
  auth = lambda git: (hosts.for_repo(git).clone_url("org/repo"), credentials(hosts.for_repo(git)))
  assert auth({"hosting_type": "github", "web_url": "https://github.com/org/repo"}) == ("https://github.com/org/repo", ("https://github.com", "x-access-token:secret-token"))
  assert auth({"hosting_type": "github", "web_url": "https://github.corp.example.com/org/repo"}) == ("https://github.corp.example.com/org/repo", ("https://github.corp.example.com", "x-access-token:secret-token"))
  for web_url in UNTRUSTED_URLS:
    with pytest.raises(ValueError):
      auth({"hosting_type": "github", "web_url": web_url})
    with pytest.raises(ValueError):
      auth({"hosting_type": "gitea", "web_url": web_url, "host": web_url})
    # Like before hosts were configurable, GitLab repositories default to GITLAB_HOST: the token stays there
    assert auth({"web_url": web_url, "host": web_url}) == ("https://gitlab.example.com/org/repo", ("https://gitlab.example.com", "oauth2:gitlab-token"))
  # Paths can't escape the host
  for path in ["../x", "@attacker.example.com/x", "org/repo/../../x"]:
    with pytest.raises(ValueError):
      hosts.default.clone_url(path)
  # Tokens are not shown in errors
  host = hosts.find("github.com")
  assert "secret-token" not in host.redact(f"fatal: {host.git_env()} https://x-access-token:secret-token@github.com")


def test_configured_hosts_tokens():
  import json
  hosts = hosts_from({
    "QABOARD_GIT_HOSTS": json.dumps([
      {"type": "gitea", "url": "https://codeberg.org", "token": "user:pass@word"},
      {"type": "github", "url": "https://github.com"},
      {"type": "bitbucket", "url": "https://bitbucket.org", "token_env": "BITBUCKET_TOKEN"},
      {"type": "generic", "url": "https://git.example.com"},
    ]),
    "GITHUB_ACCESS_TOKEN": "legacy-token",
    "BITBUCKET_TOKEN": "bb-token",
  })
  assert credentials(hosts.find("https://codeberg.org/x/y")) == ("https://codeberg.org", "user:pass@word")
  # Legacy tokens are used for the hosts they were for
  assert credentials(hosts.find("git@github.com:x/y")) == ("https://github.com", "x-access-token:legacy-token")
  assert credentials(hosts.find("bitbucket.org")) == ("https://bitbucket.org", "x-token-auth:bb-token")
  assert credentials(hosts.find("git.example.com")) is None
  for host in hosts:
    assert not host.token or host.token not in repr(host)
    assert "token" not in json.dumps(host.public())
  # git follows http => https redirects on the same host
  http = hosts_from({"GITLAB_HOST": "http://gitlab-srv/gitlab", "GITLAB_ACCESS_TOKEN": "t"}).default
  assert credentials(http) == (["http://gitlab-srv/gitlab", "https://gitlab-srv/gitlab"], "oauth2:t")


class Servers:
  """Two local HTTP servers with different hostnames, that log what they receive and can redirect to each other"""
  def __init__(self):
    import threading
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    self.log, self.routes = [], {}
    servers = self
    class Handler(BaseHTTPRequestHandler):
      def log_message(self, *args):
        pass
      def do_GET(self):
        servers.log.append((self.server.name, self.path, dict(self.headers)))
        for prefix, route in servers.routes.get(self.server.name, {}).items():
          if self.path.startswith(prefix):
            status, headers, body = route(self.path[len(prefix):]) if callable(route) else route
            break
        else:
          status, headers, body = 404, {}, b""
        self.send_response(status)
        for k, v in {**headers, "Content-Length": str(len(body))}.items():
          self.send_header(k, v.format(a=servers.a, b=servers.b) if isinstance(v, str) else v)
        self.end_headers()
        self.wfile.write(body)
    self.servers = []
    for name in ("a", "b"):
      server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
      server.name = name
      threading.Thread(target=server.serve_forever, daemon=True).start()
      self.servers.append(server)
    # Different hostnames for the same machine
    self.a = f"http://127.0.0.1:{self.servers[0].server_address[1]}"
    self.b = f"http://localhost:{self.servers[1].server_address[1]}"

  def received(self, name):
    return [(path, headers) for server, path, headers in self.log if server == name]

  def close(self):
    for server in self.servers:
      server.shutdown()
      server.server_close()


@pytest.fixture
def servers():
  servers = Servers()
  yield servers
  servers.close()


UNAUTHORIZED = (401, {"WWW-Authenticate": 'Basic realm="git"'}, b"")

def git_version():
  try:
    out = subprocess.run(["git", "--version"], capture_output=True, encoding="utf-8").stdout
  except OSError:
    return (0,)
  return tuple(int(x) for x in out.split()[2].split(".")[:2])


@pytest.mark.skipif(git_version() < (2, 31), reason="needs git>=2.31 for GIT_CONFIG_COUNT")
def test_git_doesnt_send_tokens_to_other_hosts_when_redirected(servers, tmp_path):
  import os
  from backend.git_hosts import GitLabHost
  host = GitLabHost(servers.a, token="secret-token")
  env = {**os.environ, "HOME": str(tmp_path), **host.git_env()}
  clone = lambda path: subprocess.run(["git", "clone", f"{servers.a}/{path}", str(tmp_path / "clones" / path)], env=env, capture_output=True, encoding="utf-8")
  authorizations = lambda name: [h.get("Authorization") for _, h in servers.received(name)]
  # Redirected to another host, that serves a repository (with git's "dumb" HTTP protocol: static files)
  git("init", "-q", str(tmp_path / "src"))
  git("commit", "-q", "--allow-empty", "-m", "init", cwd=tmp_path / "src")
  git("clone", "-q", "--bare", str(tmp_path / "src"), str(tmp_path / "bare"))
  git("update-server-info", cwd=tmp_path / "bare")
  def static(path):
    file = tmp_path / "bare" / path.split("?")[0]
    return (200, {}, file.read_bytes()) if file.is_file() else (404, {}, b"")
  servers.routes = {"a": {"/org/repo/": (301, {"Location": "{b}/other/repo/info/refs?service=git-upload-pack"}, b"")}, "b": {"/other/repo/": static}}
  assert clone("org/repo").returncode == 0
  assert len(servers.received("b")) > 2 and not any(authorizations("b"))
  assert not any(authorizations("a")) # it didn't ask
  # Redirected to another host, that asks for credentials
  servers.log.clear()
  servers.routes = {"a": {"/org/repo": (301, {"Location": "{b}/other/repo/info/refs?service=git-upload-pack"}, b"")}, "b": {"/": UNAUTHORIZED}}
  assert clone("org/repo2").returncode != 0
  assert servers.received("b") and not any(authorizations("b"))
  # On the same host, we authenticate when asked
  servers.log.clear()
  servers.routes = {"a": {"/org/repo": (301, {"Location": "{a}/other/repo/info/refs?service=git-upload-pack"}, b""), "/other/repo": UNAUTHORIZED}}
  assert clone("org/repo3").returncode != 0
  import base64
  assert "Basic " + base64.b64encode(b"oauth2:secret-token").decode() in authorizations("a")


def test_api_tokens_and_cookies_stay_on_their_host(servers):
  from backend.git_hosts import GitLabHost
  from backend.git_hosts.base import request_keeping_credentials_on_host
  host = GitLabHost(servers.a, token="secret-token")
  servers.routes = {
    "a": {"/api/v4/same": (302, {"Location": "{a}/api/v4/ok"}, b""), "/api/v4/ok": (200, {}, b"[]"), "/api/v4/users": (302, {"Location": "{b}/elsewhere"}, b"")},
    "b": {"/elsewhere": (302, {"Location": "{b}/again"}, b""), "/again": (200, {}, b"[]")},
  }
  assert host.api("GET", "/same").ok
  assert [h.get("Private-Token") for _, h in servers.received("a")] == ["secret-token", "secret-token"]
  assert host.api("GET", "/users").ok # like gitlab_users
  host.api("GET", "/users", headers={"Authorization": "Bearer x"}, cookies={"_gitlab_session": "cookie"})
  request_keeping_credentials_on_host("GET", f"{servers.a}/api/v4/users", cookies={"_gitlab_session": "cookie"})
  assert len(servers.received("b")) >= 4
  for _, headers in servers.received("b"):
    assert not {"Private-Token", "Authorization", "Cookie"} & set(headers), headers

# Webhook secret
# ==========================================

@pytest.fixture
def webhooks(monkeypatch):
  """Loads the real backend/api/webhooks.py"""
  monkeypatch.setitem(sys.modules, "backend.models.Project", types.SimpleNamespace(update_project=MagicMock()))
  path = Path(__file__).parent.parent / "backend" / "api" / "webhooks.py"
  spec = importlib.util.spec_from_file_location("backend.api._webhooks_under_test", path)
  module = importlib.util.module_from_spec(spec)
  spec.loader.exec_module(module)
  module.committers = MagicMock() # no redis
  module.Project = FakeProjects()
  return module


def configure(webhooks, **env):
  webhooks.git_hosts = hosts_from({"GITLAB_HOST": "https://gitlab.example.com", **env})


def post(webhooks, dummy_app, endpoint, payload, headers):
  import json
  body = payload if isinstance(payload, bytes) else json.dumps(payload).encode()
  with dummy_app.test_request_context(f"/webhook/{endpoint}", method="POST", data=body, headers=headers):
    response = getattr(webhooks, f"{endpoint}_webhook")()
  return response if isinstance(response, tuple) else (response, response.status_code)


def signature(secret, payload, prefix="sha256="):
  import hmac, hashlib, json
  return prefix + hmac.new(secret.encode(), json.dumps(payload).encode(), hashlib.sha256).hexdigest()


def test_webhooks_accept_anything_without_a_secret(webhooks, dummy_app):
  configure(webhooks)
  assert post(webhooks, dummy_app, "gitlab", gitlab_push(), {})[1] == 200
  assert post(webhooks, dummy_app, "github", github_push(), {})[1] == 200
  assert webhooks.update_project.call_count == 2


def test_gitlab_webhook_secret(webhooks, dummy_app):
  configure(webhooks, QABOARD_WEBHOOK_SECRET="s3cret")
  for payload in [{}, gitlab_push(), gitlab_push(web_url="https://unknown.example.com/group/repo")]:
    for headers in [{}, {"X-Gitlab-Token": "wrong"}, {"X-Gitlab-Token": ""}]:
      assert post(webhooks, dummy_app, "gitlab", payload, headers)[1] == 401
  webhooks.update_project.assert_not_called()
  assert post(webhooks, dummy_app, "gitlab", gitlab_push(), {"X-Gitlab-Token": "s3cret"})[1] == 200
  webhooks.update_project.assert_called_once()


def test_github_webhook_signature(webhooks, dummy_app):
  configure(webhooks, QABOARD_WEBHOOK_SECRET="s3cret")
  payload = github_push()
  good = signature("s3cret", payload)
  for headers in [{}, {"X-Hub-Signature-256": "sha256=0000"}, {"X-Hub-Signature-256": good.upper()}, {"X-Hub-Signature-256": signature("wrong", payload)}]:
    assert post(webhooks, dummy_app, "github", payload, headers)[1] == 401
  webhooks.update_project.assert_not_called()
  assert post(webhooks, dummy_app, "github", payload, {"X-Hub-Signature-256": good})[1] == 200
  webhooks.update_project.assert_called_once()


def test_webhooks_from_unknown_hosts_are_refused(webhooks, dummy_app, monkeypatch):
  configure(webhooks, QABOARD_WEBHOOK_SECRET="s3cret")
  payload = github_push(html_url="https://attacker.example.com/org/repo")
  for secret in ("wrong", "s3cret"):
    assert post(webhooks, dummy_app, "github", payload, {"X-Hub-Signature-256": signature(secret, payload)})[1] == 403
  # ...before we parse them
  from backend.git_hosts import BitbucketHost
  parse_push = MagicMock()
  monkeypatch.setattr(BitbucketHost, "parse_push", parse_push)
  payload = bitbucket_push()
  payload["repository"]["links"]["html"]["href"] = "https://attacker.example.com/org/repo"
  assert post(webhooks, dummy_app, "bitbucket", payload, {})[1] == 403
  parse_push.assert_not_called()
  webhooks.update_project.assert_not_called()


def test_hosts_without_a_secret_refuse_webhooks_if_others_have_one(webhooks, dummy_app):
  import json
  # No QABOARD_WEBHOOK_SECRET: github.com (always there, for backward compatibility) has no secret
  configure(webhooks, QABOARD_GIT_HOSTS=json.dumps([{"type": "gitlab", "url": "https://gitlab.example.com", "webhook_secret": "gitlab-secret"}]))
  assert webhooks.git_hosts.find("github.com").webhook_secret == ""
  status = lambda endpoint, payload, headers={}: post(webhooks, dummy_app, endpoint, payload, headers)[1]
  assert status("github", github_push(), {}) == 401
  assert status("github", github_push(), {"X-Hub-Signature-256": signature("", github_push())}) == 401
  assert status("gitlab", gitlab_push(), {}) == 401
  webhooks.update_project.assert_not_called()
  assert status("gitlab", gitlab_push(), {"X-Gitlab-Token": "gitlab-secret"}) == 200


def test_pushes_cant_change_the_host_of_a_project(webhooks, dummy_app):
  configure(webhooks)
  # Project ids are repository paths: "group/repo" on GitLab is the same project as "group/repo" on GitHub
  webhooks.Project = FakeProjects({
    "group/repo": {"git": {"hosting_type": "gitlab", "host": "https://gitlab.example.com", "path_with_namespace": "group/repo", "web_url": "https://gitlab.example.com/group/repo"}},
    "org/repo": {"git": {"path_with_namespace": "org/repo"}}, # created by the CLI: we don't know its host
    "old/repo": {"git": {"hosting_type": "gitea", "host": "https://gitea.removed.example.com", "web_url": "https://gitea.removed.example.com/old/repo"}},
  })
  payload = github_push()
  payload["repository"]["full_name"] = "group/repo"
  response, status = post(webhooks, dummy_app, "github", payload, {})
  assert status == 409 and "gitlab.example.com" in response.get_json()["error"]
  webhooks.update_project.assert_not_called()
  assert post(webhooks, dummy_app, "gitlab", gitlab_push(), {})[1] == 200
  assert post(webhooks, dummy_app, "github", github_push(), {})[1] == 200
  payload["repository"]["full_name"] = "old/repo"
  assert post(webhooks, dummy_app, "github", payload, {})[1] == 200 # its host is not configured anymore
  # Older data, without "host"
  webhooks.Project = FakeProjects({"group/repo": {"git": {"path_with_namespace": "group/repo", "web_url": "https://gitlab-alias/group/repo"}}})
  payload["repository"]["full_name"] = "group/repo"
  assert post(webhooks, dummy_app, "github", payload, {})[1] == 409


def test_webhooks_are_refused_if_the_configuration_is_invalid(webhooks, dummy_app):
  configure(webhooks, QABOARD_GIT_HOSTS='[{"type": "github", "url": "https://github.com", "webhook_secret": "s", "typo": 1}]')
  assert post(webhooks, dummy_app, "github", github_push(), {})[1] == 503
  webhooks.update_project.assert_not_called()


def test_webhooks_size(webhooks, dummy_app):
  configure(webhooks)
  webhooks.MAX_WEBHOOK_SIZE = 1000
  assert post(webhooks, dummy_app, "github", {**github_push(), "padding": "x" * 1000}, {})[1] == 413
  assert post(webhooks, dummy_app, "github", github_push(), {})[1] == 200


def test_bitbucket_authors_are_parsed_in_linear_time():
  import time
  from backend.git_hosts.bitbucket import parse_raw_author, bitbucket_user
  assert parse_raw_author("Emma <emma@example.com>") == ("Emma", "emma@example.com")
  assert parse_raw_author("  Emma Smith   <emma@example.com> ") == ("Emma Smith", "emma@example.com")
  assert parse_raw_author("Emma") == (None, None)
  assert parse_raw_author("Emma <emma") == (None, None)
  assert parse_raw_author(None) == (None, None)
  assert bitbucket_user({"raw": "Emma", "user": {"display_name": "E"}})["name"] == "E"
  start = time.monotonic()
  for raw in ["\t" * 15000 + "<", " " * 100_000 + "<" + "x" * 100_000, "<" * 100_000]:
    parse_raw_author(raw)
  assert time.monotonic() - start < 1


def test_webhooks_ignore_pings_from_unknown_hosts(webhooks, dummy_app):
  configure(webhooks, QABOARD_WEBHOOK_SECRET="s3cret")
  # Organization webhooks' pings have no repository
  response, status = post(webhooks, dummy_app, "github", {"zen": "x", "hook_id": 1}, {"X-GitHub-Event": "ping"})
  assert status == 200 and response.get_json()["status"] == "ignored"
  # Repository webhooks' pings are checked, to help setting the secret
  ping = {"zen": "x", "repository": github_push()["repository"]}
  assert post(webhooks, dummy_app, "github", ping, {"X-GitHub-Event": "ping"})[1] == 401
  assert post(webhooks, dummy_app, "github", ping, {"X-GitHub-Event": "ping", "X-Hub-Signature-256": signature("s3cret", ping)})[1] == 200


def test_per_host_webhook_secrets(webhooks, dummy_app):
  import json
  configure(webhooks, QABOARD_WEBHOOK_SECRET="global", QABOARD_GIT_HOSTS=json.dumps([
    {"type": "github", "url": "https://github.com", "webhook_secret": "github-secret"},
    {"type": "gitea", "url": "https://codeberg.org", "webhook_secret": "gitea-secret"},
    {"type": "bitbucket", "url": "https://bitbucket.org"},
  ]))
  cases = [
    ("github", github_push(), "X-Hub-Signature-256", "github-secret", "sha256="),
    ("gitea", gitea_push(), "X-Gitea-Signature", "gitea-secret", ""),
    ("gitea", gitea_push(), "X-Forgejo-Signature", "gitea-secret", ""),
    ("bitbucket", bitbucket_push(), "X-Hub-Signature", "global", "sha256="),
  ]
  for endpoint, payload, header, secret, prefix in cases:
    for wrong in ("wrong", "global" if secret != "global" else "github-secret"):
      assert post(webhooks, dummy_app, endpoint, payload, {header: signature(wrong, payload, prefix)})[1] == 401
    webhooks.update_project.assert_not_called()
    assert post(webhooks, dummy_app, endpoint, payload, {header: signature(secret, payload, prefix)})[1] == 200
    webhooks.update_project.assert_called_once()
    webhooks.update_project.reset_mock()


def test_webhooks_ignore_other_events(webhooks, dummy_app):
  configure(webhooks)
  ping = {"zen": "Keep it logically awesome.", "hook_id": 1}
  response, status = post(webhooks, dummy_app, "github", ping, {"X-GitHub-Event": "ping"})
  assert status == 200 and response.get_json()["status"] == "ignored"
  assert post(webhooks, dummy_app, "github", b"not json", {})[1] == 400
  assert post(webhooks, dummy_app, "github", {"repository": {"html_url": "https://github.com/org/repo"}}, {})[1] == 400
  webhooks.update_project.assert_not_called()


# ==========================================
# The gitlab proxy only fetches from known hosts
# ==========================================

@pytest.fixture
def integrations(monkeypatch, tmp_path):
  """Loads the real backend/api/integrations.py"""
  return load_integrations(monkeypatch, tmp_path, {"GITLAB_HOST": "https://gitlab.example.com"})


def load_integrations(monkeypatch, tmp_path, git_hosts_env):
  """backend/api/integrations.py, with the git hosts configured by `git_hosts_env`"""
  monkeypatch.setenv("GITLAB_HOST", "https://gitlab.example.com")
  monkeypatch.setenv("QABOARD_PROXY_HOSTS", "avatars.example.com, Badges.example.com:8081")
  monkeypatch.delenv("QABOARD_GITLAB_HOSTS", raising=False)
  monkeypatch.delenv("GITLAB_AUTH", raising=False)
  import backend.config
  monkeypatch.setattr(backend.config, "git_server", "https://gitlab.example.com")
  monkeypatch.setattr(backend.config, "qaboard_data_dir", tmp_path)
  # the proxy fetches from the git hosts
  import backend.git_hosts
  monkeypatch.setattr(backend.git_hosts, "git_hosts", hosts_from(git_hosts_env))
  path = Path(__file__).parent.parent / "backend" / "api" / "integrations.py"
  spec = importlib.util.spec_from_file_location("backend.api._integrations_under_test", path)
  module = importlib.util.module_from_spec(spec)
  spec.loader.exec_module(module)
  return module


def fake_response(status_code=200, headers=None, content=b"<svg/>"):
  r = MagicMock(status_code=status_code, content=content, headers=headers or {"Content-Type": "image/svg+xml"})
  r.is_redirect = status_code in (301, 302, 303, 307, 308)
  return r


@pytest.mark.parametrize("url", [
  "https://gitlab.example.com/uploads/-/system/user/avatar/1/avatar.png",
  "http://gitlab.example.com:8080/avatar.png",
  "https://secure.gravatar.com/avatar/abc",
  "https://avatars.example.com/a.jpg",
  "https://badges.example.com:8081/coverage.svg",
])
def test_gitlab_proxy_allowed_hosts(integrations, url):
  assert integrations.is_proxy_allowed(url)


@pytest.mark.parametrize("url", [
  "http://localhost:5000/api/v1/health",
  "http://169.254.169.254/latest/meta-data/",
  "http://db:5432",
  "https://gitlab.example.com.attacker.com/x",
  "https://attacker.com/?gitlab.example.com",
  "https://gitlab.example.com@attacker.com/",
  "file:///etc/passwd",
  "gopher://gitlab.example.com/",
  "/etc/passwd",
])
def test_gitlab_proxy_refuses_other_urls(integrations, dummy_app, monkeypatch, url):
  get = MagicMock(return_value=fake_response())
  monkeypatch.setattr(integrations.requests, "get", get)
  with dummy_app.test_request_context("/api/v1/gitlab/proxy", query_string={"url": url}):
    response, status = integrations.proxy_gitlab()
  assert status == 403
  get.assert_not_called()


def test_gitlab_proxy_checks_redirects(integrations, dummy_app, monkeypatch):
  get = MagicMock(side_effect=[
    fake_response(302, {"Location": "/avatar/2.png"}),
    fake_response(302, {"Location": "http://169.254.169.254/latest/meta-data/"}),
  ])
  monkeypatch.setattr(integrations.requests, "get", get)
  with dummy_app.test_request_context("/api/v1/gitlab/proxy", query_string={"url": "https://gitlab.example.com/avatar/1.png"}):
    response, status = integrations.proxy_gitlab()
  assert status == 403
  assert [c.args[0] for c in get.call_args_list] == ["https://gitlab.example.com/avatar/1.png", "https://gitlab.example.com/avatar/2.png"]
  assert all(c.kwargs["allow_redirects"] is False for c in get.call_args_list)


def test_gitlab_proxy_response(integrations, dummy_app, monkeypatch):
  headers = {"Content-Type": "image/svg+xml", "Set-Cookie": "_gitlab_session=secret", "Content-Encoding": "gzip", "ETag": "abc"}
  monkeypatch.setattr(integrations.requests, "get", MagicMock(return_value=fake_response(200, headers)))
  monkeypatch.setitem(integrations.gitlab_cookies, "gitlab.example.com", "session-cookie")
  with dummy_app.test_request_context("/api/v1/gitlab/proxy", query_string={"url": "https://gitlab.example.com/badge.svg"}):
    response = integrations.proxy_gitlab()
  assert response.status_code == 200
  assert response.get_data() == b"<svg/>"
  assert integrations.requests.get.call_args.kwargs["cookies"] == {"_gitlab_session": "session-cookie"}
  assert response.headers["Content-Type"] == "image/svg+xml"
  assert response.headers["ETag"] == "abc"
  assert "Set-Cookie" not in response.headers
  assert "Content-Encoding" not in response.headers
  assert "sandbox" in response.headers["Content-Security-Policy"]
  assert response.headers["X-Content-Type-Options"] == "nosniff"


def test_git_proxy_allows_all_git_hosts(monkeypatch, tmp_path):
  # The web app loads the images of every configured git host through the proxy
  integrations = load_integrations(monkeypatch, tmp_path, {
    "QABOARD_GIT_HOSTS": json.dumps([
      {"type": "gitea", "url": "https://codeberg.org", "hostnames": ["codeberg-alias.example.com"]},
      {"type": "github", "url": "https://github.example.com"},
      {"type": "bitbucket", "url": "https://bitbucket.example.com"},
      {"type": "gitlab", "url": "https://gitlab.example.com", "user_avatar_url": "https://people.example.com/{username}.jpg"},
    ]),
    "QABOARD_AVATAR_URL": "https://avatars.legacy.example.com/{user_name}.jpg",
  })
  for url in [
    "https://codeberg.org/user/avatar/alice/-1",
    "https://codeberg-alias.example.com/a.png",
    "https://github.example.com/alice.png",
    "https://github.example.com/api/v3/x.png",
    "https://bitbucket.example.com/a.png",
    "https://gitlab.example.com/uploads/a.png",
    "https://people.example.com/alice.jpg",
    "https://avatars.githubusercontent.com/u/1",
  ]:
    assert integrations.is_proxy_allowed(url), url
  assert not integrations.is_proxy_allowed("https://attacker.example.com/a.png")


def test_git_proxy_avatar_url_template(monkeypatch, tmp_path):
  integrations = load_integrations(monkeypatch, tmp_path, {
    "GITLAB_HOST": "https://gitlab.example.com",
    "QABOARD_AVATAR_URL": "https://dag.example.com:8081/{user_name}.jpg",
  })
  assert integrations.is_proxy_allowed("https://dag.example.com:8081/alice.jpg")


def test_git_proxy_keeps_the_session_cookie_on_its_host(integrations, dummy_app, monkeypatch):
  # e.g. avatars redirect to object storage: the session cookie stays on GitLab
  monkeypatch.setattr(integrations, "proxy_hosts", {*integrations.proxy_hosts, "storage.example.com"})
  monkeypatch.setitem(integrations.gitlab_cookies, "gitlab.example.com", "session-cookie")
  get = MagicMock(side_effect=[
    fake_response(302, {"Location": "https://storage.example.com/avatar.png"}),
    fake_response(200),
  ])
  monkeypatch.setattr(integrations.requests, "get", get)
  with dummy_app.test_request_context("/api/v1/git/proxy", query_string={"url": "https://gitlab.example.com/avatar.png"}):
    response = integrations.proxy_gitlab()
  assert response.status_code == 200
  assert [c.kwargs["cookies"] for c in get.call_args_list] == [{"_gitlab_session": "session-cookie"}, {}]
