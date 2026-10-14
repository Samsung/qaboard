"""
Tests for backend/git_hosts: configuration, webhooks normalization, avatars, CI integrations.
Security properties (tokens and webhook secrets) are tested in test_security.py
"""
import json
from unittest.mock import MagicMock

import pytest

from .git_payloads import gitlab_push, github_push, gitea_push, bitbucket_push


def hosts_from(env, strict=False):
  from backend.git_hosts import load_git_hosts
  return load_git_hosts(lambda key, default=None: env.get(key, default), strict=strict)


# ==========================================
# Configuration
# ==========================================

def test_defaults_are_backward_compatible():
  hosts = hosts_from({})
  assert [(h.type, h.url) for h in hosts] == [("gitlab", "https://gitlab.com"), ("github", "https://github.com")]
  assert hosts.default.url == "https://gitlab.com"

  hosts = hosts_from({"GITLAB_HOST": "http://gitlab-srv/", "QABOARD_GITLAB_HOSTS": "gitlab-alias.example.com,http://gitlab3", "QABOARD_GITHUB_HOSTS": "github.corp.example.com"})
  assert [(h.type, h.url) for h in hosts] == [
    ("gitlab", "http://gitlab-srv"), ("gitlab", "http://gitlab3"),
    ("github", "https://github.com"), ("github", "https://github.corp.example.com"),
  ]
  assert not hosts.errors
  assert hosts.default.url == "http://gitlab-srv"
  assert hosts.default.api_url == "http://gitlab-srv/api/v4"
  # Hostnames in QABOARD_GITLAB_HOSTS are other names of GITLAB_HOST, like before: same token, scheme, users
  assert hosts.find("https://gitlab-alias.example.com/group/repo") is hosts.default
  assert hosts.for_repo({"web_url": "https://gitlab-alias.example.com/group/repo"}).clone_url("group/repo") == "http://gitlab-srv/group/repo"
  assert hosts.find("https://github.corp.example.com/x").api_url == "https://github.corp.example.com/api/v3"
  assert hosts.find("github.com").api_url == "https://api.github.com"
  # Without a scheme in QABOARD_GITHUB_HOSTS, we use the repositories' scheme, like before
  ghe = lambda web_url: hosts.for_repo({"hosting_type": "github", "web_url": web_url})
  assert ghe("https://github.corp.example.com/org/repo").clone_url("org/repo") == "https://github.corp.example.com/org/repo"
  assert ghe("http://github.corp.example.com/org/repo").clone_url("org/repo") == "http://github.corp.example.com/org/repo"
  assert ghe("http://github.corp.example.com/org/repo").api_url == "http://github.corp.example.com/api/v3"
  assert hosts.for_repo({"hosting_type": "github", "host": "https://github.corp.example.com", "web_url": "http://github.corp.example.com/org/repo"}).url == "http://github.corp.example.com"
  # ...but not for github.com
  assert ghe("http://github.com/org/repo").url == "https://github.com"


def test_legacy_settings_are_normalized():
  # GITLAB_HOST without a scheme
  hosts = hosts_from({"GITLAB_HOST": "gitlab-srv", "GITLAB_ACCESS_TOKEN": "t"})
  assert (hosts.default.url, hosts.default.token, hosts.errors) == ("https://gitlab-srv", "t", [])
  # Credentials in GITLAB_HOST: used if there's no token, never shown
  hosts = hosts_from({"GITLAB_HOST": "https://user:p%40ss@gitlab.example.com:8080/"})
  assert (hosts.default.url, hosts.default.token) == ("https://gitlab.example.com:8080", "user:p@ss")
  assert "p@ss" not in json.dumps(hosts.public())
  hosts = hosts_from({"GITLAB_HOST": "https://user:pass@gitlab.example.com", "GITLAB_ACCESS_TOKEN": "t"})
  assert (hosts.default.url, hosts.default.token) == ("https://gitlab.example.com", "t")


