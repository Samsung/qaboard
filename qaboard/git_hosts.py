"""
Talks to the project's git host (GitLab, GitHub...) from the CI:
- `qa batch` sets a commit status with a link to the results,
- `qa check-bit-accuracy` can wait for the CI of the reference commit (see `lastest_successful_ci_commit`).

We find the host from the CI's environment (GitHub Actions, GitLab CI), else from qaboard.yaml's project.url,
using QABOARD_GIT_HOSTS like the server does: a JSON list of {type, url, token or token_env, api_url, hostnames},
or the path to a JSON/YAML file with the list, or a list (e.g. from YAML secrets or a site package).
We only use the github and gitlab hosts.
Tokens: GITHUB_TOKEN (GitHub Actions doesn't set it in the environment: workflows map it from secrets.GITHUB_TOKEN)
or GITHUB_ACCESS_TOKEN, GITLAB_ACCESS_TOKEN, or the hosts' `token`.
Like settings, they can come from the environment, the secrets files (QA_SECRETS, ~/.qaboard/secrets.yaml) or the site package.
"""
import os
import re
import json
import time
from functools import lru_cache
from typing import Optional, List, Dict
from urllib.parse import quote, urlparse

import click

from .site_config import site_config
from .config import config, root_qatools_config, subproject, commit_branch, commit_id


class GitHostClient:
  """The API of a git host, for one repository."""
  type = 'generic'

  def __init__(self, url: str, api_url: str, repo: str, token: Optional[str]):
    self.url = url.rstrip('/')
    self.api_url = api_url.rstrip('/')
    self.repo = repo # e.g. group/repo
    self.token = token

  def __repr__(self):
    return f"<{self.__class__.__name__} {self.url}/{self.repo}>"

  def headers(self) -> Dict[str, str]:
    return {}

  def request(self, method, path, **kwargs):
    url = f"{self.api_url}{path}"
    with credentials_stay_on_host(url, self.headers()) as session:
      r = session.request(method, url, headers=self.headers(), timeout=60, **kwargs)
    r.raise_for_status()
    return r

  def update_status(self, commit_id: str, state: str, name: str, target_url: str, description: str):
    raise NotImplementedError

  def statuses(self, commit_id: str, ref: Optional[str] = None) -> List[Dict]:
    """The CI jobs of a commit, as [{name, status, allow_failure}] with GitLab's statuses: success, failed, canceled, running..."""
    raise NotImplementedError


def credentials_stay_on_host(url, headers):
  """
  A requests session that follows redirects, but doesn't send our token to another host.
  requests only removes the Authorization header, not e.g. GitLab's Private-Token.
  """
  import requests
  class Session(requests.Session):
    def rebuild_auth(self, prepared_request, response):
      super().rebuild_auth(prepared_request, response)
      if self.should_strip_auth(url, prepared_request.url):
        for header in {'Authorization', 'Private-Token', 'Cookie', *headers}:
          prepared_request.headers.pop(header, None)
  return Session()


class GitLab(GitHostClient):
  type = 'gitlab'

  def headers(self):
    return {'Private-Token': self.token} if self.token else {}

  @property
  def project_id(self):
    return quote(self.repo, safe='')

  def update_status(self, commit_id, state, name, target_url, description):
    # https://docs.gitlab.com/ee/api/commits.html#set-the-pipeline-status-of-a-commit
    self.request('POST', f"/projects/{self.project_id}/statuses/{commit_id}", params={
      "state": state,
      "name": name,
      "target_url": target_url,
      "description": description,
    })

  def statuses(self, commit_id, ref=None):
    # https://docs.gitlab.com/ee/api/commits.html#list-the-statuses-of-a-commit
    params = {"per_page": 100, **({"ref": ref} if ref else {})}
    return self.request('GET', f"/projects/{self.project_id}/repository/commits/{commit_id}/statuses", params=params).json()


class GitHub(GitHostClient):
  type = 'github'

  def headers(self):
    return {
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      **({"Authorization": f"Bearer {self.token}"} if self.token else {}),
    }

  def update_status(self, commit_id, state, name, target_url, description):
    # https://docs.github.com/en/rest/commits/statuses#create-a-commit-status
    github_state = {'success': 'success', 'failed': 'failure', 'canceled': 'error'}.get(state, 'pending')
    self.request('POST', f"/repos/{self.repo}/statuses/{commit_id}", json={
      "state": github_state,
      "context": name,
      "target_url": target_url,
      "description": description[:140],
    })

  def statuses(self, commit_id, ref=None):
    # GitHub has commit statuses (like the one `qa batch` sets) and check runs (e.g. GitHub Actions jobs)
    # https://docs.github.com/en/rest/commits/statuses#get-the-combined-status-for-a-specific-reference
    combined = self.request('GET', f"/repos/{self.repo}/commits/{commit_id}/status", params={"per_page": 100}).json()
    statuses = [
      {"name": s['context'], "status": {'success': 'success', 'pending': 'pending'}.get(s['state'], 'failed')}
      for s in combined.get('statuses', [])
    ]
    # https://docs.github.com/en/rest/checks/runs#list-check-runs-for-a-git-reference
    check_runs = self.request('GET', f"/repos/{self.repo}/commits/{commit_id}/check-runs", params={"per_page": 100}).json()
    for run in check_runs.get('check_runs', []):
      statuses.append({"name": run['name'], "status": check_run_status(run)})
    return statuses


