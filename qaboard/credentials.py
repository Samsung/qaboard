"""
Where qa finds QA-Board servers and the tokens it sends them, without the CLI (see qaboard/auth.py for `qa auth`).

Sign-ins are saved per server, not per project, in hosts.yaml in the user's config directory
(~/.config/qaboard, $XDG_CONFIG_HOME/qaboard, %APPDATA%\\qaboard on Windows), with mode 0600:
    https://qa.example:
      user: alice
      token: qab_pat_...
      token_id: 12
      minted_by: device       # `qa auth login` created the token (else: with-token, a token the user gave)
      created_at: '2026-10-20T08:00:00+00:00'

Requests to a server use the first token found (see `resolve_token`):
    $QABOARD_TOKEN > $QA_TOKEN (alias) > the CI job's OIDC ID token, exchanged > hosts.yaml's sign-in for the server
    > QA_TOKEN in ~/.qaboard/secrets.yaml (legacy, only for the default server)

CI without stored secrets: GitHub Actions (with `permissions: id-token: write`) and GitLab CI (with `id_tokens:
QABOARD_ID_TOKEN`) give jobs an ID token. qa exchanges it once for a short-lived token of the service account that
trusts the job ($QABOARD_SERVICE_ACCOUNT picks one when several do), and puts it in $QABOARD_TOKEN for the qa
processes it starts (backend/ci_trust.py on the server).
"""
import os
import re
import datetime
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple
from urllib.parse import urlsplit

import yaml

from .site_config import site_config, secrets, user_secrets, user_secrets_path, user_config_dir, _load_secrets, _site_defaults

ENV_TOKENS = ('QABOARD_TOKEN', 'QA_TOKEN')
# GitLab CI: `id_tokens: {QABOARD_ID_TOKEN: {aud: <server URL>}}`
ID_TOKEN_ENV = 'QABOARD_ID_TOKEN'
# Set once an exchange failed, so that the qa processes it starts don't try again (and repeat the warning)
EXCHANGE_FAILED_ENV = 'QA_CI_TOKEN_EXCHANGE_FAILED'
CI_TOKEN_SOURCE = 'ci-id-token'
# Set once qa printed a warning about signing in, so that the runs `qa batch` starts don't repeat it
WARNING_SHOWN_ENV = 'QA_AUTH_WARNING_SHOWN'
DEFAULT_SERVER = 'http://localhost:5151'
# Legacy Windows consoles and log files may not have "→"
ACCESS_TOKENS_PAGE = "Settings > Access tokens" if os.name == 'nt' else "Settings → Access tokens"


def normalize_url(url: str, default_scheme: str = 'http') -> str:
  """A server's URL as a key in hosts.yaml: scheme://host[:port], lowercase, without default ports, paths or trailing slashes."""
  url = url.strip()
  if '://' not in url:
    url = f"{default_scheme}://{url}"
  parts = urlsplit(url)
  scheme, host = parts.scheme.lower(), (parts.hostname or '').lower()
  if not host:
    raise ValueError(f"Not a server URL: {url}")
  if ':' in host: # IPv6
    host = f"[{host}]"
  port = parts.port # raises ValueError if it's not a number
  default_port = {'http': 80, 'https': 443}.get(scheme)
  return f"{scheme}://{host}{f':{port}' if port and port != default_port else ''}"


def same_server(a: Optional[str], b: Optional[str]) -> bool:
  try:
    return bool(a and b) and normalize_url(str(a)) == normalize_url(str(b))
  except ValueError:
    return False


def setting_source(key: str) -> str:
  """Where a setting read with site_config comes from, for people."""
  if os.environ.get(key) is not None:
    return f"${key}"
  if key in secrets:
    return f"{key} in your secrets"
  if key in _site_defaults:
    return f"{key} from the site package"
  return key


def default_server() -> Tuple[str, Optional[str]]:
  """
  The URL of the server qa sends results to, and which setting gives it, e.g. "$QABOARD_URL",
  "QABOARD_HOST from the site package"... None when nothing does and qa uses http://localhost:5151.
  """
  protocol = site_config('QABOARD_PROTOCOL', 'http')
  hostname, port, host = site_config('QABOARD_HOSTNAME'), site_config('QABOARD_PORT'), site_config('QABOARD_HOST')
  if hostname and port:
    return f"{protocol}://{hostname}:{port}", f"{setting_source('QABOARD_HOSTNAME')} and {setting_source('QABOARD_PORT')}"
  if host:
    return f"{protocol}://{host}", setting_source('QABOARD_HOST')
  url = site_config('QABOARD_URL')
  if url:
    return url, setting_source('QABOARD_URL')
  return DEFAULT_SERVER, None


