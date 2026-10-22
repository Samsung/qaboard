"""
Backend API for the integrations features.
"""
import os
import re
import html
import time
import json
import datetime
from urllib.parse import urlparse, urljoin

from flask import request, jsonify, make_response, g
import requests
from requests import Request, Session
from requests.utils import quote
from requests.auth import HTTPBasicAuth

from backend import app, db_session
from ..config import qaboard_data_dir
from ..git_hosts import git_hosts
from ..git_utils import check_project_path
from ..models import Project, CiCommit
from ..settings import setting
from ..audit import audit
from .auth import login_required, require_project_access
from ..access import can

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
        # curl for the login page to get a session cookie and the sources with the auth tokens
        login_url = f'{hostname}/users/sign_in'
        r = s.get(login_url, timeout=10)
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
            print(f"Error with the gitlab login form at {login_url}: no {user_type} form. {[m[0] for m in auth_matches]}")
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
            timeout=10,
        )
        print(f"[gitlab-proxy] Signed in to {hostname}: {r.status_code}")
        return s.cookies.get('_gitlab_session')


gitlab_credentials = json.loads(os.environ.get('GITLAB_AUTH', '{}'))
# Session cookies for the gitlab hosts we have auth for, to proxy e.g. image requests.
# We sign in when we first need them (not at startup: a slow GitLab would delay every worker),
# and cache them for all the workers in:
gitlab_cookies_path = qaboard_data_dir / "gitlab_cookies.json"
try: # file not found, corrupt format...
  with gitlab_cookies_path.open() as f:
    gitlab_cookies = json.load(f)
except:
  gitlab_cookies = {}
# hostname => when signing in failed: we try again after a while, not on every image
gitlab_cookie_failures = {}
GITLAB_COOKIE_RETRY_SECONDS = 600

def gitlab_cookie(hostname):
  """The session cookie for a GitLab host with GITLAB_AUTH credentials, None for other hosts or if we can't sign in"""
  if gitlab_cookies.get(hostname) or hostname not in gitlab_credentials:
    return gitlab_cookies.get(hostname)
  if time.time() - gitlab_cookie_failures.get(hostname, 0) < GITLAB_COOKIE_RETRY_SECONDS:
    return None
  auth = gitlab_credentials[hostname]
  print("[gitlab-proxy] Getting gitlab cookie for", hostname)
  url = f"https://{hostname}" if not auth.get('http') else f"http://{hostname}"
  try:
    cookie = gitlab_session_cookie(url, auth['user'], auth['password'], auth.get('type', 'user'))
  except Exception as e:
    print(f"[gitlab-proxy] WARNING: could not sign in to {hostname}: {type(e).__name__}: {e}")
    cookie = None
  if not cookie:
    gitlab_cookie_failures[hostname] = time.time()
    return None
  gitlab_cookies[hostname] = cookie
  try:
    with gitlab_cookies_path.open('w') as f:
      json.dump(gitlab_cookies, f)
  except OSError as e:
    print(f"[gitlab-proxy] WARNING: could not save the cookies in {gitlab_cookies_path}: {e}")
  return cookie


class IntegrationError(Exception):
  def __init__(self, message, status=500):
    super().__init__(message)
    self.status = status

def integration_error(e):
  return jsonify({"error": str(e)}), getattr(e, 'status', 500)



jenkins_credentials = json.loads(os.environ.get('JENKINS_AUTH', '{}'))
# The token of "Trigger builds remotely" sent to jobs whose integration doesn't give one
jenkins_build_token = os.environ.get('JENKINS_BUILD_TOKEN')
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

def jenkins_same_host(url, build_url):
  """
  Jenkins gives the URLs of builds with its configured root URL, whose hostname can be another name than
  the one in build_url (e.g. a FQDN vs a short name). We'd have no credentials for it to check the build status,
  so we use build_url's scheme and host.
  """
  if urlparse(url).hostname in jenkins_credentials:
    return url
  base = urlparse(build_url)
  return urlparse(url)._replace(scheme=base.scheme, netloc=base.netloc).geturl()

