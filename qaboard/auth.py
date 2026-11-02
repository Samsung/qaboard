"""
Signing in to QA-Board servers: `qa auth login|status|logout|token`.

Sign-ins are saved per server in hosts.yaml, and the token sent to a server is chosen by `resolve_token`:
see qaboard/credentials.py.

`qa auth login` uses the OAuth 2.0 device authorization flow (RFC 8628), that works over SSH:
qa shows a code, the user approves it in a browser, anywhere.
"""
import os
import sys
import time
import socket
import datetime
from typing import Any, Dict, NamedTuple, NoReturn, Optional, Set
from urllib.parse import quote

import click

from .site_config import user_secrets, user_secrets_path  # noqa: F401 (resolve_token reads user_secrets)
from .credentials import ENV_TOKENS, WARNING_SHOWN_ENV, ACCESS_TOKENS_PAGE  # noqa: F401
from .credentials import normalize_url, hosts_path, read_hosts, find_login, saved_logins, write_hosts, save_login, forget_login  # noqa: F401
from .credentials import resolve_token, describe_source, json_body, refusal, fix_for, auth_error_hint  # noqa: F401
from .credentials import describe_body, is_json, describe_network_error

# (connect, read) timeouts for the requests `qa auth` sends
timeout = (30, 60)
LOGIN_HINT = "Run `qa auth login`."


_warnings_shown: Set[str] = set()

def first_time(message: str) -> bool:
  """
  Whether to print a warning about signing in: once per process. The runs `qa batch` starts
  inherit $QA_AUTH_WARNING_SHOWN once it printed one, and don't repeat them.
  """
  if message in _warnings_shown:
    return False
  if not _warnings_shown and os.environ.get(WARNING_SHOWN_ENV):
    return False
  _warnings_shown.add(message)
  os.environ[WARNING_SHOWN_ENV] = '1'
  return True


def print_server_warning(r):
  """Prints the X-QABoard-Warning header the server sends (e.g. for runs sent without a token), once."""
  try:
    warning = r.headers.get('X-QABoard-Warning')
  except Exception:
    return
  if not isinstance(warning, str) or not warning.strip() or not first_time(warning.strip()):
    return
  click.secho(f"WARNING: {warning.strip()}", fg='yellow', err=True)


def is_ci() -> bool:
  from .config import is_ci as ci  # read when called: tests patch it
  return bool(ci)


class Server(NamedTuple):
  url: str  # normalized, the key in hosts.yaml
  api_prefix: str
  where: Optional[str]  # what gives the URL: "--server", "$QABOARD_URL", "QABOARD_HOST from the site package"... None for the default

  def described(self) -> str:
    if self.where == '--server':
      return f"{self.url} (from --server)"
    if not self.where:
      return f"{self.url} (the default: QABOARD_URL is not set)"
    return f"{self.url} (from {self.where})"

  def setting(self) -> str:
    """The setting to fix when the URL is wrong."""
    if self.where == '--server':
      return "--server"
    return (self.where or 'QABOARD_URL').lstrip('$').split(' ')[0]

  def check_url(self) -> str:
    return "Check --server." if self.where == '--server' else f"Check {self.setting()} or --server."

  def is_url_right(self) -> str:
    return "Is the --server URL right?" if self.where == '--server' else f"Is {self.setting()} right?"

  def login_command(self) -> str:
    return f"qa auth login --server {self.url}" if self.where == '--server' else "qa auth login"


def server_api(server: Optional[str]) -> Server:
  """The server: --server, else the server qa sends results to. Without a scheme, --server prefers a server you signed in to."""
  from . import api
  if not server:
    return Server(normalize_url(api.qaboard_url, api.qaboard_protocol), api.api_prefix, api.qaboard_url_source)
  server = server.strip().rstrip('/')
  if '://' not in server:
    hosts = read_hosts()
    scheme = next((s for s in ('https', 'http') if find_login(hosts, normalize_url(server, s))[1]), api.qaboard_protocol)
    server = f"{scheme}://{server}"
  return Server(normalize_url(server), f"{server}/api/v1", '--server')


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
  return f"{r.status_code}: {describe_body(r)}"


class AuthError(Exception):
  def __init__(self, message: str, refused: Optional[Dict[str, Any]] = None):
    super().__init__(message)
    self.refused = refused