@pytest.mark.parametrize("env", [
  {"GITLAB_HOST": "ftp://gitlab.example.com"},
  {"GITLAB_HOST": "https://gitlab.example.com:port"},
  {"QABOARD_GITLAB_HOSTS": "ftp://gitlab2"},
  {"QABOARD_GIT_HOSTS": "/does/not/exist.yaml"},
  {"QABOARD_GIT_HOSTS": '[{"type": "gitlab", "url": "https://gitlab.example.com", "token_env": "GITLAB_ACCESS_TOKEN", "typo": 1}]'},
])
def test_invalid_settings_dont_stop_the_server(env):
  hosts = hosts_from({"GITLAB_ACCESS_TOKEN": "gitlab-token", **env})
  assert hosts.errors
  assert hosts.default
  # We never guess where GITLAB_ACCESS_TOKEN should go
  tokens = {h.url: h.token for h in hosts}
  if "QABOARD_GITLAB_HOSTS" in env: # like before, without GITLAB_HOST: gitlab.com
    assert tokens == {"https://gitlab.com": "gitlab-token", "https://github.com": ""}
  else:
    assert "gitlab-token" not in tokens.values()
  with pytest.raises(ValueError):
    hosts_from({"GITLAB_ACCESS_TOKEN": "gitlab-token", **env}, strict=True)


def test_gitlab_and_github_hosts_with_the_same_hostname():
  # e.g. GITLAB_HOST was a GitHub Enterprise server
  hosts = hosts_from({"GITLAB_HOST": "https://ghe.example.com", "QABOARD_GITHUB_HOSTS": "ghe.example.com", "GITHUB_ACCESS_TOKEN": "gh"})
  assert [(h.type, h.url) for h in hosts] == [("gitlab", "https://ghe.example.com"), ("github", "https://github.com"), ("github", "https://ghe.example.com")]
  github = hosts.for_repo({"hosting_type": "github", "web_url": "https://ghe.example.com/org/repo"})
  assert (github.type, github.token) == ("github", "gh")
  assert hosts.find("https://ghe.example.com/org/repo", "github") is github
  assert hosts.for_repo({"web_url": "https://ghe.example.com/org/repo"}) is hosts.default


def test_stored_hosts_that_are_not_configured_anymore():
  # e.g. the migration that describes hosts ran without GITLAB_HOST: it wrote gitlab.com
  hosts = hosts_from({"GITLAB_HOST": "http://gitlab-srv"})
  git = {"hosting_type": "gitlab", "host": "https://gitlab.com", "web_url": "http://gitlab-srv/group/repo"}
  assert hosts.for_repo(git) is hosts.default
  assert hosts.for_repo({**git, "web_url": "http://unknown-alias/group/repo"}) is hosts.default


def test_server_tokens_only_come_from_the_environment(monkeypatch):
  import qaboard.site_config as site_config
  from backend.git_hosts import load_git_hosts
  for name in ("GITLAB_HOST", "GITLAB_ACCESS_TOKEN", "GITHUB_ACCESS_TOKEN", "QABOARD_GIT_HOSTS", "QABOARD_WEBHOOK_SECRET", "QABOARD_AVATAR_URL", "QABOARD_GITLAB_HOSTS", "QABOARD_GITHUB_HOSTS"):
    monkeypatch.delenv(name, raising=False)
  # e.g. QA_SECRETS has the CI's token, for the CLI
  monkeypatch.setattr(site_config, "secrets", {"GITLAB_ACCESS_TOKEN": "ci-token", "GITLAB_HOST": "https://gitlab-for-the-cli"})
  monkeypatch.setattr(site_config, "_site_defaults", {"GITLAB_HOST": "https://gitlab.example.com", "GITHUB_ACCESS_TOKEN": "site-token", "QABOARD_AVATAR_URL": "https://avatars/{user_name}.jpg"})
  hosts = load_git_hosts()
  assert (hosts.default.url, hosts.default.token, hosts.default.user_avatar_url) == ("https://gitlab.example.com", "", "https://avatars/{username}.jpg")
  assert hosts.find("github.com").token == ""
  monkeypatch.setenv("GITLAB_ACCESS_TOKEN", "server-token")
  monkeypatch.setenv("QABOARD_GIT_HOSTS", '[{"type": "gitea", "url": "https://codeberg.org", "token_env": "GITEA_TOKEN"}]')
  monkeypatch.setitem(site_config._site_defaults, "GITEA_TOKEN", "site-token")
  monkeypatch.setenv("GITEA_TOKEN", "gitea-token")
  hosts = load_git_hosts()
  assert hosts.default.token == "server-token"
  assert hosts.find("codeberg.org").token == "gitea-token"


