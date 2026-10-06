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
  stubs = {name: MagicMock() for name in ("ldap", "simplejson")}
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
