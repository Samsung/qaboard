"""
Deprecated: use qaboard.git_hosts, that also works with GitHub.
Kept for scripts that import it.
"""
from urllib.parse import quote

from .site_config import site_config
from .config import root_qatools_config, commit_id
from .git_hosts import GitLab, check_token, update_ci_status, lastest_successful_ci_commit


gitlab_host = site_config('GITLAB_HOST', 'https://gitlab.com')
gitlab_token = site_config('GITLAB_ACCESS_TOKEN')
gitlab_headers = {
  'Private-Token': gitlab_token,
}
gitlab_api = f"{gitlab_host}/api/v4"
gitlab_project_id = quote(root_qatools_config.get('project', {}).get('name', ''), safe='')

def _gitlab():
  return GitLab(gitlab_host, gitlab_api, root_qatools_config.get('project', {}).get('name', ''), gitlab_token)


def check_gitlab_token():
  return check_token(_gitlab())

def ci_commit_data(commit_id):
  return _gitlab().request('GET', f"/projects/{gitlab_project_id}/repository/commits/{commit_id}").json()

def ci_commit_statuses(commit_id, **kwargs):
  return _gitlab().request('GET', f"/projects/{gitlab_project_id}/repository/commits/{commit_id}/statuses", params=kwargs).json()

def update_gitlab_status(state, name, target_url, description, commit_id=commit_id):
  return update_ci_status(state, name, target_url, description, commit_id=commit_id)


__all__ = [
  'gitlab_host', 'gitlab_token', 'gitlab_headers', 'gitlab_api', 'gitlab_project_id',
  'check_gitlab_token', 'ci_commit_data', 'ci_commit_statuses', 'update_gitlab_status', 'lastest_successful_ci_commit',
]