def test_configured_hosts(tmp_path):
  config = [
    {"type": "github", "url": "https://github.com", "token": "gh"},
    {"type": "forgejo", "url": "https://codeberg.org", "name": "Codeberg"},
    {"type": "gitlab", "url": "https://gitlab.example.com", "hostnames": ["gitlab-srv", "git@gitlab-alias"]},
    {"type": "generic", "url": "https://git.example.com"},
  ]
  hosts = hosts_from({"QABOARD_GIT_HOSTS": json.dumps(config)})
  # Without GITLAB_HOST, the first host is the default, and we don't add gitlab.com
  assert hosts.default.url == "https://github.com"
  assert [h.url for h in hosts] == ["https://github.com", "https://codeberg.org", "https://gitlab.example.com", "https://git.example.com"]
  assert hosts.public()[1] == {"type": "gitea", "url": "https://codeberg.org", "name": "Codeberg"}
  assert hosts.find("http://gitlab-srv/group/repo").url == "https://gitlab.example.com"
  assert hosts.find("git@gitlab-alias:group/repo.git").url == "https://gitlab.example.com"
  assert hosts.find("https://gitlab-srv/group/repo", type="github") is None
  assert hosts.find("https://codeberg.org/x/y", type="forgejo").type == "gitea"
  assert hosts.find("https://unknown.example.com/x") is None

  # GITLAB_HOST stays the default
  hosts = hosts_from({"QABOARD_GIT_HOSTS": json.dumps(config), "GITLAB_HOST": "https://gitlab.example.com", "GITLAB_ACCESS_TOKEN": "gl"})
  assert hosts.default.url == "https://gitlab.example.com"
  assert hosts.default.token == "gl"
  assert len(hosts.hosts) == 4

  # From a file
  path = tmp_path / "git-hosts.yaml"
  path.write_text("- type: gitea\n  url: https://gitea.example.com\n  webhook_secret_env: GITEA_SECRET\n")
  hosts = hosts_from({"QABOARD_GIT_HOSTS": str(path), "GITEA_SECRET": "s", "QABOARD_WEBHOOK_SECRET": "global"})
  assert hosts.default.url == "https://gitea.example.com"
  assert hosts.default.webhook_secret == "s"
  assert hosts.find("github.com").webhook_secret == "global"


@pytest.mark.parametrize("config", [
  '{"type": "github"}', '[{"type": "svn", "url": "https://svn.example.com"}]', '[{"type": "github"}]',
  '[{"type": "github", "url": "ftp://github.com"}]', '[{"type": "github", "url": "https://user:pass@github.com"}]',
  '[{"type": "github", "url": "https://github.com", "unknown_option": 1}]',
])
def test_invalid_configurations(config):
  with pytest.raises(ValueError):
    hosts_from({"QABOARD_GIT_HOSTS": config}, strict=True)
  # The server still starts (and migrations run), but refuses webhooks
  assert hosts_from({"QABOARD_GIT_HOSTS": config}).errors


def test_hostname_of():
  from backend.git_hosts.base import hostname_of
  assert hostname_of("https://GitLab.example.com:8080/group/repo") == "gitlab.example.com"
  assert hostname_of("git@github.com:org/repo.git") == "github.com"
  assert hostname_of("ssh://git@gitlab-srv:2222/x/y") == "gitlab-srv"
  assert hostname_of("gitlab-srv:8080") == "gitlab-srv"
  assert hostname_of("gitlab-srv") == "gitlab-srv"
  assert hostname_of(None) is None
  assert hostname_of("") is None


def test_hosts_of_repositories():
  hosts = hosts_from({"GITLAB_HOST": "https://gitlab.example.com", "QABOARD_GIT_HOSTS": json.dumps([{"type": "gitea", "url": "https://codeberg.org"}])})
  host = lambda git, project_url=None: hosts.for_repo(git, project_url).url
  # Migrated data
  assert host({"hosting_type": "github", "host": "https://github.com", "web_url": "https://github.com/a/b"}) == "https://github.com"
  # Older data
  assert host({"hosting_type": "github", "web_url": "https://github.com/a/b"}) == "https://github.com"
  assert host({"web_url": "https://codeberg.org/a/b"}) == "https://codeberg.org"
  assert host({"web_url": "https://gitlab-alias/a/b"}) == "https://gitlab.example.com"
  assert host({}) == "https://gitlab.example.com"
  assert host(None) == "https://gitlab.example.com"
  assert host({"hosting_type": "github"}) == "https://github.com"
  # Projects created by the CLI, with project.url in qaboard.yaml
  assert host({"path_with_namespace": "a/b"}, "git@codeberg.org:a/b.git") == "https://codeberg.org"
  with pytest.raises(ValueError):
    hosts.for_repo({"hosting_type": "bitbucket"})

  assert hosts.describe({"web_url": "https://codeberg.org/a/b"}) == {"web_url": "https://codeberg.org/a/b", "hosting_type": "gitea", "host": "https://codeberg.org"}
  assert hosts.describe({"hosting_type": "github", "web_url": "https://unknown/a/b"}) == {"hosting_type": "github", "web_url": "https://unknown/a/b"}


