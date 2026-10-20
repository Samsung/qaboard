"""
Signing in to QA-Board servers: `qa auth login|status|logout|token`.

Logins are saved per server, not per project, in hosts.yaml in the user's config directory
(~/.config/qaboard, $XDG_CONFIG_HOME/qaboard, %APPDATA%\\qaboard on Windows), with mode 0600:
    https://qa.example:
      user: alice
      token: qab_pat_...
      token_id: 12
      created_at: '2026-10-20T08:00:00+00:00'

Requests to a server use the first token found (see `resolve_token`):
    $QABOARD_TOKEN > $QA_TOKEN (alias) > hosts.yaml's login for the server > QA_TOKEN in ~/.qaboard/secrets.yaml (legacy)

`qa auth login` uses the OAuth 2.0 device authorization flow (RFC 8628), that works over SSH:
qa shows a code, the user approves it in a browser, anywhere.
"""
import os
import sys
import time
import socket
import datetime
from pathlib import Path
from typing import Any, Dict, NoReturn, Optional, Set, Tuple
from urllib.parse import urlsplit, quote

import click
import yaml

from .site_config import user_config_dir, user_secrets, user_secrets_path, _load_secrets

# (connect, read) timeouts for the requests `qa auth` sends
timeout = (30, 60)
ENV_TOKENS = ('QABOARD_TOKEN', 'QA_TOKEN')
LOGIN_HINT = "Run `qa auth login` to sign in."


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


def hosts_path() -> Path:
  return user_config_dir() / 'hosts.yaml'


def read_hosts() -> Dict[str, Any]:
  hosts = _load_secrets(hosts_path(), check_permissions=True)
  return hosts if isinstance(hosts, dict) else {}


def find_login(hosts: Dict[str, Any], server_url: str) -> Tuple[Optional[str], Optional[Dict[str, Any]]]:
  """The key and the saved login for a server. Keys edited by hand may not be normalized."""
  for key, login in hosts.items():
    try:
      if normalize_url(str(key)) == server_url and isinstance(login, dict):
        return key, login
    except ValueError:
      continue
  return None, None


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


def save_login(server_url: str, user: str, token: str, token_id: Any = None):
  hosts = read_hosts()
  key, _ = find_login(hosts, server_url)
  if key is not None:
    del hosts[key]
  hosts[server_url] = {
    'user': user,
    'token': token,
    'token_id': token_id,
    'created_at': datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds'),
  }
  write_hosts(hosts)


def forget_login(server_url: str):
  hosts = read_hosts()
  key, _ = find_login(hosts, server_url)
  if key is not None:
    del hosts[key]
    write_hosts(hosts)


def resolve_token(server_url: Optional[str]) -> Tuple[Optional[str], Optional[str]]:
  """
  The token to send to a server, and where it comes from: QABOARD_TOKEN or QA_TOKEN (environment variables),
  hosts.yaml or secrets.yaml (the legacy ~/.qaboard/secrets.yaml). (None, None) without a token.
  """
  for name in ENV_TOKENS:
    token = os.environ.get(name, '').strip()
    if token:
      return token, name
  if server_url:
    try:
      _, login = find_login(read_hosts(), normalize_url(server_url))
    except ValueError:
      login = None
    if login and login.get('token'):
      return str(login['token']).strip(), 'hosts.yaml'
  token = str(user_secrets.get('QA_TOKEN') or '').strip()
  if token:
    return token, 'secrets.yaml'
  return None, None


def describe_source(source: Optional[str]) -> str:
  if source in ENV_TOKENS:
    return f"the {source} environment variable"
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


_warnings_shown: Set[str] = set()

def print_server_warning(r):
  """Prints the X-QABoard-Warning header the server sends (e.g. for runs sent without a token), once per process."""
  try:
    warning = r.headers.get('X-QABoard-Warning')
  except Exception:
    return
  if not isinstance(warning, str) or not warning.strip() or warning in _warnings_shown:
    return
  _warnings_shown.add(warning)
  click.secho(f"WARNING: {warning.strip()}", fg='yellow', err=True)