def jenkins_job_is_parameterized(build_url, jenkins_credentials):
  """True unless Jenkins says the job has no parameters"""
  try:
    r = requests.get(f"{build_url}/api/json", params={"tree": "property[parameterDefinitions[name]]"}, timeout=30, **jenkins_credentials)
    r.raise_for_status()
    return any(p.get('parameterDefinitions') for p in r.json().get('property', []))
  except Exception as e:
    print(f"WARNING: could not check if {build_url} has parameters: {e}")
    return True

def jenkins_error(r, url):
  """Explains a Jenkins error response, whose body is usually a whole HTML page"""
  hints = {
    401: "check the user and token in JENKINS_AUTH",
    403: "check the user and token in JENKINS_AUTH, and that the user can build the job",
    404: "check build_url, jobs in folders look like http://jenkins/job/folder/job/name",
    409: "is the job disabled?",
  }
  text = re.sub(r"<(script|style)\b.*?</\1>", " ", r.text or '', flags=re.S | re.I)
  text = re.sub(r"\s+", " ", html.unescape(re.sub(r"<[^>]+>", " ", text))).strip()
  message = f"HTTP {r.status_code} from POST {url}"
  if r.status_code in hints:
    message += f" ({hints[r.status_code]})"
  if 300 <= r.status_code < 400:
    message += f", redirected to {r.headers.get('location')}"
  if text:
    message += f": {text[:1000]}"
  return message

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
    cookie = gitlab_cookie(urlparse(url).hostname)
    cookies = {'_gitlab_session': cookie} if cookie else {}
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

# ==========================================
# Webhooks and links of qaboard.yaml's integrations
# ==========================================
# The web app sends the webhooks users click, and checks that links answer (HEAD), through the server: no CORS issues,
# and it reaches hosts users can't. So that users can't make the server call anything (e.g. internal services),
# it only calls the hosts that qaboard.yaml's integrations list (the project's, the commit's and its batches'),
# the git hosts, the Jenkins hosts and QABOARD_PROXY_HOSTS, also after redirects.

# requests.request's arguments the web app can give, from qaboard.yaml's `webhook`
WEBHOOK_FIELDS = {'method', 'url', 'params', 'data', 'json', 'headers', 'auth'}
WEBHOOK_METHODS = {'GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'}
HOP_BY_HOP_HEADERS = {'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade'}
# Users' cookies stay ours, and the target is not our server
webhook_request_dropped_headers = {*HOP_BY_HOP_HEADERS, 'host', 'cookie', 'content-length'}
# Headers of the answer we don't pass back: cookies for our domain, what applies to the connection with the target,
# and CORS or security policies for our pages. (r.content is decoded: not Content-Encoding)
webhook_response_dropped_headers = {
  *HOP_BY_HOP_HEADERS, 'set-cookie', 'set-cookie2', 'content-length', 'content-encoding',
  'content-security-policy', 'content-security-policy-report-only', 'strict-transport-security', 'public-key-pins',
  'x-frame-options', 'refresh', 'clear-site-data', 'alt-svc',
}

def integration_urls(integrations):
  """The URLs that integrations call or link to"""
  for integration in iter_integrations(integrations):
    for value in (integration.get('href'), integration.get('url'), (integration.get('webhook') or {}).get('url') if isinstance(integration.get('webhook'), dict) else None):
      if isinstance(value, str) and value:
        yield value


