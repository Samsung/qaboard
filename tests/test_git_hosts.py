"""
Tests for qaboard/git_hosts.py: finding the project's git host, commit statuses, CI results.
"""
import os
import sys
import json
import tempfile
import unittest
import subprocess
from pathlib import Path
from unittest.mock import patch, MagicMock


class TestGitHosts(unittest.TestCase):
  def setUp(self):
    import qaboard.git_hosts as git_hosts
    self.git_hosts = git_hosts
    self.settings = {}
    patcher = patch.object(git_hosts, 'site_config', lambda key, default=None: self.settings.get(key, default))
    patcher.start()
    self.addCleanup(patcher.stop)
    git_hosts.git_host.cache_clear()
    self.addCleanup(git_hosts.git_host.cache_clear)

  def detect(self, env, project=None):
    with patch.object(self.git_hosts, 'root_qatools_config', {"project": project or {"name": "group/repo", "url": "git@gitlab-srv:group/repo.git"}}):
      return self.git_hosts.detect_git_host(env)

  def test_urls(self):
    hostname_of, repo_path_of = self.git_hosts.hostname_of, self.git_hosts.repo_path_of
    self.assertEqual(hostname_of("git@github.com:org/repo.git"), "github.com")
    self.assertEqual(hostname_of("https://GitLab.example.com:8080/a/b"), "gitlab.example.com")
    self.assertEqual(repo_path_of("git@github.com:org/repo.git"), "org/repo")
    self.assertEqual(repo_path_of("https://gitlab.example.com:8080/a/b/c.git"), "a/b/c")
    self.assertEqual(repo_path_of("ssh://git@host:22/a/b"), "a/b")
    self.assertEqual(repo_path_of("git@gitlab-srv:8080:svt/x"), "svt/x")

  def test_configured_hosts(self):
    hosts = [{"type": "github", "url": "https://github.example.com"}]
    # a JSON string in the environment, or a list from a site package or a YAML secrets file
    for value in (json.dumps(hosts), hosts):
      self.settings = {"QABOARD_GIT_HOSTS": value}
      self.assertEqual(self.git_hosts.configured_hosts(), hosts)
    for value in ("[not json", {"type": "github"}, 5):
      self.settings = {"QABOARD_GIT_HOSTS": value}
      self.assertEqual(self.git_hosts.configured_hosts(), [])

  def test_github_actions(self):
    self.settings = {"GITLAB_HOST": "http://gitlab-srv", "GITLAB_ACCESS_TOKEN": "gitlab-token"}
    host = self.detect({
      "GITHUB_ACTIONS": "true", "GITHUB_SERVER_URL": "https://github.example.com", "GITHUB_API_URL": "https://github.example.com/api/v3",
      "GITHUB_REPOSITORY": "org/repo", "GITHUB_TOKEN": "gh-token",
    })
    self.assertEqual((host.type, host.url, host.api_url, host.repo, host.token), ("github", "https://github.example.com", "https://github.example.com/api/v3", "org/repo", "gh-token"))
    # GITHUB_TOKEN is not set by default
    self.settings["GITHUB_ACCESS_TOKEN"] = "pat"
    host = self.detect({"GITHUB_ACTIONS": "true", "GITHUB_REPOSITORY": "org/repo"})
    self.assertEqual((host.api_url, host.token), ("https://api.github.com", "pat"))

  def test_gitlab_ci(self):
    self.settings = {"GITLAB_ACCESS_TOKEN": "gitlab-token"}
    host = self.detect({"GITLAB_CI": "true", "CI_SERVER_URL": "https://gitlab.example.com", "CI_PROJECT_PATH": "group/repo"})
    self.assertEqual((host.type, host.api_url, host.repo, host.token), ("gitlab", "https://gitlab.example.com/api/v4", "group/repo", "gitlab-token"))
    # GITLAB_HOST wins, like before
    self.settings["GITLAB_HOST"] = "http://gitlab-srv"
    host = self.detect({"GITLAB_CI": "true", "CI_SERVER_URL": "https://gitlab.example.com"})
    self.assertEqual(host.api_url, "http://gitlab-srv/api/v4")

  def test_other_ci(self):
    # Like before, GITLAB_HOST by default
    self.settings = {"GITLAB_HOST": "http://gitlab-srv", "GITLAB_ACCESS_TOKEN": "gitlab-token", "GITHUB_ACCESS_TOKEN": "gh-token"}
    host = self.detect({"GIT_COMMIT": "abc"})
    self.assertEqual((host.type, host.api_url, host.repo, host.token), ("gitlab", "http://gitlab-srv/api/v4", "group/repo", "gitlab-token"))
    host = self.detect({}, project={"name": "my-name", "url": "git@github.com:org/repo.git"})
    self.assertEqual((host.type, host.api_url, host.repo, host.token), ("github", "https://api.github.com", "org/repo", "gh-token"))
    # Configured hosts
    self.settings["QABOARD_GIT_HOSTS"] = json.dumps([
      {"type": "github", "url": "https://code.example.com", "token_env": "MY_TOKEN"},
      {"type": "gitea", "url": "https://codeberg.org"},
    ])
    self.settings["MY_TOKEN"] = "my-token"
    host = self.detect({}, project={"name": "x", "url": "git@code.example.com:org/repo.git"})
    self.assertEqual((host.type, host.api_url, host.token), ("github", "https://code.example.com/api/v3", "my-token"))
    self.assertIsNone(self.detect({}, project={"name": "x", "url": "https://codeberg.org/org/repo"}))

  def test_github_token_only_goes_to_known_github_hosts(self):
    self.settings = {"GITHUB_ACCESS_TOKEN": "gh-token", "QABOARD_GITHUB_HOSTS": "github.corp.example.com"}
    detect = lambda url: self.detect({}, project={"name": "x", "url": url})
    self.assertEqual(detect("git@github.com:org/repo.git").token, "gh-token")
    self.assertEqual(detect("https://github.corp.example.com/org/repo").token, "gh-token")
    for url in ["https://github.attacker.example.com/org/repo", "git@evil-github.example.com:org/repo.git", "https://notgithub.com/org/repo"]:
      host = detect(url)
      self.assertEqual((host.type, host.token), ("github", None), url)
    # Hosts configured in QABOARD_GIT_HOSTS
    self.settings["QABOARD_GIT_HOSTS"] = json.dumps([{"type": "github", "url": "https://github-ent.example.com"}])
    self.assertEqual(detect("https://github-ent.example.com/org/repo").token, "gh-token")

  def test_tokens_are_not_sent_to_other_hosts_when_redirected(self):
    import requests
    client = self.git_hosts.GitLab("https://gitlab.example.com", "https://gitlab.example.com/api/v4", "group/repo", "token")
    session = self.git_hosts.credentials_stay_on_host("https://gitlab.example.com/api/v4/x", client.headers())
    def redirected(url):
      prepared = requests.Request('GET', url, headers={**client.headers(), "Authorization": "Bearer t", "Cookie": "a=b", "Accept": "x"}).prepare()
      response = MagicMock(request=requests.Request('GET', "https://gitlab.example.com/api/v4/x").prepare())
      session.rebuild_auth(prepared, response)
      return set(prepared.headers)
    self.assertEqual(redirected("https://other.example.com/x"), {"Accept"})
    self.assertTrue({"Private-Token", "Authorization", "Cookie"} <= redirected("https://gitlab.example.com/api/v4/y"))

  def test_github_statuses(self):
    client = self.git_hosts.GitHub("https://github.com", "https://api.github.com", "org/repo", "token")
    responses = {
      "/repos/org/repo/commits/abc/status": {"statuses": [{"context": "QA", "state": "success"}, {"context": "lint", "state": "error"}]},
      "/repos/org/repo/commits/abc/check-runs": {"check_runs": [
        {"name": "build", "status": "completed", "conclusion": "success"},
        {"name": "docs", "status": "completed", "conclusion": "skipped"},
        {"name": "test", "status": "in_progress", "conclusion": None},
        {"name": "e2e", "status": "completed", "conclusion": "cancelled"},
      ]},
    }
    with patch.object(client, 'request', lambda method, path, **kwargs: MagicMock(json=lambda: responses[path])):
      statuses = {s['name']: s['status'] for s in client.statuses("abc")}
    self.assertEqual(statuses, {"QA": "success", "lint": "failed", "build": "success", "docs": "skipped", "test": "running", "e2e": "canceled"})

  def test_update_status(self):
    import requests
    github = self.git_hosts.GitHub("https://github.com", "https://api.github.com", "org/repo", "token")
    gitlab = self.git_hosts.GitLab("https://gitlab.com", "https://gitlab.com/api/v4", "group/sub/repo", "token")
    with patch.object(requests.Session, 'request') as request:
      github.update_status("abc", "failed", "QA", "https://qa/x", "3 results")
      gitlab.update_status("abc", "success", "QA", "https://qa/x", "3 results")
    (method, url), kwargs = request.call_args_list[0]
    self.assertEqual((method, url), ("POST", "https://api.github.com/repos/org/repo/statuses/abc"))
    self.assertEqual(kwargs["json"], {"state": "failure", "context": "QA", "target_url": "https://qa/x", "description": "3 results"})
    self.assertEqual(kwargs["headers"]["Authorization"], "Bearer token")
    (method, url), kwargs = request.call_args_list[1]
    self.assertEqual((method, url), ("POST", "https://gitlab.com/api/v4/projects/group%2Fsub%2Frepo/statuses/abc"))
    self.assertEqual(kwargs["params"]["state"], "success")
    self.assertEqual(kwargs["headers"], {"Private-Token": "token"})

  def test_lastest_successful_ci_commit(self):
    client = MagicMock(token="token")
    with patch.object(self.git_hosts, 'git_host', lambda: client), patch.object(self.git_hosts, 'time') as time:
      client.statuses.return_value = [{"name": "build", "status": "success"}, {"name": "docs", "status": "skipped"}]
      self.assertEqual(self.git_hosts.lastest_successful_ci_commit("abc"), "abc")
      client.statuses.side_effect = [[{"name": "build", "status": "running"}], [{"name": "build", "status": "success"}]]
      self.assertEqual(self.git_hosts.lastest_successful_ci_commit("abc"), "abc")
      time.sleep.assert_called_once()
    # Without a token we don't wait
    with patch.object(self.git_hosts, 'git_host', lambda: None):
      self.assertEqual(self.git_hosts.lastest_successful_ci_commit("abc"), "abc")

  def test_gitlab_shim(self):
    import qaboard.gitlab
    for name in ("gitlab_token", "update_gitlab_status", "lastest_successful_ci_commit", "ci_commit_statuses", "check_gitlab_token"):
      self.assertTrue(hasattr(qaboard.gitlab, name))



