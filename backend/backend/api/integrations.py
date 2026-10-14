"""
Backend API for the integrations features.
"""
import os
import re
import time
import json
import datetime
from urllib.parse import urlparse, urljoin

from flask import request, jsonify, make_response
import requests
from requests import Request, Session
from requests.utils import quote
from requests.auth import HTTPBasicAuth

from backend import app
from ..config import qaboard_data_dir
from ..git_hosts import git_hosts
from ..git_utils import check_project_path
from ..models import Project
from .auth import login_required, is_authorized_user

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
        login_url = f'{hostname}/users/sign_in'
        r = s.get(login_url)
        # print([l for l in r.text.splitlines() if "ldap_user" in l])
        auth_matches = re.findall(r'<form.* data-testid="new_(ldap_user)" action="([^"]+)" .* name="authenticity_token" value="([^"]+)"', r.text)
        if not auth_matches: # before gitlab 16
          auth_matches = re.findall(r'<form.* id="new_([a-z_]+)" .* action="([^"]+)" .* name="authenticity_token" value="([^"]+)"', r.text)
        if not auth_matches:
          raise ValueError(f"Cannot find Gitlab login form at {login_url}")
        matches = [m for m in auth_matches if m[0] == user_type]
        if not matches and user_type == "ldap_user": # recent gitlab versions?
          matches = [m for m in auth_matches if m[0] == "/users/auth/ldapmain/callback"]
        # print(">> matches", matches)
        try:
            user_type, action, authenticity_token = matches[0]
        except:
            print(r.text)
            print(f"Error with the gitlab login form. {matches}")
            return None
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
  if gitlab_cookies.get(hostname) and not refresh_cookies:
    continue
  print("Getting gitlab cookie for", hostname)
  url = f"https://{hostname}" if not auth.get('http') else f"http://{hostname}"
  gitlab_cookies[hostname] = gitlab_session_cookie(
    url, auth['user'], auth['password'], auth.get('type', 'user')
  )
  # write updates
  with gitlab_cookies_path.open('w') as f:
    json.dump(gitlab_cookies, f)


class IntegrationError(Exception):
  def __init__(self, message, status=500):
    super().__init__(message)
    self.status = status

def api_host(url, type):
  """
  The configured git host at `url`, of this type, to call its API.
  We only send tokens to the hosts they belong to, never to a URL we're given.
  """
  host = git_hosts.find(url, type) if url else git_hosts.of_type(type)
  if not host and type == 'gitlab':
    # e.g. the project's data.git.host is not configured anymore. Like before hosts were configurable,
    # GitLab projects are on GITLAB_HOST: the token still only goes to a configured host.
    host = git_hosts.of_type('gitlab')
  if not host:
    raise IntegrationError(f"Unknown {type} host: {url}. Add it to QABOARD_GIT_HOSTS.", 403)
  if not host.token:
    raise IntegrationError(f"Missing a token for {host.url}: set it in QABOARD_GIT_HOSTS (or GITLAB_ACCESS_TOKEN / GITHUB_ACCESS_TOKEN)", 500)
  return host

def integration_error(e):
  return jsonify({"error": str(e)}), getattr(e, 'status', 500)


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

def git_hosts_proxied_hostnames():
  """The configured git hosts, their API and where their users' avatars are"""
  for host in [*git_hosts, git_hosts.default]:
    if not host:
      continue
    yield from host.hostnames
    for url in [host.api_url, (host.user_avatar_url or '').replace('{url}', host.url)]:
      hostname = urlparse(url).hostname if url else None
      if hostname and '{' not in hostname:
        yield hostname

# The web app loads git hosts' avatars and badges through this proxy, that adds our gitlab session cookie.
# So that users can't make the server fetch other URLs (e.g. internal services), it only fetches from:
proxy_hosts = {urlparse(f"//{h.strip()}").hostname for h in [
  *git_hosts_proxied_hostnames(),
  *gitlab_credentials.keys(),
  # avatars of committers without an avatar on their git host (see git_hosts/base.py)
  "gravatar.com", "www.gravatar.com", "secure.gravatar.com", "avatars.githubusercontent.com",
  *os.environ.get('QABOARD_PROXY_HOSTS', '').split(','),
] if h and h.strip()}
# Headers we pass back: e.g. not Set-Cookie, or Content-Encoding since r.content is decoded
proxy_response_headers = ['Content-Type', 'Cache-Control', 'Expires', 'ETag', 'Last-Modified']