def check_run_status(run):
  if run['status'] != 'completed':
    return 'running' if run['status'] == 'in_progress' else 'pending'
  conclusion = run.get('conclusion')
  if conclusion in ('success', 'neutral', 'skipped'):
    return 'success' if conclusion == 'success' else 'skipped'
  if conclusion in ('cancelled', 'stale'):
    return 'canceled'
  return 'failed' # failure, timed_out, action_required...


CLIENTS = {'gitlab': GitLab, 'github': GitHub}


def hostname_of(url: Optional[str]) -> Optional[str]:
  """https://host:8080/a/b => host, git@host:a/b.git => host"""
  if not url:
    return None
  if '://' in url:
    return (urlparse(url).hostname or '').lower() or None
  match = re.match(r'(?:[^@/\s]+@)?([^:/@\s]+)', url)
  return match.group(1).lower() if match else None

def repo_path_of(url: Optional[str]) -> Optional[str]:
  """https://host/a/b.git => a/b, git@host:a/b.git => a/b"""
  if not url:
    return None
  path = urlparse(url).path if '://' in url else re.sub(r'^(?:[^@/\s]+@)?[^:/@\s]+(:[0-9]+)?[:/]', '', url)
  return re.sub(r'\.git$', '', path.strip('/')) or None


def configured_hosts() -> List[Dict]:
  value = site_config('QABOARD_GIT_HOSTS')
  if not value:
    return []
  try:
    if isinstance(value, list): # e.g. from a site package, or a YAML secrets file
      hosts = value
    elif value.strip().startswith('['):
      hosts = json.loads(value)
    else:
      import yaml
      with open(os.path.expanduser(value.strip())) as f:
        hosts = yaml.safe_load(f) or []
  except (OSError, ValueError, AttributeError) as e:
    click.secho(f"WARNING: Could not read QABOARD_GIT_HOSTS: {e}", fg='yellow', err=True)
    return []
  return [h for h in hosts if isinstance(h, dict) and h.get('url')] if isinstance(hosts, list) else []


def host_token(host: Dict) -> Optional[str]:
  if host.get('token'):
    return host['token']
  if host.get('token_env'):
    return site_config(host['token_env'])
  return None


def default_api_url(type, url):
  if type == 'github':
    return 'https://api.github.com' if hostname_of(url) == 'github.com' else f"{url}/api/v3"
  return f"{url}/api/v4"


def detect_git_host(env=None) -> Optional[GitHostClient]:
  """The git host of the project, from the CI's environment or from qaboard.yaml's project.url"""
  env = os.environ if env is None else env
  project = root_qatools_config.get('project', {})
  project_url = project.get('url')
  hosts = configured_hosts()
  find = lambda url: next((h for h in hosts if hostname_of(h['url']) == hostname_of(url) or hostname_of(url) in (h.get('hostnames') or [])), None)

  if env.get('GITHUB_ACTIONS') == 'true':
    url = env.get('GITHUB_SERVER_URL', 'https://github.com')
    host = find(url) or {}
    return GitHub(
      url=url,
      api_url=env.get('GITHUB_API_URL') or host.get('api_url') or default_api_url('github', url),
      repo=env.get('GITHUB_REPOSITORY') or repo_path_of(project_url) or project.get('name'),
      token=env.get('GITHUB_TOKEN') or site_config('GITHUB_ACCESS_TOKEN') or host_token(host),
    )

  if env.get('GITLAB_CI') == 'true':
    # GITLAB_HOST wins over CI_SERVER_URL, like before: it may be an internal URL that works better.
    url = site_config('GITLAB_HOST') or env.get('CI_SERVER_URL') or 'https://gitlab.com'
    host = find(url) or {}
    return GitLab(
      url=url,
      api_url=host.get('api_url') or default_api_url('gitlab', url),
      repo=project.get('name') or env.get('CI_PROJECT_PATH'),
      token=site_config('GITLAB_ACCESS_TOKEN') or host_token(host),
    )

  # Other CIs (e.g. Jenkins)
  host = (find(project_url) if project_url else None) or {}
  hostname = hostname_of(project_url) or ''
  # GITHUB_ACCESS_TOKEN is only sent to the GitHub hosts we know about, not to any hostname that looks like one
  github_hostnames = {'github.com', *[hostname_of(h.strip()) for h in str(site_config('QABOARD_GITHUB_HOSTS', '') or '').split(',') if h.strip()]}
  trusted = True
  if host:
    type, url = host.get('type'), host['url'].rstrip('/')
  elif hostname in github_hostnames:
    type, url = 'github', f"https://{hostname}"
  elif 'github' in hostname:
    click.secho(f"WARNING: we don't send GITHUB_ACCESS_TOKEN to {hostname}. Add it to QABOARD_GITHUB_HOSTS or QABOARD_GIT_HOSTS.", fg='yellow', err=True)
    type, url, trusted = 'github', f"https://{hostname}", False
  else:
    # Before hosts were configurable, we assumed GITLAB_HOST
    type, url = 'gitlab', site_config('GITLAB_HOST', 'https://gitlab.com')
  if type not in CLIENTS:
    return None # e.g. Gitea: we don't support its API yet
  token_variable = {'gitlab': 'GITLAB_ACCESS_TOKEN', 'github': 'GITHUB_ACCESS_TOKEN'}[type]
  return CLIENTS[type](
    url=url,
    api_url=host.get('api_url') or default_api_url(type, url),
    repo=(repo_path_of(project_url) if type == 'github' else None) or project.get('name'),
    token=host_token(host) or (site_config(token_variable) if trusted else None),
  )