def url_host_template(url: str):
  """
  The hostname of a URL from qaboard.yaml, lowercase, maybe with ${...} templates (e.g. "ci-${project_name}.example.com").
  None if the host can be anything (e.g. "${git.web_url}/-/commits") or the URL is relative.
  """
  match = re.match(r'^https?://([^/?#]*)', url, re.I)
  if not match:
    return None
  netloc = match.group(1).rpartition('@')[2]
  if netloc.startswith('['): # IPv6
    return netloc.partition(']')[0][1:].lower() or None
  if '${' in netloc:
    # a template, followed by its port, if any
    host = re.sub(r':([0-9]*|\$\{[^}]*\})$', '', netloc)
    # only with a literal domain after the last template, e.g. ".example.com": "${x}" or "${x}.local" could be any host
    suffix = host.rpartition('}')[2]
    if '.' not in suffix.strip('.') or '${' in suffix:
      return None
    return host.lower()
  return netloc.partition(':')[0].lower() or None


def configs_of(project_id, commit_id=None):
  """The qaboard.yaml configurations whose integrations the web app shows for a project (and one of its commits)"""
  project = Project.query.filter(Project.id == project_id).one_or_none()
  if not project:
    return
  yield project.data or {}, (project.data or {}).get('qatools_config')
  if commit_id:
    ci_commit = CiCommit.query.filter(CiCommit.project_id == project_id, CiCommit.hexsha == commit_id).one_or_none()
    if ci_commit:
      yield None, (ci_commit.data or {}).get('qatools_config')
      for batch in ci_commit.batches:
        yield None, (batch.data or {}).get('qatools_config')


def webhook_allowed_hosts(project_id=None, commit_id=None):
  """(hostnames, hostname templates) the webhook proxy can call"""
  hosts = {*proxy_hosts, *(h.lower() for h in jenkins_credentials)}
  # our own pages, at the URL admins configured (the Host header is the client's choice)
  for url in [os.environ.get('QABOARD_URL'), *(setting('auth.allowed_origins') or [])]:
    hostname = urlparse(url).hostname if isinstance(url, str) and '//' in url else None
    if hostname:
      hosts.add(hostname.lower())
  templates = set()
  if project_id:
    for project_data, config in configs_of(project_id, commit_id):
      git = (project_data or {}).get('git') or {}
      if isinstance(git, dict) and isinstance(git.get('web_url'), str):
        hostname = urlparse(git['web_url']).hostname
        if hostname:
          hosts.add(hostname.lower())
      if not isinstance(config, dict):
        continue
      for url in integration_urls(config.get('integrations')):
        host = url_host_template(url)
        if host:
          (templates if '${' in host else hosts).add(host)
  return hosts, templates


def is_webhook_allowed(url, allowed):
  hosts, templates = allowed
  try:
    parsed = urlparse(url)
    hostname = (parsed.hostname or '').lower()
  except ValueError: # e.g. an invalid IPv6 address
    return False
  if parsed.scheme not in ('http', 'https') or not hostname:
    return False
  return hostname in hosts or any(matches_template(template, hostname) for template in templates)