def is_proxy_allowed(url):
  parsed = urlparse(url)
  return parsed.scheme in ('http', 'https') and parsed.hostname in proxy_hosts


# TODO: get password for gitlab-adm to avoid any auth and password changes
# TODO: if expired, renew the token...
@app.route("/api/v1/git/proxy")
@app.route("/api/v1/gitlab/proxy") # backward compatibility
@login_required
def proxy_gitlab():
  """
  Proxies images (avatars, CI badges...), with a session on GitLab hosts that have GITLAB_AUTH credentials.
  """
  url = request.args['url']
  for _ in range(5):
    if not is_proxy_allowed(url):
      print(f"[gitlab-proxy] Refused {url}")
      return jsonify({"error": "This host is not allowed. Admins can add it to QABOARD_PROXY_HOSTS."}), 403
    hostname = urlparse(url).hostname
    if gitlab_cookies.get(hostname):
      cookies = {'_gitlab_session': gitlab_cookies[hostname]}
    else:
      cookies = {}
    # We follow redirects ourselves to check where they go
    r = requests.get(url, cookies=cookies, verify=False, allow_redirects=False, timeout=10)
    if not r.is_redirect:
      break
    url = urljoin(url, r.headers['Location'])
  else:
    return jsonify({"error": "Too many redirects"}), 502
  resp = make_response(r.content, r.status_code)
  for k in proxy_response_headers:
    if k in r.headers:
      resp.headers.set(k, r.headers[k])
  # The content is served from our domain: don't let e.g. an SVG or HTML page run scripts
  resp.headers.set('Content-Security-Policy', "default-src 'none'; img-src data:; style-src 'unsafe-inline'; sandbox")
  resp.headers.set('X-Content-Type-Options', 'nosniff')
  return resp

@app.route("/api/v1/webhook/proxy", methods=['POST'])
@app.route("/api/v1/webhook/proxy/", methods=['POST'])
@login_required
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


# ==========================================
# GitLab CI: manual jobs
# ==========================================
# qaboard.yaml: integrations: [{text: "My job", gitlabCI: {job_name: "my-job"}}]
# The web app sends {gitlab_host, project_id, commit_id, job_name, job_id?}

def gitlab_pipeline_jobs(host, project_id, commit_id):
  """The jobs in the latest pipeline of a commit."""
  r = host.api('GET', f"/projects/{project_id}/repository/commits/{quote(str(commit_id), safe='')}")
  r.raise_for_status()
  pipeline = r.json().get('last_pipeline')
  if not pipeline:
    raise IntegrationError(f"No pipeline for {commit_id}", 404)
  # https://docs.gitlab.com/ee/api/jobs.html#list-pipeline-jobs
  jobs, page = [], 1
  while True:
    r = host.api('GET', f"/projects/{project_id}/pipelines/{pipeline['id']}/jobs", params={"page": page, "per_page": 50})
    r.raise_for_status()
    jobs.extend(r.json())
    if page >= int(r.headers.get('X-Total-Pages') or 0):
      return jobs
    page += 1

def gitlab_job_named(host, project_id, commit_id, job_name):
  jobs = gitlab_pipeline_jobs(host, project_id, commit_id)
  matching_jobs = [j for j in jobs if j['name'] == job_name]
  if not matching_jobs:
    raise IntegrationError(f"Only these jobs are available: {[j['name'] for j in jobs]}", 404)
  # the latest, if the job was retried
  return max(matching_jobs, key=lambda j: j['id'])


@app.route("/api/v1/gitlab/job", methods=['POST'])
@app.route("/api/v1/gitlab/job/", methods=['POST'])
def gitlab_job():
  """
  Get information about a GitlabCI manual job.
  """
  data = request.get_json()
  try:
    host = api_host(data.get('gitlab_host'), 'gitlab')
    project_id = quote(data['project_id'], safe='')
    if data.get('job_id'):
      job_id = data['job_id']
    else:
      job_id = gitlab_job_named(host, project_id, data['commit_id'], data['job_name'])['id']
    r = host.api('GET', f"/projects/{project_id}/jobs/{quote(str(job_id), safe='')}")
    return r.content, r.status_code
  except IntegrationError as e:
    return integration_error(e)
  except Exception as e:
    return jsonify({"error": f'Error: {e}'}), 500