def hosts_path() -> Path:
  return user_config_dir() / 'hosts.yaml'


def read_hosts() -> Dict[str, Any]:
  hosts = _load_secrets(hosts_path(), check_permissions=True)
  return hosts if isinstance(hosts, dict) else {}


def find_login(hosts: Dict[str, Any], server_url: str) -> Tuple[Optional[str], Optional[Dict[str, Any]]]:
  """The key and the saved sign-in for a server. Keys edited by hand may not be normalized."""
  for key, login in hosts.items():
    if same_server(key, server_url) and isinstance(login, dict):
      return key, login
  return None, None


def saved_logins() -> List[Tuple[str, Dict[str, Any]]]:
  """The servers with a sign-in in hosts.yaml, and their sign-in."""
  logins = []
  for key, login in read_hosts().items():
    try:
      if isinstance(login, dict) and login.get('token'):
        logins.append((normalize_url(str(key)), login))
    except ValueError:
      continue
  return logins


def write_hosts(hosts: Dict[str, Any]):
  """Replaces hosts.yaml atomically, readable only by the user."""
  path = hosts_path()
  path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
  tmp = path.with_name(f".{path.name}.{os.getpid()}.tmp")
  fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
  try:
    with os.fdopen(fd, 'w') as f:
      if hasattr(os, 'fchmod'): # in case a previous temporary file was left behind with other permissions
        os.fchmod(f.fileno(), 0o600)
      yaml.safe_dump(hosts, f, default_flow_style=False)
      f.flush()
      os.fsync(f.fileno())
    os.replace(tmp, path)
  except BaseException:
    try:
      os.unlink(tmp)
    except OSError:
      pass
    raise


def save_login(server_url: str, user: str, token: str, token_id: Any = None, minted_by: str = 'with-token'):
  """`minted_by`: "device" when `qa auth login` created the token (`qa auth logout` revokes those), else "with-token"."""
  hosts = read_hosts()
  key, _ = find_login(hosts, server_url)
  if key is not None:
    del hosts[key]
  hosts[server_url] = {
    'user': user,
    'token': token,
    'token_id': token_id,
    'minted_by': minted_by,
    'created_at': datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds'),
  }
  write_hosts(hosts)


def forget_login(server_url: str):
  hosts = read_hosts()
  key, _ = find_login(hosts, server_url)
  if key is not None:
    del hosts[key]
    write_hosts(hosts)


# the tokens we got for CI jobs' ID tokens, by server
_exchanged: Dict[str, Optional[str]] = {}


def ci_id_token(audience: str) -> Tuple[Optional[str], Optional[str]]:
  """(the CI job's OIDC ID token, None), (None, None) without one, or (None, why) when the CI didn't give it."""
  import requests
  token = os.environ.get(ID_TOKEN_ENV, '').strip()
  if token:
    return token, None
  url, request_token = os.environ.get('ACTIONS_ID_TOKEN_REQUEST_URL'), os.environ.get('ACTIONS_ID_TOKEN_REQUEST_TOKEN')
  if not url or not request_token:
    return None, None
  try:
    r = requests.request('GET', url, params={'audience': audience}, headers={'Authorization': f"bearer {request_token}"}, timeout=30)
    value = json_body(r).get('value') if r.status_code == 200 else None
  except requests.RequestException as e:
    return None, f"GitHub didn't give the job an ID token: {type(e).__name__}"
  if not isinstance(value, str) or not value:
    return None, f"GitHub didn't give the job an ID token ({r.status_code})"
  return value, None