@app.route("/api/v1/webhook/proxy", methods=['POST'])
@app.route("/api/v1/webhook/proxy/", methods=['POST'])
@login_required
def proxy_webook():
  """
  Sends qaboard.yaml's webhooks, and checks its links, for the web app. Query string: ?project=&commit=
  Body: the arguments of requests.request: method, url, params, data, json, headers, auth: {username, password}
  """
  data = request.get_json(silent=True)
  if not isinstance(data, dict) or not isinstance(data.get('url'), str) or not data['url']:
    return jsonify({"error": "Expected a JSON object with a url"}), 400
  unknown = set(data) - WEBHOOK_FIELDS
  if unknown:
    return jsonify({"error": f"Unsupported webhook options: {', '.join(sorted(unknown))}. Use {', '.join(sorted(WEBHOOK_FIELDS))}."}), 400
  method = str(data.get('method') or 'GET').upper()
  if method not in WEBHOOK_METHODS:
    return jsonify({"error": f"Unsupported method: {method}"}), 400
  headers = data.get('headers') or {}
  if not isinstance(headers, dict):
    return jsonify({"error": "headers must be an object"}), 400
  headers = {str(k): str(v) for k, v in headers.items() if str(k).lower() not in webhook_request_dropped_headers}
  auth = data.get('auth')
  if auth is not None:
    # we could easily support other types of authentification
    # https://2.python-requests.org/en/master/user/authentication/
    if not isinstance(auth, dict):
      return jsonify({"error": "auth must be {username, password}"}), 400
    auth = HTTPBasicAuth(str(auth.get('username', '')), str(auth.get('password', '')))

  allowed = webhook_allowed_hosts(request.args.get('project'), request.args.get('commit'))
  url = data['url']
  print(f"[webhook-proxy] {method} {url}")
  session = Session()
  for _ in range(5):
    if not is_webhook_allowed(url, allowed):
      print(f"[webhook-proxy] Refused {url}")
      return jsonify({"error": f"QA-Board's server doesn't call {urlparse(url).hostname or url}: it only calls the hosts of the project's integrations, git hosts and QABOARD_PROXY_HOSTS."}), 403
    prepared = Request(method, url, params=data.get('params'), data=data.get('data'), json=data.get('json'), headers=headers, auth=auth).prepare()
    try:
      r = session.send(prepared, verify=False, allow_redirects=False, timeout=(10, 60))
    except requests.RequestException as e:
      return jsonify({"error": f"Could not reach {urlparse(url).hostname}: {type(e).__name__}"}), 502
    if not r.is_redirect:
      break
    # We follow redirects ourselves to check where they go. Like browsers, 301-303 become GETs (but not HEADs).
    next_url = urljoin(url, r.headers['Location'])
    if r.status_code in (301, 302, 303) and method not in ('GET', 'HEAD'):
      method, data = 'GET', {**data, 'data': None, 'json': None}
    if not is_webhook_allowed(next_url, allowed):
      # It answered, e.g. with its sign-in page on another host: links that do still work
      return jsonify({"status_code": r.status_code, "redirected_to": next_url, "message": "The redirect was not followed: its host is not in the project's integrations."})
    url = next_url
  else:
    return jsonify({"error": "Too many redirects"}), 502
  resp = make_response(r.content, r.status_code)
  for k, v in r.headers.items():
    if k.lower() in webhook_response_dropped_headers or k.lower().startswith('access-control-'):
      continue
    resp.headers.set(k, v)
  # The answer is served from our domain: don't let e.g. an HTML page run scripts
  resp.headers.set('Content-Security-Policy', "default-src 'none'; sandbox")
  resp.headers.set('X-Content-Type-Options', 'nosniff')
  return resp


# ==========================================
# GitLab CI: manual jobs
# ==========================================
# qaboard.yaml: integrations: [{text: "My job", gitlabCI: {job_name: "my-job"}}]
# The web app sends {project, gitlab_host, project_id, commit_id, job_name, job_id?}
# We use the server's token: users can only see and play the jobs of the projects they can access, on their repository.

