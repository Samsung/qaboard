import os
from pathlib import Path

import requests
import click

from requests.utils import quote
from .config import config, root_qatools_config, subproject, commit_branch
from .config import secrets

# TODO: read root_qatools_config['project']['url']
#       handle git@ and http:// schemes...
# TODO: don't put credentials here...
gitlab_host = os.getenv('GITLAB_HOST', secrets.get('GITLAB_HOST', 'https://gitlab.com'))
gitlab_token = os.environ.get('GITLAB_ACCESS_TOKEN', secrets.get('GITLAB_ACCESS_TOKEN'))
if not gitlab_token:
  click.secho("WARNING: GITLAB_ACCESS_TOKEN is not defined.", fg='yellow', bold=True, err=True)
  click.secho("         Please provide it as an environment variable: https://docs.gitlab.com/ee/user/profile/personal_access_tokens.html", fg='yellow', err=True)
gitlab_headers = {
  'Private-Token': gitlab_token,
}
gitlab_api = f"{gitlab_host}/api/v4"
gitlab_project_id = quote(root_qatools_config['project']['name'], safe='')



def ci_commit_data(commit_id):
  url = f"{gitlab_api}/projects/{gitlab_project_id}/repository/commits/{commit_id}"
  r = requests.get(url, headers=gitlab_headers)
  r.raise_for_status()
  return r.json()

def ci_commit_statuses(commit_id, **kwargs):
  url = f"{gitlab_api}/projects/{gitlab_project_id}/repository/commits/{commit_id}/statuses"
  r = requests.get(url, headers=gitlab_headers, params=kwargs)
  r.raise_for_status()
  return r.json()



def update_gitlab_status(commit_id, state='success'):
  url = f"{gitlab_api}/projects/{gitlab_project_id}/statuses/{commit_id}"
  name = f"QA {subproject.name}" if subproject else 'QA'
  params = {
    "state": state,
    "name": name,
    "target_url": f"https://qa/{config['project']['name']}/commit/{commit_id}",
    "description": "CI results",
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