def exchange_ci_token(server_url: str) -> Optional[str]:
  """
  In CI jobs with an OIDC ID token, a short-lived token of the service account that trusts the job, once per process.
  Prints why when it fails, and returns None: the server then says what it needs.
  """
  import click
  import requests
  key = normalize_url(server_url)
  if key in _exchanged:
    return _exchanged[key]
  if os.environ.get(EXCHANGE_FAILED_ENV):
    return None
  audience = os.environ.get('QABOARD_ID_TOKEN_AUDIENCE', '').strip() or key
  id_token, problem = ci_id_token(audience)
  if not id_token and not problem:
    return None
  _exchanged[key] = None
  def failed(message):
    os.environ[EXCHANGE_FAILED_ENV] = '1'
    click.secho(f"WARNING: {message}", fg='yellow', err=True)
  if problem:
    failed(f"{problem}: qa sends results without a token.")
    return None
  from .site_config import as_requests_verify
  prefix = site_config('QABOARD_API_PREFIX') if same_server(server_url, default_server()[0]) else None
  url = f"{(prefix or f'{key}/api/v1').rstrip('/')}/auth/token-exchange"
  body = {
    'grant_type': 'urn:ietf:params:oauth:grant-type:token-exchange',
    'subject_token': id_token,
    'subject_token_type': 'urn:ietf:params:oauth:token-type:id_token',
  }
  hint = os.environ.get('QABOARD_SERVICE_ACCOUNT', '').strip()
  if hint:
    body['service_account'] = hint
  try:
    r = requests.request('POST', url, json=body, headers={'Accept': 'application/json'}, timeout=30,
                         verify=as_requests_verify(site_config('QABOARD_API_VERIFY')))
  except requests.RequestException as e:
    failed(f"Could not exchange the CI job's ID token for a QA-Board token ({describe_network_error(e)}): qa sends results without a token.")
    return None
  token = json_body(r).get('access_token') if r.status_code == 200 else None
  if not isinstance(token, str) or not token:
    failed(f"QA-Board refused the CI job's ID token: {describe_body(r) or r.status_code} qa sends results without a token.")
    return None
  _exchanged[key] = token
  # the qa processes we start (qa batch => qa run) reuse it
  os.environ['QABOARD_TOKEN'] = token
  return token


def resolve_token(server_url: Optional[str]) -> Tuple[Optional[str], Optional[str]]:
  """
  The token to send to a server, and where it comes from: QABOARD_TOKEN or QA_TOKEN (environment variables, for every server),
  the CI job's exchanged ID token, hosts.yaml, or secrets.yaml (the legacy ~/.qaboard/secrets.yaml, only for the default
  server). (None, None) without a token.
  """
  if server_url and _exchanged.get(normalize_url(server_url)):
    return _exchanged[normalize_url(server_url)], CI_TOKEN_SOURCE
  for name in ENV_TOKENS:
    token = os.environ.get(name, '').strip()
    if token:
      return token, name
  if server_url:
    exchanged = exchange_ci_token(server_url)
    if exchanged:
      return exchanged, CI_TOKEN_SOURCE
    _, login = find_login(read_hosts(), server_url)
    if login and login.get('token'):
      return str(login['token']).strip(), 'hosts.yaml'
  token = str(user_secrets.get('QA_TOKEN') or '').strip()
  if token and (not server_url or same_server(server_url, default_server()[0])):
    return token, 'secrets.yaml'
  return None, None


def describe_source(source: Optional[str]) -> str:
  if source in ENV_TOKENS:
    return f"the {source} environment variable"
  if source == CI_TOKEN_SOURCE:
    return "the CI job's ID token, exchanged for a service account's token"
  if source == 'hosts.yaml':
    return str(hosts_path())
  if source == 'secrets.yaml':
    return f"{user_secrets_path} (legacy)"
  return "nowhere"


def json_body(r) -> Dict[str, Any]:
  try:
    body = r.json()
  except Exception:
    return {}
  return body if isinstance(body, dict) else {}


def refusal(r) -> Optional[Dict[str, Any]]:
  """
  For a 401 or 403 that says why (JSON with a `reason`): {status, reason, error (the server's sentence), required?,
  project?, owners? (whom to ask for a role)}.
  None otherwise: callers keep their usual error handling, e.g. for older servers or proxies.
  """
  status = getattr(r, 'status_code', None)
  if status not in (401, 403):
    return None
  body = json_body(r)
  reason, error = body.get('reason'), body.get('error')
  if not isinstance(reason, str) or not reason:
    return None
  if not isinstance(error, str) or not error.strip():
    error = f"QA-Board refused the request ({status} {reason})."
  required = body.get('required')
  owners = [o.get('name') for o in body.get('owners') or [] if isinstance(o, dict) and isinstance(o.get('name'), str)]
  return {
    'status': status, 'reason': reason, 'error': error.strip(), 'required': required if isinstance(required, str) else None,
    'project': body.get('project') if isinstance(body.get('project'), str) else None, 'owners': owners,
  }