@app.route("/api/v1/gitlab/job/play", methods=['POST'])
@app.route("/api/v1/gitlab/job/play/", methods=['POST'])
@login_required
def gitlab_play_manual_job():
  """
  Trigger a GitlabCI manual job.
  """
  data = request.get_json()
  try:
    host = api_host(data.get('gitlab_host'), 'gitlab')
    project_id = quote(data['project_id'], safe='')
    job = gitlab_job_named(host, project_id, data['commit_id'], data['job_name'])
    # https://docs.gitlab.com/ee/api/jobs.html#run-a-job
    r = host.api('POST', f"/projects/{project_id}/jobs/{job['id']}/play")
    return r.content, r.status_code
  except IntegrationError as e:
    return integration_error(e)
  except Exception as e:
    print(e)
    return jsonify({"error": f"ERROR: when playing the job: {e}"}), 500



# ==========================================
# GitHub Actions: workflow runs
# ==========================================
# qaboard.yaml: integrations: [{text: "Benchmark", githubActions: {workflow: "benchmark.yml", inputs: {...}}}]
# The web app sends {project, host, repo, commit_id, workflow, run_id?, ref?, dispatched_at?} to get the status,
# and {project, host, repo, workflow, ref, inputs} to start it.
# We use the server's token: users can only see and start the workflows of the projects they can access,
# on the project's repository, that the project's qaboard.yaml lists.

def github_workflow(data, dispatch=False):
  project_id = data.get('project')
  if not isinstance(project_id, str) or not project_id:
    raise IntegrationError("Missing `project`", 400)
  if not is_authorized_user(None, project_id):
    raise IntegrationError("Forbidden: You don't have permission to access this project", 403)
  project = Project.query.filter(Project.id == project_id).one_or_none()
  if not project:
    raise IntegrationError(f"Unknown project: {project_id}", 404)
  project_data = project.data or {}
  git = project_data.get('git') or {}
  config = project_data.get('qatools_config') or {}
  repo = git.get('path_with_namespace') or project.id_git
  if data.get('repo') != repo:
    raise IntegrationError(f"The repository of {project_id} is {repo}", 403)
  check_project_path(repo) # e.g. org/repo
  try:
    host = git_hosts.for_repo(git, (config.get('project') or {}).get('url'))
  except ValueError as e:
    raise IntegrationError(str(e), 403)
  if host.type != 'github' or (data.get('host') and not host.matches(data['host'])):
    raise IntegrationError(f"The repository of {project_id} is on {host.url}", 403)
  if not host.token:
    raise IntegrationError(f"Missing a token for {host.url}: set it in QABOARD_GIT_HOSTS (or GITHUB_ACCESS_TOKEN)", 500)
  workflow = data.get('workflow')
  if isinstance(workflow, int) and not isinstance(workflow, bool):
    workflow = str(workflow) # workflow ids
  declared =[i for i in iter_integrations(config.get('integrations')) if isinstance(i.get('githubActions'), dict)]
  matching = [i['githubActions'] for i in declared if isinstance(workflow, str) and '/' not in workflow and matches_template(i['githubActions'].get('workflow'), workflow)]
  if not matching:
    raise IntegrationError(f"The qaboard.yaml of {project_id} has no githubActions integration with workflow {workflow!r}", 403)
  if dispatch:
    inputs = data.get('inputs') or {}
    allowed = lambda i: inputs_match(i.get('inputs') or {}, inputs) and ('ref' not in i or matches_template(i['ref'], data.get('ref')))
    if not isinstance(inputs, dict) or not any(allowed(i) for i in matching):
      raise IntegrationError(f"The inputs or ref don't match the githubActions integrations of {project_id}", 403)
  return host, repo, quote(workflow, safe='')


def iter_integrations(integrations):
  """All the integrations in qaboard.yaml, also in sub-menus"""
  for integration in integrations if isinstance(integrations, list) else []:
    if isinstance(integration, dict):
      yield integration
      yield from iter_integrations(integration.get('sub'))