class TestCiEnvironment(unittest.TestCase):
  """What commit and branch `qa` sees in CI"""
  def setUp(self):
    tmp = tempfile.TemporaryDirectory()
    self.addCleanup(tmp.cleanup)
    self.dir = Path(tmp.name)
    (self.dir / 'qaboard.yaml').write_text(f"project:\n  name: org/repo\n  url: git@github.com:org/repo.git\nstorage: {self.dir}\n")

  def ci(self, env):
    clean_env = {k: v for k, v in os.environ.items() if not k.startswith(('GITHUB_', 'CI', 'GITLAB', 'GIT_'))}
    out = subprocess.run(
      [sys.executable, '-c', 'import json; from qaboard.config import commit_id, commit_branch, commit_tag; print(json.dumps([commit_id, commit_branch, commit_tag]))'],
      cwd=self.dir, env={**clean_env, "CI": "true", **env}, capture_output=True, encoding='utf-8', check=True,
    )
    return json.loads(out.stdout.strip().splitlines()[-1])

  def test_github_actions_push(self):
    env = {"GITHUB_ACTIONS": "true", "GITHUB_SHA": "abc", "GITHUB_REF": "refs/heads/feature/x", "GITHUB_REF_NAME": "feature/x", "GITHUB_HEAD_REF": "", "GITHUB_EVENT_NAME": "push"}
    self.assertEqual(self.ci(env), ["abc", "feature/x", None])

  def test_github_actions_tag(self):
    env = {"GITHUB_ACTIONS": "true", "GITHUB_SHA": "abc", "GITHUB_REF": "refs/tags/v1.0", "GITHUB_REF_NAME": "v1.0", "GITHUB_REF_TYPE": "tag", "GITHUB_HEAD_REF": ""}
    self.assertEqual(self.ci(env), ["abc", "v1.0", "v1.0"])

  def test_github_actions_pull_request(self):
    event = self.dir / 'event.json'
    event.write_text(json.dumps({"pull_request": {"head": {"sha": "head-sha"}}}))
    env = {
      "GITHUB_ACTIONS": "true", "GITHUB_SHA": "merge-sha", "GITHUB_REF": "refs/pull/3/merge", "GITHUB_REF_NAME": "3/merge",
      "GITHUB_HEAD_REF": "feature/x", "GITHUB_EVENT_NAME": "pull_request", "GITHUB_EVENT_PATH": str(event),
    }
    self.assertEqual(self.ci(env), ["head-sha", "feature/x", None])

  def test_gitlab_ci(self):
    env = {"GITLAB_CI": "true", "CI_COMMIT_SHA": "abc", "CI_COMMIT_REF_NAME": "main"}
    self.assertEqual(self.ci(env), ["abc", "main", None])


if __name__ == '__main__':
  unittest.main()