def auth_error_hint(r, token_source: Optional[str] = None) -> Optional[str]:
  """
  For a 401 or 403 that says why (`reason`), the server's sentence and what to do. None otherwise:
  callers keep their usual error handling, e.g. for older servers.
  """
  if getattr(r, 'status_code', None) not in (401, 403):
    return None
  body = json_body(r)
  reason, error = body.get('reason'), body.get('error')
  if not isinstance(reason, str):
    return None
  sentence = error.strip() if isinstance(error, str) and error.strip() else f"QA-Board refused the request ({r.status_code} {reason})."
  if reason.startswith('token_'):
    if token_source in ENV_TOKENS:
      fix = f"The token comes from ${token_source}: replace it, or unset it and run `qa auth login`."
    else:
      fix = "Run `qa auth login` to get a new token."
  elif reason == 'sign_in_required':
    fix = LOGIN_HINT
  elif reason == 'ingest_token_required':
    fix = "Run `qa auth login`, or in CI set QABOARD_TOKEN (e.g. to a service account's token)."
  else:
    fix = None
  return f"{sentence}\n{fix}" if fix else sentence


def nudge_unverified(user: str):
  """Says once a day how to sign runs, for runs sent without a token. Only when it can remember it did."""
  try:
    path = user_config_dir() / 'last-auth-nudge'
    now = time.time()
    try:
      last = float(path.read_text().strip())
    except (OSError, ValueError):
      last = 0
    if 0 <= now - last < 24 * 3600:
      return
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    path.write_text(f"{now}\n")
  except Exception:
    return
  click.secho(f"Your runs are saved as unverified '{user}'. Run `qa auth login` to sign them.", fg='yellow', err=True)


def server_api(server: Optional[str]) -> Tuple[str, str]:
  """The server's URL (normalized) and its API's prefix: --server, else the server qa sends results to."""
  from . import api
  if not server:
    return normalize_url(api.qaboard_url, api.qaboard_protocol), api.api_prefix
  server = server.strip().rstrip('/')
  if '://' not in server:
    server = f"{api.qaboard_protocol}://{server}"
  return normalize_url(server), f"{server}/api/v1"


def request(method: str, url: str, token: Optional[str] = None, **kwargs):
  import requests
  from .api import api_verify
  headers = {'Accept': 'application/json'}
  if token:
    headers['Authorization'] = f"Bearer {token}"
  r = requests.request(method, url, headers=headers, verify=api_verify, timeout=timeout, **kwargs)
  print_server_warning(r)
  return r


def describe_failure(r) -> str:
  error = json_body(r).get('error_description') or json_body(r).get('error')
  return f"{r.status_code}: {error if isinstance(error, str) else r.text[:300]}"


class AuthError(Exception):
  pass


def fetch_me(api_prefix: str, token: str) -> Dict[str, Any]:
  """GET /user/me/ with a token. Raises AuthError with a sentence for people if the server doesn't accept it."""
  import requests
  url = f"{api_prefix}/user/me/"
  try:
    r = request('GET', url, token)
  except requests.RequestException as e:
    raise AuthError(f"Could not reach QA-Board at {url}: {e}")
  if r.status_code in (401, 403):
    error = json_body(r).get('error')
    raise AuthError(error if isinstance(error, str) and error else "QA-Board did not accept the token.")
  if not r.ok:
    raise AuthError(f"QA-Board answered {describe_failure(r)}")
  me = json_body(r)
  # older servers answer 200 even when they ignore the token
  if not me.get('is_authenticated') or not me.get('user_name'):
    raise AuthError("QA-Board did not accept the token.")
  return me


def fail(message: str, code: int = 1) -> NoReturn:
  click.secho(message, fg='red', err=True)
  raise click.exceptions.Exit(code)


def warn_env_token(message: str):
  for name in ENV_TOKENS:
    if os.environ.get(name, '').strip():
      click.secho(f"WARNING: ${name} is set: {message}", fg='yellow', err=True)
      return


def can_open_browser() -> bool:
  """Whether a browser would show up in front of the user: not over SSH, and on Linux only with a display."""
  if any(os.environ.get(v) for v in ('SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY')):
    return False
  if sys.platform == 'darwin' or os.name == 'nt':
    return True
  return bool(os.environ.get('DISPLAY') or os.environ.get('WAYLAND_DISPLAY'))


