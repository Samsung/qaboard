"""
When a commit's artifacts are gone, QA-Board can ask a CI tool to recreate them, before redoing runs or tuning.

```yaml title="qaboard.yaml"
recreate_artifacts:
  # Same as the integrations, but run by the server. One of:
  gitlabCI:
    job_name: build     # retried (or played if manual) in the commit's latest pipeline
  jenkins:
    build_url: http://jenkins/job/my-project
    params:
      commit: ${commit.id}
  webhook:
    url: https://example.com/hooks/build
    method: POST
    json:
      commit: ${commit.id}
```

The CI job is expected to build and call `qa save-artifacts`, which tells QA-Board the artifacts are back.
Without `recreate_artifacts`, QA-Board can only restore the files from the source code (`git checkout && qa save-artifacts`),
not build outputs like binaries.
"""
import re
import datetime
from typing import Any, Dict, List, Optional
from urllib.parse import quote, urlparse

import requests


KINDS = ('gitlabCI', 'jenkins', 'webhook')

# A recreation that was triggered less than this ago is still considered in progress
IN_PROGRESS_FOR = datetime.timedelta(hours=2)

template_re = re.compile(r'\$\{\s*([\w.]+)\s*\}')


def recreate_settings(*configs: Optional[Dict]) -> Optional[Dict]:
  """The first `recreate_artifacts` found in the configs (e.g. the project's latest qaboard.yaml, then the commit's)."""
  for config in configs:
    # configs come from unauthenticated API calls: they may be anything
    if isinstance(config, dict) and config.get('recreate_artifacts'):
      return config['recreate_artifacts']
  return None


def template_variables(ci_commit, user=None) -> Dict[str, str]:
  from qaboard.conventions import slugify
  branch = re.sub('^origin/', '', ci_commit.branch or '')
  return {
    'commit.id': ci_commit.hexsha,
    'commit.branch': branch,
    'commit.branch_slug': slugify(branch) if branch else '',
    'commit.artifacts_dir': str(ci_commit.artifacts_dir),
    'commit.repo_artifacts_dir': str(ci_commit.repo_artifacts_dir),
    'branch': branch,
    'project': ci_commit.project.id,
    'project_id': ci_commit.project.id,
    'subproject': ci_commit.project.id_relative,
    'git': ci_commit.project.id_git,
    'user': user or '',
  }


# In these, values are URL-quoted: e.g. a branch named "a&token=x" or "../other-job" can't change the URL
URL_KEYS = ('url', 'build_url')

def fill(value: Any, variables: Dict[str, str], in_url=False) -> Any:
  """Replaces ${commit.id}-like templates, recursively. Raises KeyError for unknown variables."""
  if isinstance(value, str):
    def replace(match):
      name = match.group(1)
      if name not in variables:
        raise KeyError(f"Unknown variable ${{{name}}}. Available: {', '.join(sorted(variables))}")
      return quote(str(variables[name]), safe='') if in_url else str(variables[name])
    return template_re.sub(replace, value)
  if isinstance(value, list):
    return [fill(v, variables, in_url) for v in value]
  if isinstance(value, dict):
    return {k: fill(v, variables, in_url or k in URL_KEYS) for k, v in value.items()}
  return value


def validate(settings: Any, variables: Optional[Dict[str, str]] = None) -> List[str]:
  """Returns errors in a `recreate_artifacts` configuration."""
  if not isinstance(settings, dict):
    return ["`recreate_artifacts` should be a mapping with one of: " + ", ".join(KINDS)]
  kinds = [k for k in KINDS if k in settings]
  if len(kinds) != 1:
    return [f"`recreate_artifacts` should define exactly one of: {', '.join(KINDS)} (found: {', '.join(kinds) or 'none'})"]
  kind = kinds[0]
  spec = settings[kind]
  errors = []
  if not isinstance(spec, dict):
    return [f"`recreate_artifacts.{kind}` should be a mapping"]
  if kind == 'gitlabCI' and not spec.get('job_name'):
    errors.append("`recreate_artifacts.gitlabCI` needs a `job_name`")
  if kind == 'gitlabCI' and 'project_id' in spec:
    # anyone can send a qaboard.yaml: we only start jobs of the project's own repository with the server's token
    errors.append("`recreate_artifacts.gitlabCI.project_id` is not supported: QA-Board uses the project's own repository")
  if kind == 'jenkins' and not spec.get('build_url'):
    errors.append("`recreate_artifacts.jenkins` needs a `build_url`")
  if kind == 'webhook':
    if not spec.get('url'):
      errors.append("`recreate_artifacts.webhook` needs a `url`")
    elif urlparse(str(spec['url'])).scheme not in ('http', 'https'):
      errors.append("`recreate_artifacts.webhook.url` should start with http:// or https://")
  if variables is not None:
    try:
      fill(spec, variables)
    except KeyError as e:
      errors.append(f"`recreate_artifacts.{kind}`: {e.args[0]}")
  return errors


