"""
Backend API for the integrations features.
"""
import os
import re
import time
import json
from urllib.parse import urlparse

from flask import request, jsonify, make_response
import requests
from requests import Request, Session
from requests.utils import quote
from requests.auth import HTTPBasicAuth

from backend import app
from ..config import qaboard_data_dir

# We love our proxies
import urllib3
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)



# TODO: Currently all users/projects share gitlab/jenkins credentials.
#       Longer-term, we should use a centralized per user/project secret store




def gitlab_session_cookie(hostname, user, password, user_type="user"):
    """
    There is not way to get a session cookie via the gitlab API, but we need them....
    Beware this function is likely fragile and may break with future gitlab updates.
    user_type: can be "user" for gitlab default users, or ldap_user with LDAP. There are likely other valid options...
    """
    # https://stackoverflow.com/questions/47948887/login-to-gitlab-with-username-and-password-using-curl
    with requests.Session() as s:
        s = requests.Session()
        # curl for the login page to get a session cookie and the sources with the auth tokens
        r = s.get(f'{hostname}/users/sign_in')
        matches = re.findall(r'<form.* id="new_([a-z_]+)" .* action="([^"]+)" .* name="authenticity_token" value="([^"]+)"', r.text)
        print(matches)
        matches = [m for m in matches if m[0] == user_type]
        try:
            user_type, action, authenticity_token = matches[0]
        except:
            print(r.text)
            print(f"Error with the gitlab login form. {matches}")
        login_url = f"{hostname}{action}"
        # print(user_type, login_url, user, password, authenticity_token)
        r = s.post(
            login_url,
            data={
                "username": user,
                "password": password,
                "authenticity_token": authenticity_token,
            },
        )
        print(r)
        # print(r.text)
        # print(r.headers)
        return s.cookies['_gitlab_session']


gitlab_credentials = json.loads(os.environ.get('GITLAB_AUTH', '{}'))
# At startup we try to get session cookies for the gitlab hosts we have auth for.
# We use them to proxy e.g. image requests. 
# They we will be cached in 
gitlab_cookies_path = qaboard_data_dir / "gitlab_cookies.json"
try: # file not found, corrupt format...
  with gitlab_cookies_path.open() as f:
    gitlab_cookies = json.load(f)
except:
  gitlab_cookies = {}
refresh_cookies = False
for hostname, auth in gitlab_credentials.items():
  if hostname in gitlab_cookies and not refresh_cookies:
    continue
  print("Getting gitlab cookie for", hostname)
  url = f"https://{hostname}" if not auth.get('http') else f"http://{hostname}"
  gitlab_cookies[hostname] = gitlab_session_cookie(
    url, auth['user'], auth['password'], auth.get('type', 'user')
  )
  # write updates
  with gitlab_cookies_path.open('w') as f:
    json.dump(gitlab_cookies, f)


jenkins_credentials = json.loads(os.environ.get('JENKINS_AUTH', '{}'))
def jenkins_hostname_credentials(build_url):
  hostname = urlparse(build_url).hostname
  if hostname not in jenkins_credentials:
    return None
  credentials = jenkins_credentials[hostname]
  return {
    "auth": HTTPBasicAuth(
      credentials['user'],
      credentials['token'],
    ),
    "headers": {
      "Jenkins-Crumb": credentials['crumb'],
    },
  }

