import os
from pathlib import Path

import requests
import click

from urllib.parse import quote
from .config import config, root_qatools_config, subproject, commit_branch
from .config import secrets

# TODO: read root_qatools_config['project']['url']
#       handle git@ and http:// schemes...
# TODO: don't put credentials here...
gitlab_host = os.getenv('GITLAB_HOST', secrets.get('GITLAB_HOST', 'https://gitlab.com'))
gitlab_token = os.environ.get('GITLAB_ACCESS_TOKEN', secrets.get('GITLAB_ACCESS_TOKEN'))
gitlab_headers = {
  'Private-Token': gitlab_token,
}
gitlab_api = f"{gitlab_host}/api/v4"
gitlab_project_id = quote(root_qatools_config['project']['name'], safe='')


def check_gitlab_token():
  if not gitlab_token:
    click.secho("WARNING: GITLAB_ACCESS_TOKEN is not defined.", fg='yellow', bold=True, err=True)
    click.secho("         Please provide it as an environment variable: https://docs.gitlab.com/ee/user/profile/personal_access_tokens.html", fg='yellow', err=True)


def ci_commit_data(commit_id):
  check_gitlab_token()
  url = f"{gitlab_api}/projects/{gitlab_project_id}/repository/commits/{commit_id}"
  r = requests.get(url, headers=gitlab_headers)
  r.raise_for_status()
  return r.json()

def ci_commit_statuses(commit_id, **kwargs):
  check_gitlab_token()
  url = f"{gitlab_api}/projects/{gitlab_project_id}/repository/commits/{commit_id}/statuses"
  r = requests.get(url, headers=gitlab_headers, params=kwargs)
  r.raise_for_status()
  return r.json()



def update_gitlab_status(commit_id, state, label, description):
  check_gitlab_token()
  url = f"{gitlab_api}/projects/{gitlab_project_id}/statuses/{commit_id}"
  name = f"QA {subproject.name}" if subproject else 'QA'
  target_url = f"https://qa/{config['project']['name']}/commit/{commit_id}"
  if label != "default":
    name += f" | {label}"
    target_url += f"?batch={label}"
  params = {
    "state": state,
    "name": name,
    "target_url": target_url,
    "description": description,
    # "ref": commit_branch,
  }
  try:
    r = requests.post(url, headers=gitlab_headers, params=params)
    r.raise_for_status()
    # print(r.json())
  except Exception as e:
    print(r)
    print(url)
    print(e)
    pass





def lastest_successful_ci_commit(commit_id: str, max_parents_depth=config.get('bit_accuracy', {}).get('max_parents_depth', 5)):
  if not gitlab_token:
    return commit_id

  from .git import git_parents
  if max_parents_depth < 0:
    click.secho(f'Could not find a commit that passed CI', fg='red', bold=True, err=True)
    exit(1)

  failed_ci_job_name = config.get('bit_accuracy', {}).get('failed_ci_job_name')
  if failed_ci_job_name and subproject:
    failed_ci_job_name = f"{failed_ci_job_name} {subproject.name}",


  wait_time = 15 # seconds
  while True:
    statuses = ci_commit_statuses(commit_id, ref=commit_branch, name=failed_ci_job_name)
    # print(statuses)

    if statuses is None:
      click.secho(f'WARNING: Could not get the CI status. You may need a different GITLAB_ACCESS_TOKEN.', fg='yellow', err=True)
      return commit_id

    if failed_ci_job_name:
      # print('filtering')
      statuses = [s for s in statuses if s['name'] == f"{subproject.name} {failed_ci_job_name}"]
      # print(statuses)

    commit_failed = any(s['status'] in ['failed', 'canceled'] and not s.get('allow_failure', False) for s in statuses)
    if commit_failed:
      click.secho(f"WARNING: {commit_id[:8]} failed the CI pipeline. (statuses: {set(s['status'] for s in statuses)})", fg='yellow', bold=True, err=True)
      if config.get('bit_accuracy', {}).get('on_reference_failed_ci') == 'compare-first-parent':
        click.secho(f"We now try to compare against its first parent.", fg='yellow', err=True)
        return lastest_successful_ci_commit(git_parents(commit_id)[0], max_parents_depth=1)
      else:
        return commit_id

    commit_success = all(s['status'] == 'success' or s.get('allow_failure', False) for s in statuses)
    if commit_success:
      return commit_id

    click.secho(f"The CI pipeline for {commit_id[:8]} is not over yet (statuses: {set(s['status'] for s in statuses)}). Retrying in {wait_time}s", fg='yellow', dim=True, err=True)
    # click.secho(str(statuses), fg='yellow', dim=True, err=True)
    import time
    time.sleep(wait_time)