def device_flow(api_prefix: str, open_browser: bool) -> Dict[str, Any]:
  """
  The OAuth 2.0 device authorization flow (RFC 8628): returns the server's
  {access_token, token_id, user_name, scopes, expires_at...} once the user approved the login in a browser.
  """
  import requests
  hostname = socket.gethostname()
  url = f"{api_prefix}/auth/device/code"
  try:
    r = request('POST', url, json={"client_name": f"qa CLI on {hostname}", "hostname": hostname})
  except requests.RequestException as e:
    fail(f"Could not reach QA-Board at {url}: {e}")
  if r.status_code in (404, 405):
    fail("This QA-Board server doesn't support `qa auth login` yet (it needs to be upgraded).\n"
         "If you have a token, use: echo \"$TOKEN\" | qa auth login --with-token")
  code = json_body(r)
  if not r.ok or not all(code.get(k) for k in ('device_code', 'user_code', 'verification_uri')):
    fail(f"Could not start the login: QA-Board answered {describe_failure(r)}")
  interval = float(code.get('interval') or 5)
  deadline = time.monotonic() + float(code.get('expires_in') or 900)
  complete_uri = code.get('verification_uri_complete')

  click.echo(err=True)
  click.secho(f"Your one-time code: {code['user_code']}", bold=True, err=True)
  click.echo(f"To sign in, open {code['verification_uri']} and enter the code", err=True)
  if complete_uri:
    click.echo(f"or open: {complete_uri}", err=True)
  click.echo(err=True)
  if open_browser and can_open_browser():
    import webbrowser
    try:
      if webbrowser.open(complete_uri or code['verification_uri']):
        click.echo("Opened your browser.", err=True)
    except Exception:
      pass
  click.secho("Waiting for you to approve the login (Ctrl-C to cancel)...", dim=True, err=True)

  expired = "The code expired before the login was approved. Run `qa auth login` again."
  url = f"{api_prefix}/auth/device/token"
  while True:
    time.sleep(interval)
    if time.monotonic() > deadline:
      fail(expired)
    try:
      r = request('POST', url, json={"device_code": code['device_code']})
    except requests.RequestException as e:
      # e.g. a network blip, or the server restarting: we keep trying until the code expires
      click.secho(f"WARNING: Could not reach QA-Board: {e}", fg='yellow', dim=True, err=True)
      continue
    if r.status_code >= 500:
      continue
    body = json_body(r)
    if r.ok and body.get('access_token'):
      return body
    error = body.get('error')
    if error == 'authorization_pending':
      continue
    if error == 'slow_down':
      interval += 5
      continue
    if error == 'access_denied':
      fail("The login was denied in the browser.")
    if error == 'expired_token':
      fail(expired)
    fail(f"The login failed: QA-Board answered {describe_failure(r)}")


def read_token_from_stdin() -> str:
  if sys.stdin.isatty():
    token = click.prompt("Paste your token", hide_input=True, err=True)
  else:
    token = sys.stdin.read()
  token = token.strip()
  if not token:
    fail("No token was given on stdin. Usage: echo \"$TOKEN\" | qa auth login --with-token")
  if any(c.isspace() for c in token):
    fail("The token can't have spaces or several lines: expected something like qab_pat_...")
  return token


server_option = click.option('--server', help="The QA-Board server, e.g. https://qa.example. By default, the server qa sends results to.")


@click.group()
def auth():
  """Sign in to QA-Board, so that runs you send are signed as yours."""
  pass


@auth.command()
@server_option
@click.option('--with-token', is_flag=True, help="Read a token from stdin instead of signing in with a browser, e.g. `echo \"$TOKEN\" | qa auth login --with-token`.")
@click.option('--no-browser', is_flag=True, help="Don't try to open a browser, only print where to sign in.")
def login(server, with_token, no_browser):
  """Sign in with a browser (it can be on another computer), and save a token for the server."""
  server_url, api_prefix = server_api(server)
  try:
    token_id = None
    if with_token:
      token = read_token_from_stdin()
    else:
      approved = device_flow(api_prefix, open_browser=not no_browser)
      token, token_id = approved['access_token'], approved.get('token_id')
    try:
      me = fetch_me(api_prefix, token)
    except AuthError as e:
      fail(f"The token was not accepted: {e}" if with_token else f"Could not check the new token: {e}")
  except KeyboardInterrupt:
    click.echo("\nThe login was cancelled.", err=True)
    raise click.exceptions.Exit(130)
  token_info = me.get('token') if isinstance(me.get('token'), dict) else {}
  token_id = token_info.get('id', token_id)
  try:
    save_login(server_url, user=me['user_name'], token=token, token_id=token_id)
  except OSError as e:
    fail(f"Could not save the login in {hosts_path()}: {e}")
  click.secho(f"Logged in to {server_url} as {me['user_name']}.", fg='green', err=True)
  click.secho(f"The token is saved in {hosts_path()}", dim=True, err=True)
  warn_env_token("qa uses it instead of this login. Unset it to use this login.")