# ==========================================
# Push webhooks
# ==========================================

def test_gitlab_push():
  from backend.git_hosts import GitLabHost
  payload = gitlab_push()
  push = GitLabHost.parse_push(payload, {})
  assert push["ref"] == "refs/heads/feature/x"
  assert push["checkout_sha"] == payload["checkout_sha"]
  # we keep all of GitLab's fields
  assert push["project"] == payload["project"]
  assert {"name": "Jane Doe", "email": "jane@example.com"} in push["committers"]
  assert {"name": "John Smith", "username": "jsmith", "email": "john@example.com", "avatar_url": payload["user_avatar"]} in push["committers"]
  assert GitLabHost.parse_push({**payload, "object_kind": "merge_request"}, {}) is None
  assert GitLabHost("https://gitlab.example.com").describe(push["project"])["hosting_type"] == "gitlab"


SAME_SHAPE = {"path_with_namespace", "web_url", "name", "description", "avatar_url", "default_branch", "namespace"}

def test_github_push():
  from backend.git_hosts import GitHubHost
  push = GitHubHost.parse_push(github_push(), {"X-GitHub-Event": "push"})
  assert push["ref"] == "refs/heads/main"
  assert push["checkout_sha"] == "6113728f27ae82c7b1a177c8d03f9e96e0adf246"
  assert SAME_SHAPE <= set(push["project"])
  assert push["project"]["path_with_namespace"] == "org/repo"
  assert push["project"]["web_url"] == "https://github.com/org/repo"
  assert push["project"]["default_branch"] == "main"
  assert push["project"]["avatar_url"] == "https://avatars.githubusercontent.com/u/1?v=4"
  # the sender's avatar
  assert {"name": "The Octocat", "email": "octocat@github.com", "username": "octocat", "avatar_url": "https://avatars.githubusercontent.com/u/583231?v=4"} in push["committers"]
  assert GitHubHost.parse_push(github_push(), {"X-GitHub-Event": "ping"}) is None
  deleted = {**github_push(), "deleted": True, "after": "0" * 40}
  assert GitHubHost.parse_push(deleted, {})["checkout_sha"] is None


def test_gitea_push():
  from backend.git_hosts import GiteaHost
  push = GiteaHost.parse_push(gitea_push(), {"X-Gitea-Event": "push"})
  assert SAME_SHAPE <= set(push["project"])
  assert push["project"]["web_url"] == "https://codeberg.org/org/repo"
  assert push["project"]["avatar_url"] == "https://codeberg.org/avatars/1"
  assert push["checkout_sha"] == "bffeb74224043ba2feb48d137756c8a9331c449a"
  assert {"name": "Gitea User", "email": "gitea@example.com", "username": "gitea", "avatar_url": "https://codeberg.org/avatars/2"} in push["committers"]
  assert GiteaHost.parse_push(gitea_push(), {"X-Forgejo-Event": "issues"}) is None
  assert GiteaHost.parse_push({**gitea_push(), "after": "0" * 40}, {})["checkout_sha"] is None


def test_bitbucket_push():
  from backend.git_hosts import BitbucketHost
  push = BitbucketHost.parse_push(bitbucket_push(), {"X-Event-Key": "repo:push"})
  assert SAME_SHAPE <= set(push["project"])
  assert push["ref"] == "refs/heads/main"
  assert push["checkout_sha"] == "709d658dc5b6d6afcd46049c2f332ee3f515a67d"
  assert push["project"]["web_url"] == "https://bitbucket.org/workspace/repo"
  assert push["project"]["namespace"] == "workspace"
  assert {"name": "Emma", "email": "emma@example.com", "username": "emma", "avatar_url": None} in push["committers"]
  assert BitbucketHost.parse_push(bitbucket_push(), {"X-Event-Key": "pullrequest:created"}) is None
  deleted = bitbucket_push()
  deleted["push"]["changes"][0]["new"] = None
  assert BitbucketHost.parse_push(deleted, {})["checkout_sha"] is None