def fetch_me(server: Server, token: str) -> Dict[str, Any]:
  """GET /user/me/ with a token. Raises AuthError with a sentence for people if it can't tell who the token is."""
  import requests
  url = f"{server.api_prefix}/user/me/"
  try:
    r = request('GET', url, token)
  except requests.RequestException as e:
    raise AuthError(f"Could not reach QA-Board at {server.url} ({describe_network_error(e)}). {server.check_url()}")
  refused = refusal(r)
  if refused:
    raise AuthError(refused['error'], refused)
  wrong_url = server.is_url_right()
  if r.status_code >= 500:
    raise AuthError(f"Could not check the token: {url} answered {r.status_code} ({describe_body(r) or 'an empty body'}). QA-Board may be down: try again later.")
  if not is_json(r):
    raise AuthError(f"Could not check the token: {url} answered {r.status_code} ({describe_body(r) or 'an empty body'}), not QA-Board's API. {wrong_url}")
  if not r.ok:
    hint = f" {wrong_url}" if r.status_code in (404, 405) else ''
    raise AuthError(f"Could not check the token: {url} answered {describe_failure(r)}.{hint}")
  me = json_body(r)
  if 'is_authenticated' not in me:
    raise AuthError(f"Could not check the token: {url} didn't answer like QA-Board. {wrong_url}")
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


def device_flow(server: Server, open_browser: bool) -> Dict[str, Any]:
  """
  The OAuth 2.0 device authorization flow (RFC 8628): returns the server's
  {access_token, token_id, user_name, scopes, expires_at...} once the user approved the sign-in in a browser.
  """
  import requests
  hostname = socket.gethostname()
  url = f"{server.api_prefix}/auth/device/code"
  try:
    r = request('POST', url, json={"client_name": f"qa CLI on {hostname}", "hostname": hostname})
  except requests.RequestException as e:
    fail(f"Could not reach QA-Board at {server.url} ({describe_network_error(e)}). {server.check_url()}")
  if r.status_code in (404, 405):
    fail(f"{url} answered {r.status_code}: this QA-Board server doesn't support `qa auth login` yet (it needs to be upgraded), or {server.setting()} is wrong.\n"
         "If you have a token, use: echo \"$TOKEN\" | qa auth login --with-token")
  code = json_body(r)
  if not r.ok or not all(code.get(k) for k in ('device_code', 'user_code', 'verification_uri')):
    fail(f"Could not start the sign-in: {url} answered {describe_failure(r)}")
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
  click.secho("Waiting for you to approve the sign-in (Ctrl-C to cancel)...", dim=True, err=True)

  expired = "The code expired before the sign-in was approved. Run `qa auth login` again."
  url = f"{server.api_prefix}/auth/device/token"
  while True:
    time.sleep(interval)
    if time.monotonic() > deadline:
      fail(expired)
    try:
      r = request('POST', url, json={"device_code": code['device_code']})
    except requests.RequestException as e:
      # e.g. a network blip, or the server restarting: we keep trying until the code expires
      click.secho(f"WARNING: Could not reach QA-Board ({describe_network_error(e)}), trying again...", fg='yellow', dim=True, err=True)
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
      fail("The sign-in was denied in the browser.")
    if error == 'expired_token':
      fail(expired)
    fail(f"The sign-in failed: {url} answered {describe_failure(r)}")


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