@lru_cache()
def git_host() -> Optional[GitHostClient]:
  try:
    return detect_git_host()
  except Exception as e:
    click.secho(f"WARNING: Could not find the project's git host: {e}", fg='yellow', err=True)
    return None


def check_token(host: Optional[GitHostClient]):
  if host and not host.token:
    variable = 'GITHUB_TOKEN' if host.type == 'github' else 'GITLAB_ACCESS_TOKEN'
    click.secho(f"WARNING: {variable} is not defined, we can't use the {host.type} API.", fg='yellow', bold=True, err=True)
  return host and host.token


def update_ci_status(state, name, target_url, description, commit_id=commit_id):
  """Sets a commit status, e.g. state='success' or 'failed' (GitLab's names), with a link to the results."""
  host = git_host()
  if not check_token(host):
    return
  for attempt in range(3):
    try:
      host.update_status(commit_id, state, name, target_url, description)
      return
    except Exception as e:
      if attempt < 2:
        time.sleep(3)
      else:
        click.secho(f"WARNING: Could not set the commit status on {host}: {e}", fg='yellow', err=True)


def lastest_successful_ci_commit(commit_id: str, max_parents_depth=config.get('bit_accuracy', {}).get('max_parents_depth', 5)):
  """
  If the CI of the commit failed, or is not over, we wait or return its first parent.
  bit_accuracy.failed_ci_job_name in qaboard.yaml: only look at this job.
  bit_accuracy.on_reference_failed_ci: compare-first-parent
  """
  host = git_host()
  if not host or not host.token:
    return commit_id

  from .git import git_parents
  if max_parents_depth < 0:
    click.secho('Could not find a commit that passed CI', fg='red', bold=True, err=True)
    exit(1)

  job_name = config.get('bit_accuracy', {}).get('failed_ci_job_name')
  if job_name and subproject.name:
    job_name = f"{job_name} {subproject.name}"

  wait_time = 15 # seconds
  while True:
    try:
      statuses = host.statuses(commit_id, ref=commit_branch)
    except Exception as e:
      click.secho(f'WARNING: Could not get the CI status from {host}: {e}. You may need a different token.', fg='yellow', err=True)
      return commit_id
    if job_name:
      statuses = [s for s in statuses if s['name'] == job_name]

    commit_failed = any(s['status'] in ['failed', 'canceled'] and not s.get('allow_failure', False) for s in statuses)
    if commit_failed:
      click.secho(f"WARNING: {commit_id[:8]} failed the CI pipeline. (statuses: {set(s['status'] for s in statuses)})", fg='yellow', bold=True, err=True)
      if config.get('bit_accuracy', {}).get('on_reference_failed_ci') == 'compare-first-parent':
        click.secho("We now try to compare against its first parent.", fg='yellow', err=True)
        return lastest_successful_ci_commit(git_parents(commit_id)[0], max_parents_depth=max_parents_depth - 1)
      else:
        return commit_id

    commit_success = all(s['status'] in ('success', 'skipped') or s.get('allow_failure', False) for s in statuses)
    if commit_success:
      return commit_id

    click.secho(f"The CI pipeline for {commit_id[:8]} is not over yet (statuses: {set(s['status'] for s in statuses)}). Retrying in {wait_time}s", fg='yellow', dim=True, err=True)
    time.sleep(wait_time)
