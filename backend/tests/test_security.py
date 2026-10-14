"""
Tests for backend/shell_utils.py and the `login_required` decorator in backend/api/auth.py
"""
import sys
import types
import subprocess
import importlib.util
from pathlib import Path
from unittest.mock import MagicMock

import pytest
import requests # before the auth fixture stubs simplejson, that requests would use
from flask import g

from backend.shell_utils import quote, is_shell_safe, shell_safe, safe_user_name, lsf_bridge_command


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
  ("integrations.py", "gitlab_job"), ("integrations.py", "jenkins_build"),
  # checks the login itself when writing
  ("tuning.py", "groups"),
  # authenticated with QABOARD_WEBHOOK_SECRET
  ("webhooks.py", "gitlab_webhook"), ("webhooks.py", "github_webhook"),
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


def test_repos_refuse_paths_outside_the_clone_directory(git_utils, tmp_path):
  repos = git_utils.Repos("https://gitlab.example.com", tmp_path / "git")
  for project_path in ["/tmp/x", "../outside"]:
    with pytest.raises(ValueError):
      repos.get(project_path)
  assert not (tmp_path / "outside").exists()


def test_github_token_only_sent_to_trusted_hosts(git_utils, monkeypatch):
  monkeypatch.setenv("GITHUB_ACCESS_TOKEN", "secret-token")
  repos = git_utils.Repos("https://gitlab.example.com", Path("/nonexistent"))
  url = repos._authenticated_clone_url("org/repo", hosting_type="github", web_url="https://github.com/org/repo")
  assert url == "https://x-access-token:secret-token@github.com/org/repo"
  for web_url in ["https://attacker.example.com/org/repo", "ext::sh -c id", "file:///etc"]:
    with pytest.raises(ValueError):
      repos._authenticated_clone_url("org/repo", hosting_type="github", web_url=web_url)
  monkeypatch.setattr(git_utils, "trusted_github_hosts", {"github.com", "github.corp.example.com"})
  url = repos._authenticated_clone_url("org/repo", hosting_type="github", web_url="https://github.corp.example.com/org/repo")
  assert url == "https://x-access-token:secret-token@github.corp.example.com/org/repo"


# ==========================================
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
  return module


def test_webhooks_accept_anything_without_a_secret(webhooks, dummy_app):
  webhooks.webhook_secret = ""
  with dummy_app.test_request_context("/webhook/gitlab", method="POST", data="{}"):
    assert webhooks.is_gitlab_webhook_authentic()
    assert webhooks.is_github_webhook_authentic()


def test_gitlab_webhook_secret(webhooks, dummy_app):
  webhooks.webhook_secret = "s3cret"
  with dummy_app.test_request_context("/webhook/gitlab", method="POST", data="{}", headers={"X-Gitlab-Token": "s3cret"}):
    assert webhooks.is_gitlab_webhook_authentic()
  for headers in [{}, {"X-Gitlab-Token": "wrong"}, {"X-Gitlab-Token": ""}]:
    with dummy_app.test_request_context("/webhook/gitlab", method="POST", data="{}", headers=headers):
      assert not webhooks.is_gitlab_webhook_authentic()
      _, status = webhooks.gitlab_webhook()
      assert status == 401
  webhooks.update_project.assert_not_called()


def test_github_webhook_signature(webhooks, dummy_app):
  import hmac, hashlib
  webhooks.webhook_secret = "s3cret"
  body = b'{"ref": "refs/heads/main"}'
  signature = "sha256=" + hmac.new(b"s3cret", body, hashlib.sha256).hexdigest()
  with dummy_app.test_request_context("/webhook/github", method="POST", data=body, headers={"X-Hub-Signature-256": signature}):
    assert webhooks.is_github_webhook_authentic()
  for headers in [{}, {"X-Hub-Signature-256": "sha256=0000"}, {"X-Hub-Signature-256": signature.upper()}]:
    with dummy_app.test_request_context("/webhook/github", method="POST", data=body, headers=headers):
      assert not webhooks.is_github_webhook_authentic()
      _, status = webhooks.github_webhook()
      assert status == 401
  webhooks.update_project.assert_not_called()


# ==========================================
# The gitlab proxy only fetches from known hosts
# ==========================================

@pytest.fixture
def integrations(monkeypatch, tmp_path):
  """Loads the real backend/api/integrations.py"""
  monkeypatch.setenv("GITLAB_HOST", "https://gitlab.example.com")
  monkeypatch.setenv("QABOARD_PROXY_HOSTS", "avatars.example.com, Badges.example.com:8081")
  monkeypatch.delenv("QABOARD_GITLAB_HOSTS", raising=False)
  monkeypatch.delenv("GITLAB_AUTH", raising=False)
  import backend.config
  monkeypatch.setattr(backend.config, "git_server", "https://gitlab.example.com")
  monkeypatch.setattr(backend.config, "qaboard_data_dir", tmp_path)
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