def gitlab_project(data, permission):
  """(the GitLab host, the URL-quoted path of the repository) of the QA-Board project `data['project']`"""
  if not isinstance(data, dict):
    raise IntegrationError("Expected a JSON object", 400)
  project_id = data.get('project')
  if not isinstance(project_id, str) or not project_id:
    raise IntegrationError("Missing `project`", 400)
  if not can(permission, project_id):
    raise IntegrationError("Forbidden: you need the developer role to play jobs" if permission == 'runs.act' else "Forbidden: You don't have permission to access this project", 403)
  project = Project.query.filter(Project.id == project_id).one_or_none()
  if not project:
    raise IntegrationError(f"Unknown project: {project_id}", 404)
  project_data = project.data or {}
  git = project_data.get('git') or {}
  config = project_data.get('qatools_config') or {}
  repo = git.get('path_with_namespace') or project.id_git
  # the web app sends the repository's path. GitLab's numeric ids work too.
  if data.get('project_id') is None or str(data['project_id']) not in {repo, *([str(git['id'])] if git.get('id') is not None else [])}:
    raise IntegrationError(f"The repository of {project_id} is {repo}", 403)
  check_project_path(repo) # e.g. group/repo
  try:
    host = git_hosts.for_repo(git, (config.get('project') or {}).get('url'))
  except ValueError as e:
    raise IntegrationError(str(e), 403)
  if host.type != 'gitlab':
    raise IntegrationError(f"The repository of {project_id} is on {host.url}, not on GitLab", 403)
  if not host.token:
    raise IntegrationError(f"Missing a token for {host.url}: set it in QABOARD_GIT_HOSTS (or GITLAB_ACCESS_TOKEN)", 500)
  return host, quote(repo, safe='')


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
  data = request.get_json(silent=True)
  try:
    host, project_id = gitlab_project(data, 'project.read')
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
  data = request.get_json(silent=True)
  try:
    host, project_id = gitlab_project(data, 'runs.act')
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
  if not can('runs.act' if dispatch else 'project.read', project_id):
    raise IntegrationError("Forbidden: you need the developer role to start workflows" if dispatch else "Forbidden: You don't have permission to access this project", 403)
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
  Get the status of a Jenkins build, with the server's Jenkins credentials: who can start builds can check them
  (jenkins_trigger_access), on the Jenkins hosts (jenkins_status_url_allowed). Only the status is sent back.
  """
  data = request.get_json(silent=True)
  if not isinstance(data, dict):
    return jsonify({"error": "Expected a JSON object"}), 400
  if forbidden := jenkins_trigger_access(data, checking=True):
    return forbidden
  if "build_url" in data or "web_url" in data:
    if "build_url" in data:
      url = data['build_url']
    else:
      url = data['web_url']
    if isinstance(url, str) and not url.endswith("/api/json"):
      url = f"{url.rstrip('/')}/api/json"
  else:
    url = data.get('url')
  if not isinstance(url, str) or not jenkins_status_url_allowed(url):
    return jsonify({"error": f"ERROR: {url} is not on a Jenkins host of JENKINS_AUTH (with the scheme and port of the Jenkins jobs projects use)"}), 403
  jenkins_credentials = jenkins_hostname_credentials(url)
  if not jenkins_credentials:
    return jsonify({"error": f"ERROR: No credentials for {urlparse(url).hostname} in JENKINS_AUTH, to check {url}"}), 403
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
      # not redirects: they could go anywhere, with the credentials
      return requests.get(url, timeout=(60, 3.5*60), allow_redirects=False, **jenkins_credentials)
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
    if not isinstance(build_data, dict) or 'building' not in build_data:
      raise ValueError("not a build")
  except Exception as e:
    # never the body: it's whatever the URL answers, read with the server's credentials
    print(f"[jenkins] {url}: HTTP {r.status_code}, not a Jenkins build: {e}")
    return jsonify({"error": f"ERROR: malformed Jenkins response, when checking the build status: HTTP {r.status_code} ({r.headers.get('Content-Type')}) from {url}, not a Jenkins build's JSON"}), 500
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
  Trigger a Jenkins build, with the server's Jenkins credentials.
  The web app and `qa`'s Jenkins runner say which project: then only its developers can (signed in, or with a token).
  `qa` can also call it without a user, like it sends results (unless ingest.auth is "token"): then only for the
  Jenkins jobs that the project's qaboard.yaml lists.
  """
  data = request.get_json(silent=True)
  if not isinstance(data, dict):
    return jsonify({"error": "Expected a JSON object"}), 400
  if forbidden := jenkins_trigger_access(data):
    return forbidden
  response = trigger_jenkins_build(data)
  if not isinstance(response, tuple): # started
    project_id = data.get('project') if isinstance(data.get('project'), str) else None
    audit('jenkins.build', 'jenkins_job', None, str(data['build_url'])[:200], project_id=project_id, meta={"cause": str(data.get('cause'))[:200]})
    db_session.commit()
  return response