def revoke(server: Server, login: Dict[str, Any], quiet: bool = False) -> bool:
  """Revokes a saved token on the server (DELETE /user/tokens/<id>, with the token itself). Returns whether it's revoked."""
  import requests
  token, token_id = login.get('token'), login.get('token_id')
  yourself = f"Revoke it in {ACCESS_TOKENS_PAGE}."
  def warn(message):
    if not quiet:
      click.secho(f"WARNING: {message} {yourself}", fg='yellow', err=True)
  if not token or token_id is None:
    warn("qa doesn't know the token's id, it could not revoke it.")
    return False
  url = f"{server.api_prefix}/user/tokens/{quote(str(token_id), safe='')}"
  try:
    r = request('DELETE', url, str(token))
  except requests.RequestException as e:
    warn(f"Could not revoke the token on the server ({describe_network_error(e)}).")
    return False
  if r.ok:
    if not quiet:
      click.echo("Revoked the token on the server.", err=True)
    return True
  refused = refusal(r)
  if refused and refused['reason'].startswith('token_'):
    if not quiet:
      click.echo(f"The token could already not be used: {refused['error']}", err=True)
    return True
  warn(f"Could not revoke the token on the server ({describe_failure(r)}).")
  return False


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
  srv = server_api(server)
  if not with_token and is_ci():
    fail(f"qa auth login needs a browser. In CI, set QABOARD_TOKEN ({ACCESS_TOKENS_PAGE}).")
  _, previous = find_login(read_hosts(), srv.url)
  try:
    token_id = None
    if with_token:
      token = read_token_from_stdin()
    else:
      approved = device_flow(srv, open_browser=not no_browser)
      token, token_id = approved['access_token'], approved.get('token_id')
    try:
      me = fetch_me(srv, token)
    except AuthError as e:
      if not e.refused:
        fail(str(e))
      if not with_token:
        fail(f"Could not check the new token: {e}")
      fix = f"Create a new token in {ACCESS_TOKENS_PAGE}." if e.refused['reason'].startswith('token_') else fix_for(e.refused)
      fail(f"The token was not accepted: {e}" + (f"\n{fix}" if fix else ''))
  except KeyboardInterrupt:
    click.echo("\nThe sign-in was cancelled.", err=True)
    raise click.exceptions.Exit(130)
  token_info = me.get('token') if isinstance(me.get('token'), dict) else {}
  token_id = token_info.get('id', token_id)
  try:
    save_login(srv.url, user=me['user_name'], token=token, token_id=token_id, minted_by='with-token' if with_token else 'device')
  except OSError as e:
    fail(f"Could not save the sign-in in {hosts_path()}: {e}")
  click.secho(f"Signed in to {srv.url} as {me['user_name']}.", fg='green', err=True)
  click.secho(f"The token is saved in {hosts_path()}", dim=True, err=True)
  # the token of the previous `qa auth login` is not needed anymore (best effort)
  if previous and previous.get('minted_by') == 'device' and previous.get('token') != token and previous.get('token_id') != token_id:
    if revoke(srv, previous, quiet=True):
      click.secho("Revoked the token of your previous sign-in.", dim=True, err=True)
  warn_env_token("qa uses it instead of this sign-in. Unset it to use this sign-in.")


def parse_time(value: Any) -> Optional[datetime.datetime]:
  if not isinstance(value, str) or not value:
    return None
  try:
    parsed = datetime.datetime.fromisoformat(value.strip().replace('Z', '+00:00'))
  except ValueError:
    return None
  return parsed if parsed.tzinfo else parsed.replace(tzinfo=datetime.timezone.utc)


def format_time(value: Any) -> str:
  """An ISO date as YYYY-MM-DD HH:MM in local time."""
  parsed = parse_time(value)
  return parsed.astimezone().strftime('%Y-%m-%d %H:%M') if parsed else str(value)


