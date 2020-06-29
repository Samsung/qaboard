"""
Backend API for the integrations features.
"""
import os
import re
import time

from flask import request, jsonify, make_response
import requests
from requests import Request, Session
from requests.utils import quote
from requests.auth import HTTPBasicAuth

from backend import app


# FIXME: Currently we rely on environment variables for the gitlab/jenkins credentials
#        We only allow 1 single instance of each, with a single auth.
# TODO: - Short term, we can at least read from os.environ["QABOARD_SECRETS"]=/etc/qaboard_secrets.json
#         {
#            secrets: [
#              {
#                 "host": "http://jensirc:8080",
#                 "auth": ("user", "token"),
#                 "headers": {"Jenkins-User-Crumb": "xxxxxxx"}
#              },
#              ...
#            ]
#         }
# TODO: - Longer-term, we should use a centralized per user/project secret store

# We love our proxies
import urllib3
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)


@app.route("/api/v1/webhook/proxy", methods=['POST'])
@app.route("/api/v1/webhook/proxy/", methods=['POST'])
def proxy_webook():
  """
  Proxy users' webhook triggers to avoid CORS issues.
  """
  data = request.get_json()
  print(data['method'], data.get('url'))
  data['method'] = data['method'].upper()
  if 'auth' in data:
    # we could easily support other types of authentification
    # https://2.python-requests.org/en/master/user/authentication/
    data['auth'] = HTTPBasicAuth(data['auth']['username'], data['auth']['password'])
  session = Session()
  r = Request(**data)
  r_prepped = r.prepare()
  r = session.send(r_prepped, verify=False)
  # It would be great to just
  #   return r.content, r.status_code
  # but e.g. Jenkins returns important data in its headers
  resp = make_response(r.content, r.status_code)
  # this might not be the cleanest way to pass headers,
  # e.g. what happens to Content-Length?
  for k, v in r.headers.items():
    if k.lower() == 'content-length':
      continue
    resp.headers.set(k, v)
  return resp


@app.route("/api/v1/gitlab/job", methods=['POST'])
@app.route("/api/v1/gitlab/job/", methods=['POST'])
def gitlab_job():
  """
  Get information about a GitlabCI manual job.
  """
  if "GITLAB_ACCESS_TOKEN" not in os.environ:
    return jsonify({"error": f'Error: Missing GITLAB_ACCESS_TOKEN in environment variables'}), 500

  data = request.get_json()
  gitlab_api = f"{data['gitlab_host']}/api/v4"
  gitlab_headers = {
    'Private-Token': os.environ['GITLAB_ACCESS_TOKEN'],
  }
  project_id = quote(data['project_id'], safe='')
  if data.get('job_id'):
    job_id = data['job_id']
  else:
    # Get the latest pipeline for this commit
    url = f"{gitlab_api}/projects/{project_id}/repository/commits/{data['commit_id']}"
    r = requests.get(url, headers=gitlab_headers)
    pipeline_id = r.json()['last_pipeline']['id']
    # Get the list of manual jobs in that pipeline
    # https://docs.gitlab.com/ee/api/jobs.html#list-pipeline-jobs
    url = f"{gitlab_api}/projects/{project_id}/pipelines/{pipeline_id}/jobs"
    r = requests.get(url, headers=gitlab_headers)
    jobs = r.json()
    try:
        matching_jobs = [j for j in jobs if data['job_name'] == j['name']]
        for j in matching_jobs:
          print(j['name'], j['id'], j["created_at"], j['status'])
    except Exception as e:
        return jsonify({"error": f'Only these jobs are available: {jobs}'}), 404
    if not matching_jobs:
        return jsonify({"error": f'Only these jobs are available: {jobs}'}), 404
    # FIXME: sort by id
    job_id = matching_jobs[-1]['id']

  url = f"{gitlab_api}/projects/{project_id}/jobs/{job_id}"
  try:
    r = requests.get(url, headers=gitlab_headers)
    print(r.json())
    return r.content, r.status_code
  except Exception as e:
      return jsonify({"error": f'Error: {e}'}), 500