def jenkins_trigger_access(data, checking=False):
  """None if the caller can start this Jenkins build (`checking`: check builds' status), else the response to return"""
  verb = "check" if checking else "start"
  project_id = data.get('project') if isinstance(data.get('project'), str) and data.get('project') else None
  actor = g.get('actor')
  if actor is not None and actor.user is not None:
    if actor.token is not None and not (actor.has_scope('act') or actor.has_scope('ingest')):
      return jsonify({"error": f"This token can't {verb} Jenkins builds: it needs the \"act\" or \"ingest\" scope.", "reason": "missing_scope", "required": "act"}), 403
    if project_id:
      if not actor.allows_project(project_id):
        return jsonify({"error": f"This token can't access {project_id}.", "reason": "token_project"}), 403
      # qa's CI tokens may only have the ingest scope
      return require_project_access(None, project_id, 'runs.act' if actor.has_scope('act') else 'runs.ingest')
    return None
  mode = setting('ingest.auth')
  if mode == 'token':
    return jsonify({
      "error": f"This server only {verb}s Jenkins builds for signed-in users: run `qa auth login`, or set QABOARD_TOKEN in CI.",
      "reason": "ingest_token_required",
    }), 403
  build_url = data.get('build_url')
  if not checking and isinstance(build_url, str) and not is_declared_jenkins_job(build_url, project_id, data.get('commit')):
    where = f"the qaboard.yaml of {project_id}" if project_id else "the projects' qaboard.yaml"
    return jsonify({
      "error": f"Without signing in, QA-Board only starts the Jenkins jobs of {where} (runners.jenkins.build_url, or jenkins integrations). Run `qa auth login`, or set QABOARD_TOKEN in CI.",
      "reason": "sign_in_required",
    }), 403
  if mode == 'warn':
    g.qaboard_warning = f"This Jenkins build was {'checked' if checking else 'started'} without a token. This server will soon require one: run `qa auth login`, or set QABOARD_TOKEN in CI."
  return None


def jenkins_jobs(config):
  """The Jenkins jobs a qaboard.yaml lists: its runner's, and its integrations'"""
  if not isinstance(config, dict):
    return
  runners = config.get('runners')
  jenkins_runner = runners.get('jenkins') if isinstance(runners, dict) else None
  if isinstance(jenkins_runner, dict):
    yield jenkins_runner.get('build_url')
  for integration in iter_integrations(config.get('integrations')):
    if isinstance(integration.get('jenkins'), dict):
      yield integration['jenkins'].get('build_url')


# Without a project, we look at all the projects: qa batch can start hundreds of builds
_declared_jenkins_jobs = {"at": None, "build_urls": set()}

def declared_jenkins_jobs() -> set:
  """The Jenkins jobs of all the projects' qaboard.yaml, read again every few minutes"""
  if _declared_jenkins_jobs["at"] is None or time.time() - _declared_jenkins_jobs["at"] > 300:
    _declared_jenkins_jobs["build_urls"] = {
      url.strip().rstrip('/')
      for (data,) in db_session.query(Project.data).all()
      for url in jenkins_jobs((data or {}).get('qatools_config')) if isinstance(url, str)
    }
    _declared_jenkins_jobs["at"] = time.time()
  return _declared_jenkins_jobs["build_urls"]

def is_declared_jenkins_job(build_url, project_id=None, commit_id=None):
  normalize = lambda url: url.strip().rstrip('/')
  if project_id:
    configs = [config for _, config in configs_of(project_id, commit_id if isinstance(commit_id, str) else None)]
    build_urls = {normalize(url) for config in configs for url in jenkins_jobs(config) if isinstance(url, str)}
  else:
    build_urls = declared_jenkins_jobs()
  return any(matches_template(declared, normalize(build_url)) for declared in build_urls)


DEFAULT_PORTS = {'http': 80, 'https': 443}