def describe(settings: Any) -> str:
  if not isinstance(settings, dict):
    return "?"
  spec = lambda kind: settings[kind] if isinstance(settings[kind], dict) else {}
  try:
    if 'gitlabCI' in settings:
      return f"the GitlabCI job \"{spec('gitlabCI').get('job_name')}\""
    if 'jenkins' in settings:
      return f"the Jenkins job {spec('jenkins').get('build_url')}"
    if 'webhook' in settings:
      return f"a webhook to {urlparse(str(spec('webhook').get('url'))).hostname}"
  except Exception:
    pass
  return "?"


def in_progress(recreation: Optional[Dict], now=None) -> bool:
  if not isinstance(recreation, dict) or recreation.get('status') != 'triggered':
    return False
  now = now or datetime.datetime.now(datetime.timezone.utc)
  try:
    at = datetime.datetime.fromisoformat(recreation['at'])
    # timestamps in the future can't be ours
    return datetime.timedelta(0) <= now - at < IN_PROGRESS_FOR
  except Exception: # missing, invalid, without timezone...
    return False


def trigger(settings: Dict, ci_commit, user=None) -> Dict:
  """
  Asks the CI to recreate the artifacts. Returns what we remember in CiCommit.data.artifacts_recreation:
    {status: triggered|failed, at, by, via, web_url?, error?}
  """
  now = datetime.datetime.now(datetime.timezone.utc).isoformat()
  recreation: Dict[str, Any] = {"at": now, "by": user, "via": describe(settings) if isinstance(settings, dict) else "?"}
  variables = template_variables(ci_commit, user)
  errors = validate(settings, variables)
  if errors:
    return {**recreation, "status": "failed", "error": " ".join(errors)}
  try:
    if 'gitlabCI' in settings:
      web_url = _trigger_gitlab(fill(settings['gitlabCI'], variables), ci_commit)
    elif 'jenkins' in settings:
      web_url = _trigger_jenkins(fill(settings['jenkins'], variables), ci_commit)
    else:
      web_url = _trigger_webhook(fill(settings['webhook'], variables))
  except Exception as e:
    print(f"[recreate-artifacts] {ci_commit}: {e}")
    return {**recreation, "status": "failed", "error": str(e)}
  return {**recreation, "status": "triggered", "web_url": web_url}


def _trigger_gitlab(spec, ci_commit) -> Optional[str]:
  from .api.integrations import api_host, gitlab_job_named
  git_data = ci_commit.project.data.get('git', {}) or {}
  # api_host only returns hosts configured on the server (QABOARD_GIT_HOSTS): tokens never go anywhere else
  gitlab_host = spec.get('gitlab_host') or git_data.get('host') or ('/'.join(git_data['web_url'].split('/')[:3]) if git_data.get('web_url') else None)
  host = api_host(gitlab_host, 'gitlab')
  project_id = quote(str(ci_commit.project.id_git), safe='')
  # the latest job with this name in the commit's last pipeline
  job = gitlab_job_named(host, project_id, ci_commit.hexsha, spec['job_name'])
  if job['status'] in ('created', 'pending', 'running', 'waiting_for_resource', 'preparing', 'scheduled'):
    return job.get('web_url') # already on its way
  # https://docs.gitlab.com/ee/api/jobs.html#run-a-job / #retry-a-job
  action = 'play' if job['status'] == 'manual' else 'retry'
  r = host.api('POST', f"/projects/{project_id}/jobs/{job['id']}/{action}")
  r.raise_for_status()
  return r.json().get('web_url', job.get('web_url'))


def _trigger_jenkins(spec, ci_commit) -> Optional[str]:
  from .api.integrations import trigger_jenkins_build
  response = trigger_jenkins_build({"cause": f"QA-Board: recreate the artifacts of {ci_commit.hexsha[:8]}", **spec})
  response, status = response if isinstance(response, tuple) else (response, 200)
  data = response.get_json() if hasattr(response, 'get_json') else response
  if int(status) >= 400:
    raise ValueError((data or {}).get('error', f"Jenkins answered {status}"))
  return data.get('web_url') or data.get('url')


def _trigger_webhook(spec) -> Optional[str]:
  method = str(spec.get('method', 'POST')).upper()
  kwargs = {k: spec[k] for k in ('params', 'json', 'data', 'headers') if k in spec}
  if 'auth' in spec:
    kwargs['auth'] = (spec['auth']['username'], spec['auth']['password'])
  # no redirects: the server would follow them to any address
  r = requests.request(method, spec['url'], timeout=60, allow_redirects=False, **kwargs)
  r.raise_for_status()
  try:
    body = r.json()
    web_url = body.get('web_url') or body.get('url') if isinstance(body, dict) else None
  except Exception:
    return None
  # we only show users links to the CI that answered, not what other services may answer
  if isinstance(web_url, str) and len(web_url) < 2000 and urlparse(web_url).scheme in ('http', 'https') and urlparse(web_url).hostname == urlparse(spec['url']).hostname:
    return web_url
  return None