def matches_template(template, value):
  """
  Is `value` what the web app could make from `template`, e.g. "bench-${project.name}.yml"?
  ${...} parts match anything. (No regular expressions: templates come from qaboard.yaml)
  """
  number = lambda x: isinstance(x, (int, float)) and not isinstance(x, bool)
  if number(template) and isinstance(value, str) or isinstance(template, str) and number(value):
    return str(template) == str(value) # e.g. workflow ids
  if not isinstance(template, str) or not isinstance(value, str):
    return template == value
  literals, rest = [], template
  while '${' in rest:
    before, _, after = rest.partition('${')
    literals.append(before)
    _, closing, rest = after.partition('}')
    if not closing:
      return False
  if not literals:
    return template == value
  literals.append(rest)
  first, *middle, last = literals
  if len(value) < len(first) + len(last) or not value.startswith(first) or not value.endswith(last):
    return False
  position, end = len(first), len(value) - len(last)
  for literal in middle:
    position = value.find(literal, position, end)
    if position < 0:
      return False
    position += len(literal)
  return True


def inputs_match(declared, inputs):
  if not isinstance(declared, dict):
    return False
  return set(inputs) == set(declared) and all(matches_template(declared[k], v) for k, v in inputs.items())

def workflow_run_status(run):
  """A GitHub Actions run, with a status like GitLab's (that the web app knows)"""
  if not run:
    return {"status": "manual"} # no run yet
  if run['status'] == 'completed':
    status = {
      'success': 'success',
      'cancelled': 'canceled',
      'skipped': 'skipped',
      'neutral': 'skipped',
      'action_required': 'manual',
    }.get(run.get('conclusion'), 'failed') # failure, timed_out, startup_failure, stale...
  else:
    status = 'running' if run['status'] == 'in_progress' else 'pending' # queued, waiting, requested...
  return {
    "id": run['id'],
    "status": status,
    "web_url": run.get('html_url'),
    "name": run.get('display_title') or run.get('name'),
    "conclusion": run.get('conclusion'),
    "created_at": run.get('created_at'),
    "updated_at": run.get('updated_at'),
  }


def dispatched_run(host, repo, workflow, ref, dispatched_at):
  """
  The latest run started by a dispatch on this ref since `dispatched_at`, e.g. 2026-10-06T12:00:00Z.
  If someone else started the workflow on the same ref at the same time, it can be theirs.
  """
  if not isinstance(dispatched_at, str) or not re.fullmatch(r'\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ', dispatched_at):
    raise IntegrationError(f"Invalid dispatched_at: {dispatched_at!r}", 400)
  r = host.api('GET', f"/repos/{repo}/actions/workflows/{workflow}/runs", params={
    "event": "workflow_dispatch",
    "branch": ref,
    "created": f">={dispatched_at}",
    "per_page": 1,
  })
  runs = r.json().get('workflow_runs') if r.ok else None
  return runs[0] if runs else None


@app.route("/api/v1/github/workflow", methods=['POST'])
@app.route("/api/v1/github/workflow/", methods=['POST'])
def github_workflow_run():
  """
  The status of the latest run of a GitHub Actions workflow for a commit.
  """
  data = request.get_json()
  try:
    host, repo, workflow = github_workflow(data)
    if data.get('run_id'):
      r = host.api('GET', f"/repos/{repo}/actions/runs/{quote(str(data['run_id']), safe='')}")
      r.raise_for_status()
      run = r.json()
    elif data.get('dispatched_at') and data.get('ref'):
      # We started it, but didn't find it yet: on the branch's latest commit, maybe not this one
      run = dispatched_run(host, repo, workflow, data['ref'], data['dispatched_at'])
      if not run:
        return jsonify({"status": "pending", "dispatched_at": data['dispatched_at']})
    else:
      # https://docs.github.com/en/rest/actions/workflow-runs#list-workflow-runs-for-a-workflow
      r = host.api('GET', f"/repos/{repo}/actions/workflows/{workflow}/runs", params={"head_sha": data['commit_id'], "per_page": 1})
      r.raise_for_status()
      runs = r.json()['workflow_runs']
      run = runs[0] if runs else None
    return jsonify(workflow_run_status(run))
  except IntegrationError as e:
    return integration_error(e)
  except Exception as e:
    return jsonify({"error": f'Error: {e}'}), 500