def time_ago(when: datetime.datetime, now: Optional[datetime.datetime] = None) -> str:
  seconds = ((now or datetime.datetime.now(datetime.timezone.utc)) - when).total_seconds()
  def plural(n, unit):
    return f"{n} {unit}{'s' if n != 1 else ''} ago"
  if seconds < 60:
    return "just now"
  if seconds < 3600:
    return plural(int(seconds // 60), 'minute')
  if seconds < 2 * 86400:
    return plural(int(seconds // 3600), 'hour')
  return plural(int(seconds // 86400), 'day')


def describe_expiry(token_info: Dict[str, Any]) -> str:
  """e.g. "2026-12-01 10:00", "after 180 days without use (last used 2 hours ago)", or "never"."""
  parts = []
  if token_info.get('expires_at'):
    parts.append(format_time(token_info['expires_at']))
  idle_days = token_info.get('idle_expiry_days')
  if isinstance(idle_days, int) and not isinstance(idle_days, bool) and idle_days > 0:
    last_used = parse_time(token_info.get('last_used_at'))
    used = f"last used {time_ago(last_used)}" if last_used else "not used yet"
    parts.append(f"after {idle_days} day{'s' if idle_days != 1 else ''} without use ({used})")
  return ', or '.join(parts) or 'never'


@auth.command()
@server_option
def status(server):
  """Show who you are signed in as, and the token qa uses. Exits with 1 if you are not signed in."""
  srv = server_api(server)
  token, source = resolve_token(srv.url)
  click.echo(f"QA-Board server: {srv.described()}")
  if not token:
    lines = [f"Not signed in to {srv.url}. Run `{srv.login_command()}`."]
    others = [(url, login_) for url, login_ in saved_logins() if url != srv.url]
    if others:
      lines.append("You are signed in to other servers:")
      lines.extend(f"  {url} as {login_.get('user') or '?'}" for url, login_ in others)
      lines.append("To use one, set QABOARD_URL to it, or add e.g. --server " + others[0][0])
    fail('\n'.join(lines))
  click.echo(f"  Token from: {describe_source(source)}")
  try:
    me = fetch_me(srv, token)
  except AuthError as e:
    if not e.refused:
      fail(f"  {e}")
    fix = fix_for(e.refused, source, ci=is_ci())
    fail(f"  The token was not accepted: {e}" + (f"\n  {fix}" if fix else ''))
  full_name = f" ({me['full_name']})" if me.get('full_name') else ''
  click.echo(f"  Signed in as: {me['user_name']}{full_name}")
  token_info = me.get('token')
  if isinstance(token_info, dict):
    prefix = f" ({token_info['prefix']}...)" if token_info.get('prefix') else ''
    click.echo(f"  Token: {token_info.get('name') or 'unnamed'}{prefix}")
    click.echo(f"  Scopes: {', '.join(token_info.get('scopes') or []) or 'none'}")
    if token_info.get('projects'):
      click.echo(f"  Projects: {', '.join(token_info['projects'])}")
    click.echo(f"  Expires: {describe_expiry(token_info)}")
  else:
    click.echo("  Token details: not available from this server (it may be an older version)")
  _, login_ = find_login(read_hosts(), srv.url)
  if login_ and source != 'hosts.yaml':
    click.secho(f"  Your sign-in in {hosts_path()} is not used, since a token comes from {describe_source(source)}.", fg='yellow')
  if source == 'secrets.yaml':
    click.secho(f"  Older way: run `qa auth login`, then remove QA_TOKEN from {user_secrets_path}.", fg='yellow')


@auth.command()
@server_option
@click.option('--revoke', 'force_revoke', is_flag=True, help="Also revoke a token you gave with --with-token. By default, qa only revokes the tokens `qa auth login` created.")
def logout(server, force_revoke):
  """Forget the token saved for the server, and revoke it if `qa auth login` created it."""
  srv = server_api(server)
  _, saved = find_login(read_hosts(), srv.url)
  if not saved:
    token, source = resolve_token(srv.url)
    if source in ENV_TOKENS:
      fail(f"The token comes from ${source}: `qa auth logout` can't remove it. Unset it (and revoke the token in {ACCESS_TOKENS_PAGE} if needed).")
    if source == 'secrets.yaml':
      fail(f"The token comes from {user_secrets_path}: remove QA_TOKEN from it (and revoke the token in {ACCESS_TOKENS_PAGE} if needed).")
    fail(f"Not signed in to {srv.url}.")

  # older hosts.yaml don't say who created the token: it may be used elsewhere, we keep it
  created_by_qa = saved.get('minted_by') == 'device'
  if created_by_qa or force_revoke:
    revoke(srv, saved)
  try:
    forget_login(srv.url)
  except OSError as e:
    fail(f"Could not remove the sign-in from {hosts_path()}: {e}")
  if not (created_by_qa or force_revoke):
    click.echo(f"Forgot the token. It still works: revoke it in {ACCESS_TOKENS_PAGE} if you no longer need it.", err=True)
  click.secho(f"Signed out of {srv.url}.", fg='green', err=True)
  warn_env_token("qa keeps using it.")


@auth.command()
@server_option
def token(server):
  """
  Print the token qa uses for the server, for scripts.

  For instance: curl -H "Authorization: Bearer $(qa auth token)" ...
  """
  srv = server_api(server)
  token, _ = resolve_token(srv.url)
  if not token:
    fail(f"Not signed in to {srv.url}. Run `{srv.login_command()}`.")
  click.echo(token)