def test_branch_from_ref():
  from backend.git_hosts.base import branch_from_ref
  assert branch_from_ref("refs/heads/feature/x") == "feature/x"
  assert branch_from_ref("refs/tags/v1.0") == "v1.0"


# ==========================================
# Avatars
# ==========================================

class FakeRedis:
  def __init__(self):
    self.hashes = {}
  def hmget(self, key, fields):
    return [self.hashes.get(key, {}).get(f) for f in fields]
  def hset(self, key, mapping):
    self.hashes.setdefault(key, {}).update({k: v.encode() for k, v in mapping.items()})
  def hgetall(self, key):
    return {k.encode(): v for k, v in self.hashes.get(key, {}).items()}


@pytest.fixture
def committers(monkeypatch):
  from backend.git_hosts import committers
  monkeypatch.setattr(committers, "redis_client", FakeRedis())
  monkeypatch.setattr(committers, "_committers", {})
  return committers


def test_committers_are_shared_between_workers(committers, monkeypatch):
  committers.remember([{"name": "The Octocat", "username": "octocat", "email": "[REDACTED]"}], host_url="https://github.com")
  assert committers.lookup("the octocat") == {"username": "octocat", "host": "https://github.com"}
  # another worker
  monkeypatch.setattr(committers, "_committers", {})
  monkeypatch.setattr(committers, "_loaded_at", -float("inf"))
  assert committers.lookup("The Octocat") == {"username": "octocat", "host": "https://github.com"}
  # the CLI can't overwrite what webhooks told us
  committers.remember([{"name": "The Octocat", "username": "evil", "email": "octocat@github.com"}], overwrite=False)
  assert committers.lookup("The Octocat") == {"username": "octocat", "host": "https://github.com", "email": "octocat@github.com"}


def test_avatars(committers):
  from backend.git_hosts import GitHubHost, GiteaHost, GitHost
  from backend.git_hosts.base import gravatar_url
  github = GitHubHost("https://github.com")
  assert github.avatar_url("Unknown") == ""
  assert github.avatar_url("Octocat", {"username": "octocat", "host": "https://github.com"}) == "https://github.com/octocat.png"
  assert github.avatar_url("Octocat", {"username": "octocat", "host": "https://github.com", "avatar_url": "https://avatars/1"}) == "https://avatars/1"
  # usernames from other hosts mean nothing here
  assert github.avatar_url("Octocat", {"username": "octocat", "host": "https://codeberg.org", "email": "o@example.com"}) == gravatar_url("o@example.com")
  assert GiteaHost("https://codeberg.org").avatar_url("x", {"username": "x", "host": "https://codeberg.org"}) == "https://codeberg.org/user/avatar/x/-1"
  assert GitHost("https://git.example.com", user_avatar_url="https://avatars.example.com/{username}.jpg").avatar_url("x", {"username": "x", "host": "https://git.example.com"}) == "https://avatars.example.com/x.jpg"
  assert gravatar_url(" O@Example.com") == gravatar_url("o@example.com")