def fix_for(refused: Dict[str, Any], token_source: Optional[str] = None, ci: bool = False, project: Optional[str] = None, server: Optional[str] = None) -> Optional[str]:
  """
  One line that says what to do about a refusal, after the server's sentence (it only says what's wrong).
  In CI, never `qa auth login`: there is no one to sign in.
  """
  reason, required = refused['reason'], refused.get('required')
  env_name = token_source if token_source in ENV_TOKENS else 'QABOARD_TOKEN'
  if reason == 'token_in_url':
    return None
  if reason == 'token_project':
    return f"Create a token for {project or 'this project'} in {ACCESS_TOKENS_PAGE}."
  if reason == 'missing_scope':
    scope = f'the "{required}" scope' if required else "the scopes it needs"
    if ci or token_source in ENV_TOKENS:
      return f"Create a token with {scope} in {ACCESS_TOKENS_PAGE}, and set ${env_name} to it."
    return f"Create a token with {scope} in {ACCESS_TOKENS_PAGE}, then sign in with it: `qa auth login --with-token`."
  if reason.startswith('token_'):
    if token_source == CI_TOKEN_SOURCE:
      return "qa got this token for the CI job's ID token, and such tokens only last a few hours: run the job again."
    if token_source in ENV_TOKENS:
      return f"Replace ${token_source} with a valid token ({ACCESS_TOKENS_PAGE})."
    if ci:
      return f"Set QABOARD_TOKEN to a valid token ({ACCESS_TOKENS_PAGE})."
    if token_source == 'secrets.yaml':
      return f"Run `qa auth login`, then remove QA_TOKEN from {user_secrets_path}."
    return "Run `qa auth login` to sign in again."
  if reason == 'missing_role':
    target = refused.get('project') or project or 'the project'
    owners = refused.get('owners') or []
    who = f" ({', '.join(owners[:3])})" if owners else ''
    where = f": {server.rstrip('/')}/{target}/access" if server else " on its Access page in QA-Board"
    return f"Ask an owner{who} of {target} for the {refused.get('required') or 'needed'} role, or request it{where}."
  if reason in ('sign_in_required', 'ingest_token_required'):
    if ci:
      scope = " with the ingest scope" if reason == 'ingest_token_required' else ''
      return f"Set QABOARD_TOKEN to a token{scope} ({ACCESS_TOKENS_PAGE})."
    return "Run `qa auth login`."
  return None


def auth_error_hint(r, token_source: Optional[str] = None, ci: bool = False, project: Optional[str] = None) -> Optional[str]:
  """For a 401 or 403 that says why, the server's sentence and, on a second line, what to do. None otherwise."""
  refused = refusal(r)
  if not refused:
    return None
  fix = fix_for(refused, token_source, ci, project)
  return f"{refused['error']}\n{fix}" if fix else refused['error']


def describe_body(r) -> str:
  """A short description of what a server answered, e.g. for a wrong URL: its JSON error, a web page's <title>, or the start of the text."""
  error = json_body(r).get('error_description') or json_body(r).get('error')
  if isinstance(error, str) and error.strip():
    return error.strip()
  text = getattr(r, 'text', '') or ''
  title = re.search(r'<title[^>]*>(.*?)</title>', text, re.IGNORECASE | re.DOTALL)
  if title and title.group(1).strip():
    return f"a web page: {' '.join(title.group(1).split())[:100]}"
  text = ' '.join(text.split())
  return text[:100] + ('...' if len(text) > 100 else '')


def is_json(r) -> bool:
  try:
    return 'json' in (r.headers.get('Content-Type') or '') and isinstance(r.json(), dict)
  except Exception:
    return False


def describe_network_error(e: Exception) -> str:
  """Why a request did not reach a server, in a few words."""
  import requests
  message = str(e)
  if isinstance(e, requests.Timeout):
    return "timed out"
  if isinstance(e, requests.exceptions.SSLError):
    if 'CERTIFICATE_VERIFY_FAILED' in message:
      return "its TLS certificate is not trusted, see QABOARD_API_VERIFY"
    return "TLS error"
  lowered = message.lower()
  if 'refused' in lowered:
    return "connection refused"
  if any(s in lowered for s in ('name or service not known', 'nodename nor servname', 'getaddrinfo failed', 'name resolution', 'no address associated')):
    return "unknown host"
  if isinstance(e, requests.exceptions.InvalidURL) or isinstance(e, requests.exceptions.MissingSchema):
    return "invalid URL"
  return "connection failed"