@auth.command()
@server_option
def status(server):
  """Show who you are signed in as, and the token qa uses. Exits with 1 if you are not signed in."""
  server_url, api_prefix = server_api(server)
  token, source = resolve_token(server_url)
  click.echo(f"QA-Board server: {server_url}")
  if not token:
    fail(f"Not logged in. {LOGIN_HINT}")
  click.echo(f"  Token from: {describe_source(source)}")
  try:
    me = fetch_me(api_prefix, token)
  except AuthError as e:
    fail(f"  The token was not accepted: {e}\n  " + (f"Replace or unset ${source}." if source in ENV_TOKENS else "Run `qa auth login` to get a new token."))
  full_name = f" ({me['full_name']})" if me.get('full_name') else ''
  click.echo(f"  Logged in as: {me['user_name']}{full_name}")
  token_info = me.get('token')
  if isinstance(token_info, dict):
    prefix = f" ({token_info['prefix']}...)" if token_info.get('prefix') else ''
    click.echo(f"  Token: {token_info.get('name') or 'unnamed'}{prefix}")
    click.echo(f"  Scopes: {', '.join(token_info.get('scopes') or []) or 'none'}")
    if token_info.get('projects'):
      click.echo(f"  Projects: {', '.join(token_info['projects'])}")
    click.echo(f"  Expires: {token_info.get('expires_at') or 'never'}")
  else:
    click.echo("  Token details: not available from this server (it may be an older version)")
  _, login_ = find_login(read_hosts(), server_url)
  if login_ and source != 'hosts.yaml':
    click.secho(f"  Your login in {hosts_path()} is not used, since a token comes from {describe_source(source)}.", fg='yellow')


@auth.command()
@server_option
def logout(server):
  """Revoke the token saved for the server, and forget it."""
  import requests
  server_url, api_prefix = server_api(server)
  _, saved = find_login(read_hosts(), server_url)
  if not saved:
    token, source = resolve_token(server_url)
    if source in ENV_TOKENS:
      fail(f"The token comes from ${source}: `qa auth logout` can't remove it. Unset it (and revoke the token in the web app if needed).")
    if source == 'secrets.yaml':
      fail(f"The token comes from {user_secrets_path}: remove QA_TOKEN from it (and revoke the token in the web app if needed).")
    fail(f"Not logged in to {server_url}.")

  token, token_id = saved.get('token'), saved.get('token_id')
  revoke_yourself = "Revoke it in the web app, in Settings > Access tokens."
  if token and token_id is not None:
    url = f"{api_prefix}/user/tokens/{quote(str(token_id), safe='')}"
    try:
      r = request('DELETE', url, token)
      if r.ok:
        click.echo("Revoked the token on the server.", err=True)
      elif r.status_code == 401 and str(json_body(r).get('reason', '')).startswith('token_'):
        click.echo(f"The token could already not be used: {json_body(r).get('error') or json_body(r)['reason']}", err=True)
      else:
        click.secho(f"WARNING: Could not revoke the token on the server ({describe_failure(r)}). {revoke_yourself}", fg='yellow', err=True)
    except requests.RequestException as e:
      click.secho(f"WARNING: Could not revoke the token on the server ({e}). {revoke_yourself}", fg='yellow', err=True)
  else:
    click.secho(f"WARNING: qa doesn't know the token's id, it could not revoke it. {revoke_yourself}", fg='yellow', err=True)
  try:
    forget_login(server_url)
  except OSError as e:
    fail(f"Could not remove the login from {hosts_path()}: {e}")
  click.secho(f"Logged out of {server_url}.", fg='green', err=True)
  warn_env_token("qa keeps using it.")


@auth.command()
@server_option
def token(server):
  """
  Print the token qa uses for the server, for scripts.

  For instance: curl -H "Authorization: Bearer $(qa auth token)" ...
  """
  server_url, _ = server_api(server)
  token, _ = resolve_token(server_url)
  if not token:
    fail(f"Not logged in to {server_url}. {LOGIN_HINT}")
  click.echo(token)