# TODO: get password for gitlab-adm to avoid any auth and password changes
# TODO: if expired, renew the token...
@app.route("/api/v1/gitlab/proxy")
def proxy_gitlab():
  url = request.args['url']
  hostname = urlparse(url).hostname
  if hostname in gitlab_cookies:
    cookies = {'_gitlab_session': gitlab_cookies[hostname]}
  else:
    cookies = {}
  # print(url)
  r = requests.get(url, cookies=cookies)
  session = Session()
  resp = make_response(r.content, r.status_code)
  for k, v in r.headers.items():
    resp.headers.set(k, v)
  return resp
  # print(r)
  # print(r.text)
  # print(r.headers)
  return r.content, r.status_code

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
    jobs = []
    page = 1
    total_pages = None
    def get_jobs(page, per_page):
      r = requests.get(
        f"{gitlab_api}/projects/{project_id}/pipelines/{pipeline_id}/jobs",
        params={
          "page": page,
          "per_page": per_page,
        },
        headers=gitlab_headers,
      )
      total_pages = int(r.headers['X-Total-Pages']) if r.headers.get('X-Total-Pages') else 0
      return r.json(), total_pages
    while total_pages is None or page <= total_pages:
      jobs_page, total_pages = get_jobs(page=page, per_page=50)
      jobs.extend(jobs_page)
      page += 1

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
  jobs = []
  page = 1
  total_pages = None
  def get_jobs(page, per_page):
    r = requests.get(
      f"{gitlab_api}/projects/{project_id}/pipelines/{pipeline_id}/jobs",
      params={
        "page": page,
        "per_page": per_page,
      },
      headers=gitlab_headers,
    )
    total_pages = int(r.headers['X-Total-Pages']) if r.headers.get('X-Total-Pages') else 0
    return r.json(), total_pages
  while total_pages is None or page <= total_pages:
    jobs_page, total_pages = get_jobs(page=page, per_page=50)
    jobs.extend(jobs_page)
    page += 1


  try:
      matching_jobs = [j for j in jobs if data['job_name'] == j['name']]
      assert matching_jobs
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
  data = request.get_json()
  if "build_url" in data:
    url = f"{data['build_url']}/api/json"
  elif "web_url" in data:
    url = f"{data['web_url']}/api/json"
  else:
    url = data['url']
  jenkins_credentials = jenkins_hostname_credentials(url)
  if not jenkins_credentials:
    return f"ERROR: No credentials for {url}", "403"
  try:
    # https://docs.python-requests.org/en/master/user/advanced/#timeouts
    r = requests.get(url, timeout=(60, 3.5*60), **jenkins_credentials)
  except Exception as e:
    print(e)
    return jsonify({"error": f"ERROR: checking the build status: {e}"}), 500
  try:
    build_data = r.json()
  except Exception as e:
    print(r.text)
    print(e)
    return jsonify({"error": f"ERROR: malformed Jenkins response, when checking the build status: {e}", "text": r.text}), 500
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
  if 'build_url' not in data:
      return jsonify({"error": f"ERROR: the integration is missing `build_url` (in your qaboard.yaml)"}), 400
  jenkins_credentials = jenkins_hostname_credentials(data['build_url'])
  if not jenkins_credentials:
    return f"ERROR: No credentials for {data['build_url']}", "403"
  build_url = re.sub("/$", "", data['build_url'])
  build_trigger_url = f"{build_url}/buildWithParameters"
  try:
    params = {
      "cause": data.get('cause', "Triggered via QA-Board"),
      **data.get('params'),
    }
    if "token" in data:
      params["token"] = data["token"]
    else:
      params["token"] = "qaboard" # FIXME: default to not setting it in the OSS version
    r_build = requests.post(
      build_trigger_url,
      params=params,
      **jenkins_credentials,
    )
  except Exception as e:
      print(build_trigger_url)
      print(e)
      return jsonify({"error": f"ERROR: When triggering job: {e}"}), 500

  if 'location' not in r_build.headers:
      return jsonify({"error": f"ERROR: the jenkins response is missing a `location` header. {r_build.text}"}), 500
  build_queue_location = f"{r_build.headers['location']}/api/json"

  def ensure_absolute(url):
    # in some cases jenkins will return a relative location
    if '://' not in build_queue_location:
      url_info = urlparse(build_url)
      if not build_queue_location.startswith('/'):
        url = f"/{build_queue_location}" 
      url = f"{url_info.scheme}://{url_info.netloc}{url}"
    return url

  build_queue_location = ensure_absolute(build_queue_location)
  time.sleep(5) # jenkins' "quiet period"
  sleep_total = 5
  error = None
  web_url = None
  while not web_url and sleep_total < 30:
    try:
      r_get = requests.get(
        build_queue_location,
        **jenkins_credentials,
      )
      r_get.raise_for_status()
      error = None
    except Exception as e:
      error = str(e)
    try:
      web_url = r_get.json()['executable']['url']
    except Exception as e:
      print(r_get.json())
      print(f"INFO: When reading build queue info, no build URL given at: {build_queue_location}. {e}")
    time.sleep(0.5)
    sleep_total = sleep_total + 0.5
  if error:
    return jsonify({"error": error}), 500
  response = {
    "status": 'pending',
    **r_get.json(),
  }
  if 'url' not in response:
    response['url'] = build_queue_location
  response['url'] = ensure_absolute(response['url'])
  if r_get.json().get('executable', {}).get('url'):
    response['web_url'] = ensure_absolute(r_get.json()['executable']['url'])
  return jsonify(response)