def test_gitlab_avatars(committers, monkeypatch):
  from backend.git_hosts import gitlab, GitLabHost
  users = {
    "jane doe": {"username": "jdoe", "avatar_url": "https://gitlab.example.com/uploads/jdoe.png"},
    "john smith": {"username": "jsmith", "avatar_url": "https://www.gravatar.com/avatar/123", "identities": [{"extern_uid": "cn=jsmith,ou=users"}]},
    "guest user": {"username": "guest", "avatar_url": "https://www.gravatar.com/avatar/456", "identities": [{"extern_uid": "cn=guest,ou=guests"}]},
  }
  fetch = MagicMock(return_value=users)
  monkeypatch.setattr(gitlab, "gitlab_users", fetch)
  host = GitLabHost("https://gitlab.example.com", token="t", user_avatar_url="https://avatars.example.com/{username}.jpg")
  assert host.avatar_url("Jane Doe") == "https://gitlab.example.com/uploads/jdoe.png"
  assert host.avatar_url("John Smith") == "https://avatars.example.com/jsmith.jpg"
  assert host.avatar_url("Guest User") == "https://www.gravatar.com/avatar/456"
  assert host.avatar_url("Nobody", {"email": "nobody@example.com"}).startswith("https://www.gravatar.com/avatar/")
  # once per name (gitlab_users is cached)
  assert host.avatar_url("Jane Doe") == "https://gitlab.example.com/uploads/jdoe.png"
  assert fetch.call_count == 4
  # Without a token we don't call GitLab
  assert GitLabHost("https://gitlab.example.com").avatar_url("Jane Doe") == ""
  # If GitLab is down, we don't retry for every commit
  fetch.side_effect = ConnectionError("down")
  host = GitLabHost("https://gitlab.example.com", token="t")
  assert host.avatar_url("Jane Doe") == ""
  assert host.avatar_url("John Smith") == ""
  assert fetch.call_count == 5


def test_committer_avatar_url(committers, monkeypatch):
  import backend.git_hosts as git_hosts
  monkeypatch.setattr(git_hosts, "git_hosts", hosts_from({}))
  committers.remember([{"name": "The Octocat", "username": "octocat"}], host_url="https://github.com")
  github_project = {"hosting_type": "github", "host": "https://github.com", "web_url": "https://github.com/org/repo"}
  assert git_hosts.committer_avatar_url("The Octocat", github_project) == "https://github.com/octocat.png"
  assert git_hosts.committer_avatar_url("The Octocat", {"hosting_type": "github", "web_url": "https://unknown/org/repo"}) == ""
  assert git_hosts.committer_avatar_url(None, github_project) == ""


# ==========================================
# CI integrations
# ==========================================


class FakeProjects:
  """Stands for the Project model: Project.query.filter(Project.id == id).one_or_none()"""
  def __init__(self, projects=None):
    from types import SimpleNamespace
    self.projects = {id: SimpleNamespace(id=id, id_git="/".join(id.split("/")[:2]), data=data) for id, data in (projects or {}).items()}
    fake = self
    class Column:
      def __eq__(self, value):
        return value
    self.id = Column()
    class Query:
      def filter(self, project_id):
        return SimpleNamespace(one_or_none=lambda: fake.projects.get(project_id))
    self.query = Query()


GITHUB_PROJECT = {
  "git": {"hosting_type": "github", "host": "https://github.com", "path_with_namespace": "org/repo", "web_url": "https://github.com/org/repo"},
  "qatools_config": {"integrations": [
    {"text": "Docs", "href": "https://example.com"},
    {"text": "CI", "sub": [
      {"text": "Benchmark", "githubActions": {"workflow": "bench.yml", "inputs": {"commit": "${commit.id}"}}},
      {"text": "Nightly", "githubActions": {"workflow": "nightly-${branch}.yml", "ref": "main"}},
    ]},
  ]},
}


@pytest.fixture
def integrations(monkeypatch, tmp_path):
  """Loads the real backend/api/integrations.py"""
  import sys
  import types
  import importlib.util
  from pathlib import Path
  monkeypatch.setenv("QABOARD_DATA_DIR", str(tmp_path))
  monkeypatch.setitem(sys.modules, "backend.config", types.SimpleNamespace(qaboard_data_dir=tmp_path))
  path = Path(__file__).parent.parent / "backend" / "api" / "integrations.py"
  spec = importlib.util.spec_from_file_location("backend.api._integrations_under_test", path)
  module = importlib.util.module_from_spec(spec)
  spec.loader.exec_module(module)
  module.git_hosts = hosts_from({"GITHUB_ACCESS_TOKEN": "gh", "GITLAB_HOST": "https://gitlab.example.com"})
  module.time = MagicMock() # no sleeping
  module.Project = FakeProjects({
    "org/repo": GITHUB_PROJECT,
    "org/repo/sub": GITHUB_PROJECT, # subprojects share the repository's git data
    "secret": GITHUB_PROJECT,
    "group/gitlab-repo": {"git": {"path_with_namespace": "group/gitlab-repo", "web_url": "https://gitlab.example.com/group/gitlab-repo"}, "qatools_config": GITHUB_PROJECT["qatools_config"]},
  })
  module.is_authorized_user = lambda user, project: project != "secret"
  return module


