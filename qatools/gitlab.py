import os

import requests

from requests.utils import quote
from .config import config, root_qatools_config, subproject, commit_branch

gitlab_api = "http://gitlab-srv/api/v4"
gitlab_headers = {'Private-Token': os.environ.get('GITLAB_ACCESS_TOKEN', 'd5sbmEPvncmsgTcgZLoS')}
gitlab_project_id = quote(root_qatools_config['project']['name'], safe='')



def ci_commit_data(commit):
  url = f"{gitlab_api}/projects/{gitlab_project_id}/repository/commits/{commit.hexsha}"
  r = requests.get(url, headers=gitlab_headers)
  return r.json()

def ci_commit_statuses(commit, **kwargs):
  url = f"{gitlab_api}/projects/{gitlab_project_id}/repository/commits/{commit.hexsha}/statuses"
  r = requests.get(url, headers=gitlab_headers, params=kwargs)
  return r.json()



def update_gitlab_status(commit, state='success'):
  url = f"{gitlab_api}/projects/{gitlab_project_id}/statuses/{commit.hexsha}"
  params = {
    "state": state,
    "name": f"QA {subproject.name if subproject else ''}",
    "target_url": f"https://qa/{config['project']['name']}/commit/{commit.hexsha}",
    "description": "CI results",
    # "ref": commit_branch,
  }
  try:
    r = requests.post(url, headers=gitlab_headers, params=params)
    # print(r.json())
  except Exception as e:
    print(r)
    print(url)
    print(e)
    pass