@app.route("/api/v1/github/workflow/dispatch", methods=['POST'])
@app.route("/api/v1/github/workflow/dispatch/", methods=['POST'])
@login_required
def github_workflow_dispatch():
  """
  Starts a GitHub Actions workflow (it needs a `workflow_dispatch` trigger) on a branch or tag.
  """
  data = request.get_json()
  try:
    host, repo, workflow = github_workflow(data, dispatch=True)
    if not isinstance(data.get('ref'), str) or not data['ref']:
      raise IntegrationError("Missing `ref`: the branch or tag to run the workflow on", 400)
    dispatched_at = f"{datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(seconds=10):%Y-%m-%dT%H:%M:%SZ}"
    # https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event
    r = host.api('POST', f"/repos/{repo}/actions/workflows/{workflow}/dispatches", json={
      "ref": data['ref'],
      "inputs": data.get('inputs') or {},
    })
    if not r.ok:
      return r.content, r.status_code
    # GitHub doesn't tell us which run it started: we look for it for a few seconds
    for _ in range(8):
      time.sleep(1.5)
      run = dispatched_run(host, repo, workflow, data['ref'], dispatched_at)
      if run:
        return jsonify(workflow_run_status(run))
    # The web app sends it back when it asks for the status, and we look again
    return jsonify({"status": "pending", "dispatched_at": dispatched_at})
  except IntegrationError as e:
    return integration_error(e)
  except Exception as e:
    print(e)
    return jsonify({"error": f"ERROR: when starting the workflow: {e}"}), 500


@app.route("/api/v1/jenkins/build", methods=['POST'])
@app.route("/api/v1/jenkins/build/", methods=['POST'])
def jenkins_build():
  """
  Get the status of a Jenkins build.
  """
  data = request.get_json()
  if "build_url" in data or "web_url" in data:
    if "build_url" in data:
      url = data['build_url']
    else:
      url = data['web_url']
    if not url.endswith("/api/json"):
      url += "/api/json"
  else:
    url = data['url']
  jenkins_credentials = jenkins_hostname_credentials(url)
  if not jenkins_credentials:
    return f"ERROR: No credentials for {url}", "403"
  try:
    # TODO: add something proper to do retriess
    # https://urllib3.readthedocs.io/en/latest/reference/urllib3.util.html#urllib3.util.Retry
    # from requests.adapters import Retry, HTTPAdapter
    # s = requests.Session()
    # retries = Retry(total=5, backoff_factor=1, status_forcelist=[ 502, 503, 504 ])
    # s.mount('http://', HTTPAdapter(max_retries=retries))
    # s.get("http://httpstat.us/503")

    # @retry(tries=3) # pip install retry...
    def fetch():
      # https://docs.python-requests.org/en/master/user/advanced/#timeouts
      return requests.get(url, timeout=(60, 3.5*60), **jenkins_credentials)
    # LOL Jenkins is super unstable... WIP until we add something proper...
    import time
    try:
      r = fetch()
    except:
      try:
        time.sleep(1)
        r = fetch()
      except:
        try:
          time.sleep(1)
          r = fetch()
        except:
          try:
            time.sleep(1)
            r = fetch()
          except:
            r = fetch()
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
    "web_url": url,
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
  build_queue_location = f"{r_build.headers['location']}/api/json".replace("//api/json", "/api/json")

  def ensure_absolute(url):
    # in some cases jenkins will return a relative location
    if '://' not in url:
      url_info = urlparse(build_url)
      if not url.startswith('/'):
        url = f"/{url}" 
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
      print(f"INFO: When reading build queue info, no build URL given at: {build_queue_location}. {e}")
      try:
        print(r_get.json())
      except Exception as ee:
        print(f"WARNING: could not print the response: {ee}")
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
  try:
    if r_get.json().get('executable', {}).get('url'):
      response['web_url'] = ensure_absolute(r_get.json()['executable']['url'])
  except Exception:
    pass
  return jsonify(response)