def response(status_code=200, json_data=None):
  r = MagicMock(status_code=status_code, ok=status_code < 400, headers={})
  r.json.return_value = json_data
  r.content = json.dumps(json_data).encode()
  return r


def call(integrations, dummy_app, handler, params):
  with dummy_app.test_request_context("/api/v1/github/workflow", method="POST", json=params):
    result = getattr(integrations, handler)()
  return result if isinstance(result, tuple) else (result, result.status_code)


RUN = {"id": 42, "status": "completed", "conclusion": "success", "html_url": "https://github.com/org/repo/actions/runs/42", "name": "Benchmark"}

def test_workflow_run_status(integrations):
  status = lambda **run: integrations.workflow_run_status({**RUN, **run})["status"]
  assert integrations.workflow_run_status(None) == {"status": "manual"}
  assert integrations.workflow_run_status(RUN)["web_url"] == RUN["html_url"]
  assert status() == "success"
  assert status(conclusion="failure") == "failed"
  assert status(conclusion="timed_out") == "failed"
  assert status(conclusion="cancelled") == "canceled"
  assert status(conclusion="skipped") == "skipped"
  assert status(status="in_progress", conclusion=None) == "running"
  assert status(status="queued", conclusion=None) == "pending"


def test_matches_template(integrations):
  matches = integrations.matches_template
  assert matches("bench.yml", "bench.yml")
  assert not matches("bench.yml", "deploy.yml")
  assert matches("${commit.id}", "abc")
  assert matches("nightly-${project}.yml", "nightly-org/repo.yml")
  assert not matches("nightly-${project}.yml", "deploy.yml")
  assert not matches("a${x}b${y}c", "ac")
  assert matches("a${x}b${y}c", "abc")
  assert matches(12345, "12345") and matches("12345", 12345)
  assert not matches("x", None) and not matches("${x", "x")
  # linear, whatever qaboard.yaml says
  import time
  start = time.monotonic()
  assert not matches("${a}x" * 5000 + "y", "x" * 100_000)
  assert time.monotonic() - start < 2


def test_github_workflow_status(integrations, dummy_app, monkeypatch):
  github = integrations.git_hosts.find("github.com")
  api = MagicMock(return_value=response(json_data={"workflow_runs": [RUN]}))
  monkeypatch.setattr(github, "api", api)
  params = {"project": "org/repo/sub", "host": "https://github.com", "repo": "org/repo", "workflow": "bench.yml", "commit_id": "abc"}
  data = call(integrations, dummy_app, "github_workflow_run", params)[0].get_json()
  assert data["status"] == "success" and data["id"] == 42
  api.assert_called_once_with("GET", "/repos/org/repo/actions/workflows/bench.yml/runs", params={"head_sha": "abc", "per_page": 1})

  # The run we started, that we didn't find yet: on its branch, not by commit
  api.reset_mock()
  data = call(integrations, dummy_app, "github_workflow_run", {**params, "ref": "main", "dispatched_at": "2026-10-06T12:00:00Z"})[0].get_json()
  assert data["id"] == 42
  api.assert_called_once_with("GET", "/repos/org/repo/actions/workflows/bench.yml/runs", params={"event": "workflow_dispatch", "branch": "main", "created": ">=2026-10-06T12:00:00Z", "per_page": 1})
  api.reset_mock(return_value=True)
  api.return_value = response(json_data={"workflow_runs": []})
  data = call(integrations, dummy_app, "github_workflow_run", {**params, "ref": "main", "dispatched_at": "2026-10-06T12:00:00Z"})[0].get_json()
  assert data == {"status": "pending", "dispatched_at": "2026-10-06T12:00:00Z"}
  assert call(integrations, dummy_app, "github_workflow_run", {**params, "ref": "main", "dispatched_at": "2026-10-06&x=1"})[1] == 400
  api.reset_mock()

  # Tokens are not sent to unknown hosts, and users only see the workflows of the projects they can access
  for bad in [
    {"host": "https://attacker.example.com"}, {"repo": "../../user"}, {"repo": "other/repo"}, {"project": None},
    {"project": "unknown"}, {"project": "secret"}, {"project": "group/gitlab-repo", "repo": "group/gitlab-repo"},
    {"workflow": "deploy.yml"}, {"workflow": "../../../user/repos"},
  ]:
    assert call(integrations, dummy_app, "github_workflow_run", {**params, **bad})[1] in (400, 403, 404), bad
  api.assert_not_called()