def url_origin(url):
  """(scheme, hostname, port), None for URLs that aren't http(s), or have credentials"""
  parsed = urlparse(url)
  try:
    port = parsed.port or DEFAULT_PORTS.get(parsed.scheme)
  except ValueError: # e.g. a port that isn't a number, or a ${template}
    return None
  if parsed.scheme not in DEFAULT_PORTS or not parsed.hostname or parsed.username or parsed.password:
    return None
  return parsed.scheme, parsed.hostname, port

def jenkins_status_url_allowed(url) -> bool:
  """
  We send JENKINS_AUTH's credentials to its hosts, on the default port of http(s), or with the scheme and port of a
  Jenkins job of the projects' qaboard.yaml (on a JENKINS_AUTH host): not to other services on the same machines.
  """
  origin = url_origin(url)
  if origin is None or origin[1] not in jenkins_credentials:
    return False
  scheme, _, port = origin
  if port == DEFAULT_PORTS[scheme]:
    return True
  declared = [url_origin(job) for job in declared_jenkins_jobs()]
  return any(d is not None and d[1] in jenkins_credentials and (d[0], d[2]) == (scheme, port) for d in declared)


def trigger_jenkins_build(data):
  """
  Triggers a Jenkins build, waits a little for Jenkins to start it, and returns the response and its status code.
  data: {build_url, params|parameters?, token?, cause?}
  """
  if 'build_url' not in data:
      return jsonify({"error": f"ERROR: the integration is missing `build_url` (in your qaboard.yaml)"}), 400
  jenkins_credentials = jenkins_hostname_credentials(data['build_url'])
  if not jenkins_credentials:
    return jsonify({"error": f"ERROR: No credentials for {urlparse(data['build_url']).hostname} in JENKINS_AUTH, to trigger {data['build_url']}"}), 403
  build_url = re.sub("/$", "", data['build_url'])
  params = {
    "cause": data.get('cause', "Triggered via QA-Board"),
    # the docs used to say `parameters`
    **(data.get('params') or data.get('parameters') or {}),
  }
  # The job's token ("Trigger builds remotely"): the integration's, else the server's JENKINS_BUILD_TOKEN.
  # `token: null` or "" sends none (the Windows runner sends null when it has no token).
  token = data["token"] if "token" in data else jenkins_build_token
  if token:
    params["token"] = token

  def post(build_trigger_url):
    # Jenkins answers "201 Created" with the queue item in `location`. We don't follow redirects:
    # they lead to HTML pages (login, job page...) and would hide what went wrong.
    return requests.post(build_trigger_url, params=params, allow_redirects=False, timeout=60, **jenkins_credentials)
  build_trigger_url = f"{build_url}/buildWithParameters"
  try:
    r_build = post(build_trigger_url)
    # Jenkins refuses buildWithParameters for jobs without parameters, but only tells admins why:
    # others get "A problem occurred while processing the request"
    if not r_build.ok and not jenkins_job_is_parameterized(build_url, jenkins_credentials):
      build_trigger_url = f"{build_url}/build"
      r_build = post(build_trigger_url)
  except Exception as e:
      print(build_trigger_url)
      print(e)
      return jsonify({"error": f"ERROR: When triggering job: {e}"}), 500

  if not 200 <= r_build.status_code < 300 or 'location' not in r_build.headers:
      return jsonify({"error": f"ERROR: Jenkins did not queue the build: {jenkins_error(r_build, build_trigger_url)}"}), 500
  build_queue_location = f"{r_build.headers['location']}/api/json".replace("//api/json", "/api/json")

  def ensure_absolute(url):
    # in some cases jenkins will return a relative location
    if '://' not in url:
      url_info = urlparse(build_url)
      if not url.startswith('/'):
        url = f"/{url}" 
      url = f"{url_info.scheme}://{url_info.netloc}{url}"
    return jenkins_same_host(url, build_url)

  build_queue_location = ensure_absolute(build_queue_location)
  time.sleep(5) # jenkins' "quiet period"
  sleep_total = 5
  error = None
  web_url = None
  while not web_url and sleep_total < 30:
    try:
      r_get = requests.get(
        build_queue_location,
        timeout=60,
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