@app.route("/api/v1/gitlab/job/play", methods=['POST'])
@app.route("/api/v1/gitlab/job/play/", methods=['POST'])
def gitlab_play_manual_job():
  """
  Trigger a GitlabCI manual job.
  """
  if "GITLAB_ACCESS_TOKEN" not in os.environ:
    return jsonify({"error": f'Error: Missing GITLAB_ACCESS_TOKEN in environment variables'}), 500
  data = request.get_json()

  gitlab_api = f"{data['gitlab_host']}/api/v4"
  gitlab_headers = {
    # FIXME: store the credentials in a "secret store", global per user/project 
    'Private-Token': os.environ['GITLAB_ACCESS_TOKEN'],
  }
  project_id = quote(data['project_id'], safe='')

  # Get the latest pipeline for this commit
  url = f"{gitlab_api}/projects/{project_id}/repository/commits/{data['commit_id']}"
  r = requests.get(url, headers=gitlab_headers)
  pipeline_id = r.json()['last_pipeline']['id']

  # Get the list of manual jobs in that pipeline
  # https://docs.gitlab.com/ee/api/jobs.html#list-pipeline-jobs
  url = f"{gitlab_api}/projects/{project_id}/pipelines/{pipeline_id}/jobs"
  r = requests.get(url, headers=gitlab_headers)
  jobs = r.json()
  try:
      matching_jobs = [j for j in jobs if data['job_name'] == j['name']]
      for j in matching_jobs:
        print(j['name'], j['id'], j["created_at"], j['status'])
  except Exception as e:
      return jsonify({"error": f'Only these jobs are available: {jobs}'}), 404

  # Play the job
  # https://docs.gitlab.com/ee/api/jobs.html
  url = f"{gitlab_api}/projects/{project_id}/jobs/{matching_jobs[0]['id']}/play"
  try:
    r = requests.post(url, headers=gitlab_headers)
    print(r.json())
    return r.content, r.status_code
  except Exception as e:
      print(url)
      print(e)
      return jsonify({"error": f"ERROR: when posting to {url}: {e}"}), 500



@app.route("/api/v1/jenkins/build", methods=['POST'])
@app.route("/api/v1/jenkins/build/", methods=['POST'])
def jenkins_build():
  """
  Get the status of a Jenkins build.
  """
  jenkins_credentials = {
    "auth": HTTPBasicAuth(
      os.environ['JENKINS_USER_NAME'],
      os.environ['JENKINS_USER_TOKEN'],
    ),
    "headers": {
      "Jenkins-Crumb": os.environ['JENKINS_USER_CRUMB'],
    }
  }
  data = request.get_json()
  try:
    r = requests.get(
      f"{data['web_url']}/api/json",
      **jenkins_credentials,
    )
  except Exception as e:
    print(e)
    return jsonify({"error": f"ERROR: When reading build info: {e}"}), 500
  build_data = r.json()
  # print(build_data.get('building'), build_data.get('result'))
  # https://javadoc.jenkins-ci.org/hudson/model/Result.html
  allow_failure = False
  if build_data.get('blocked'):
    status = "BLOCKED"
  if build_data.get('stuck'):
    status = "STUCK"
  if build_data['building']:
    status = "running"
  elif build_data.get('result'):
    if build_data['result'] == 'SUCCESS':
      status = "success"
    elif build_data['result'] == 'UNSTABLE':
      allow_failure = True
      status = "UNSTABLE"
    elif build_data['result'] == 'FAILURE':
      status = "failed"
    elif build_data['result'] == 'NOT_BUILT':
      status = "NOT_BUILT"
    elif build_data['result'] == 'ABORTED':
      status = "ABORTED"
    else:
      return jsonify({"error": "ERROR: unknown status"}), 500
  else:
    status = "canceled"
  return jsonify({
    "status": status,
    "allow_failure": allow_failure,
    "web_url": data['web_url'],
  })



@app.route("/api/v1/jenkins/build/trigger", methods=['POST'])
@app.route("/api/v1/jenkins/build/trigger/", methods=['POST'])
def jenkins_build_trigger():
  """
  Trigger a Jenkins build.
  """

  data = request.get_json()
  jenkins_credentials = {
    "auth": HTTPBasicAuth(
      os.environ['JENKINS_USER_NAME'],
      os.environ['JENKINS_USER_TOKEN'],
    ),
    "headers": {
      "Jenkins-Crumb": os.environ['JENKINS_USER_CRUMB'],
    }
  }
  if 'build_url' not in data:
      return jsonify({"error": f"ERROR: the integration is missing `build_url` (in your qaboard.yaml)"}), 400
  build_url = re.sub("/$", "", data['build_url'])
  build_trigger_url = f"{build_url}/buildWithParameters"
  try:
    r = requests.post(
      build_trigger_url,
      params={
        "token": data.get('token', "qatools"),
        "cause": data.get('cause', "Triggered via QA-Board"),
        **data['params'],
      },
      **jenkins_credentials,
    )
  except Exception as e:
      print(build_trigger_url)
      print(e)
      return jsonify({"error": f"ERROR: When triggering job: {e}"}), 500

  
  build_queue_location = f"{r.headers['location']}/api/json"
  time.sleep(5) # jenkins quiet period
  sleep_total = 5
  web_url = None
  while not web_url and sleep_total < 30:
    try:
      r = requests.get(
        build_queue_location,
        **jenkins_credentials,
      )
      web_url = r.json()['executable']['url']
      print(r.json())
    except Exception as e:
      print(e)
      time.sleep(0.5)
      sleep_total = sleep_total + 0.5
  if not web_url:
    return jsonify({"error": f"ERROR: When reading build queue info, no build URL given at: {build_queue_location}"}), 500
  return jsonify({
    "web_url": r.json()['executable']['url'],
    "status": 'pending',
  })