def test_github_workflow_dispatch(integrations, dummy_app, monkeypatch):
  github = integrations.git_hosts.find("github.com")
  api = MagicMock(side_effect=[response(204), response(json_data={"workflow_runs": []}), response(json_data={"workflow_runs": [{**RUN, "status": "queued", "conclusion": None}]})])
  monkeypatch.setattr(github, "api", api)
  params = {"project": "org/repo", "host": "https://github.com", "repo": "org/repo", "workflow": "bench.yml", "ref": "feature", "inputs": {"commit": "abc"}}
  data = call(integrations, dummy_app, "github_workflow_dispatch", params)[0].get_json()
  assert data["status"] == "pending" and data["id"] == 42
  method, path = api.call_args_list[0].args
  assert (method, path) == ("POST", "/repos/org/repo/actions/workflows/bench.yml/dispatches")
  assert api.call_args_list[0].kwargs["json"] == {"ref": "feature", "inputs": {"commit": "abc"}}

  # We didn't find the run: the web app sends us back when it was dispatched
  api.side_effect = None
  api.return_value = response(json_data={"workflow_runs": []})
  data = call(integrations, dummy_app, "github_workflow_dispatch", params)[0].get_json()
  assert data["status"] == "pending" and data["dispatched_at"].endswith("Z")

  # Only the workflows (inputs, refs) of the project's qaboard.yaml, on its repository, for users who can access it
  api.reset_mock()
  nightly = {**params, "workflow": "nightly-main.yml", "inputs": {}, "ref": "main"}
  for bad in [
    {"project": None}, {"project": "secret"}, {"repo": "other/repo"}, {"host": "https://attacker.example.com"},
    {"workflow": "deploy.yml"}, {"workflow": "nightly-x/../../y.yml"}, {"inputs": {"commit": "abc", "other": "x"}}, {"inputs": {}}, {"inputs": "x"},
    {"ref": None},
    {**nightly, "ref": "feature"}, {**nightly, "inputs": {"commit": "abc"}},
  ]:
    assert call(integrations, dummy_app, "github_workflow_dispatch", {**params, **bad})[1] in (400, 403), bad
  api.assert_not_called()
  assert call(integrations, dummy_app, "github_workflow_dispatch", nightly)[1] == 200
  assert api.call_args_list[0].args == ("POST", "/repos/org/repo/actions/workflows/nightly-main.yml/dispatches")


def test_gitlab_jobs(integrations, dummy_app, monkeypatch):
  gitlab = integrations.git_hosts.default
  gitlab.token = "gl"
  jobs = [{"id": 1, "name": "deploy", "status": "success"}, {"id": 3, "name": "deploy", "status": "manual"}, {"id": 2, "name": "test"}]
  api = MagicMock(side_effect=lambda *args, **kwargs: next(responses))
  monkeypatch.setattr(gitlab, "api", api)
  params = {"gitlab_host": "https://gitlab.example.com", "project_id": "group/repo", "commit_id": "abc", "job_name": "deploy"}
  for gitlab_host in ["https://gitlab.example.com", "https://gitlab.com", None]:
    # e.g. data.git.host is not configured anymore: like before hosts were configurable, we use GITLAB_HOST
    responses = iter([response(json_data={"last_pipeline": {"id": 7}}), response(json_data=jobs), response(json_data={"id": 3, "status": "pending"})])
    with dummy_app.test_request_context("/api/v1/gitlab/job/play", method="POST", json={**params, "gitlab_host": gitlab_host}):
      content, status = integrations.gitlab_play_manual_job()
    assert status == 200
    assert api.call_args_list[-1].args == ("POST", "/projects/group%2Frepo/jobs/3/play")
  # The token only goes to the configured host
  assert gitlab.url == "https://gitlab.example.com"
  github = integrations.git_hosts.find("github.com")
  monkeypatch.setattr(github, "api", MagicMock())
  with dummy_app.test_request_context("/api/v1/gitlab/job/play", method="POST", json={**params, "gitlab_host": "https://github.com"}):
    integrations.gitlab_play_manual_job()
  github.api.assert_not_called()
