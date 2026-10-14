"""
What all git hosts have in common. Each type of host (GitLab, GitHub...) refines it in its own module.
"""
import re
import copy
import hmac
import base64
import hashlib
from urllib.parse import urlparse, quote

import requests

from ..git_utils import check_project_path


def hostname_of(url):
  """
  The hostname in a web or clone URL, or a bare hostname:
    https://gitlab.example.com:8080/group/repo  => gitlab.example.com
    git@github.com:org/repo.git                 => github.com
    gitlab-srv                                  => gitlab-srv
  """
  if not url:
    return None
  url = str(url).strip()
  if '://' in url:
    try:
      hostname = urlparse(url).hostname
    except ValueError:
      return None
    return hostname.lower() if hostname else None
  # scp-like ssh remotes (git@host:path), host:port, host/path
  match = re.match(r'(?:[^@/\s]+@)?([^:/@\s]+)', url)
  return match.group(1).lower() if match else None


def gravatar_url(email):
  # https://docs.gravatar.com/api/avatars/images/
  email_hash = hashlib.sha256(email.strip().lower().encode()).hexdigest()
  # d=404: no default picture, so that the web app shows the person's initials instead
  return f"https://www.gravatar.com/avatar/{email_hash}?d=404"


def hmac_sha256(secret, body):
  return hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()

def same_secret(received, expected):
  return hmac.compare_digest((received or '').encode(), expected.encode())


def is_email(email):
  # GitLab redacts some emails as "[REDACTED]"
  return isinstance(email, str) and '@' in email


def branch_from_ref(ref):
  """refs/heads/feature/x => feature/x, refs/tags/v1.0 => v1.0"""
  return re.sub(r'^refs/(heads|tags)/', '', ref or '')


class CredentialsStayOnHost(requests.Session):
  """
  Follows redirects, but only sends credentials to the host of the first URL.
  requests only removes the Authorization header when redirected to another host, and only compares
  with the previous hop: tokens in other headers (GitLab's Private-Token) and cookies would be sent along.
  """
  def __init__(self, url, sensitive_headers=()):
    super().__init__()
    self.origin_url = url
    self.sensitive_headers = {'Authorization', 'Cookie', 'Private-Token', *sensitive_headers}

  def rebuild_auth(self, prepared_request, response):
    super().rebuild_auth(prepared_request, response)
    # like requests, we allow http => https on the same host
    if self.should_strip_auth(self.origin_url, prepared_request.url):
      for header in self.sensitive_headers:
        prepared_request.headers.pop(header, None)


def request_keeping_credentials_on_host(method, url, sensitive_headers=(), **kwargs):
  """Like requests.request, but tokens (headers, cookies) are not sent to other hosts when redirected."""
  with CredentialsStayOnHost(url, sensitive_headers) as session:
    return session.request(method, url, **kwargs)


class GitHost:
  """
  A git server, e.g. https://github.com or https://gitlab.example.com.
  Tokens are only ever sent to `url` and `api_url`: we match repositories to hosts by hostname,
  and build clone URLs and API calls from the host's own configuration, never from the repository's URL.
  """
  type = 'generic'
  # Our endpoint for push webhooks is /webhook/<webhook>, if the host has webhooks
  webhook = None
  # When the token is not of the form "user:password", the user name for clone URLs
  token_user = 'oauth2'
  # Avatars from usernames, formatted with {url} and {username}
  default_user_avatar_url = None

  def __init__(self, url, token='', webhook_secret='', api_url=None, hostnames=(), name=None, user_avatar_url=None):
    url = str(url or '').strip().rstrip('/')
    parsed = urlparse(url)
    if parsed.scheme not in ('http', 'https') or not parsed.hostname:
      raise ValueError(f"Invalid git host URL: {url!r}, expected e.g. https://gitlab.example.com")
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
      raise ValueError(f"Invalid git host URL: {url!r}. Give credentials with `token`.")
    self.url = url
    self.hostname = parsed.hostname.lower()
    # Other names of the host, e.g. used in ssh remotes or by a reverse proxy. Only used to recognize repositories.
    self.hostnames = {self.hostname, *[hostname_of(h) for h in hostnames if hostname_of(h)]}
    self.token = token or ''
    self.webhook_secret = webhook_secret or ''
    self._api_url = api_url
    self.api_url = (api_url or self.default_api_url() or '').rstrip('/') or None
    self.name = name or self.hostname
    self.user_avatar_url = user_avatar_url or self.default_user_avatar_url
    # Hosts from QABOARD_GITHUB_HOSTS have no scheme: we use the one of the repositories' web_url (see GitHosts.for_repo)
    self.scheme_from_repositories = False

  def with_scheme(self, scheme):
    """The same host, at e.g. http:// instead of https://"""
    if self.url.startswith(f"{scheme}://"):
      return self
    host = copy.copy(self)
    host.url = f"{scheme}://{self.url.split('://', 1)[1]}"
    host.api_url = (self._api_url or host.default_api_url() or '').rstrip('/') or None
    return host

  def __repr__(self):
    # Never show the token: it's used as a cache key...
    return f"<{self.__class__.__name__} {self.url}>"

  def default_api_url(self):
    return None

  def public(self):
    """What the web app may know about the host."""
    return {"type": self.type, "url": self.url, "name": self.name}

  def matches(self, url):
    """Is this URL (web or clone URL, or hostname) on this host?"""
    return hostname_of(url) in self.hostnames


  # ==========================================
  # Repositories
  # ==========================================

  def clone_url(self, path):
    """URL to clone a repository. It has no credentials: they're given by `git_env`."""
    check_project_path(path)
    return f"{self.url}/{path}"

  def git_env(self):
    """
    Environment variables for git commands, that authenticate us with the host's token.
    Unlike credentials in clone URLs, they are not saved in the clones' .git/config or shown in errors.

    git asks its credential helpers for a password when the host answers "401 Unauthorized", and only uses
    the helpers configured for the URL it is talking to. When the host redirects git to another host, git
    talks to that host from then on (http.followRedirects=initial): it doesn't get the token.
    (A http.<url>.extraHeader would be sent there: git reads its config once, for the first URL.)
    Redirects on the same host keep working, e.g. GitHub's for renamed repositories, or http => https.
    """
    if not self.token:
      return {}
    user, password = self.credentials()
    # https://git-scm.com/docs/gitcredentials (git>=2.31 for GIT_CONFIG_COUNT)
    helper = '!f() { test "$1" = get && printf "username=%s\\npassword=%s\\n" "$QABOARD_GIT_USERNAME" "$QABOARD_GIT_PASSWORD"; }; f'
    urls = [self.url]
    parsed = urlparse(self.url)
    if parsed.scheme == 'http' and parsed.port in (None, 80):
      urls.append(f"https://{parsed.hostname}{parsed.path}")
    config = [
      ("credential.helper", ""), # resets the list: other helpers (e.g. "store") could save the token on disk
      *[(f"credential.{url}.helper", helper) for url in urls],
    ]
    env = {"GIT_CONFIG_COUNT": str(len(config))}
    for i, (key, value) in enumerate(config):
      env[f"GIT_CONFIG_KEY_{i}"] = key
      env[f"GIT_CONFIG_VALUE_{i}"] = value
    return {
      **env,
      "QABOARD_GIT_USERNAME": user,
      "QABOARD_GIT_PASSWORD": password,
      "GIT_TERMINAL_PROMPT": "0",
    }

  def credentials(self):
    """(user, password) for git"""
    return tuple(self.token.split(':', 1)) if ':' in self.token else (self.token_user, self.token)

  def redact(self, text):
    """Removes our token from e.g. error messages."""
    if not self.token:
      return text
    user, password = self.credentials()
    basic = base64.b64encode(f"{user}:{password}".encode()).decode()
    for secret in (self.token, password, basic, quote(self.token, safe=''), quote(password, safe='')):
      text = text.replace(secret, '***')
    return text


  # ==========================================
  # API
  # ==========================================

  def api_headers(self):
    return {"Authorization": f"Bearer {self.token}"} if self.token else {}

  def api(self, method, path, **kwargs):
    """Calls the host's REST API, e.g. host.api('GET', '/repos/org/repo')"""
    if not self.api_url:
      raise ValueError(f"No API for {self}")
    headers = {**self.api_headers(), **kwargs.pop('headers', {})}
    kwargs.setdefault('timeout', 30)
    return request_keeping_credentials_on_host(method, f"{self.api_url}{path}", headers=headers, sensitive_headers=self.api_headers(), **kwargs)


  # ==========================================
  # Webhooks
  # ==========================================

  @classmethod
  def is_webhook_authentic(cls, headers, body, secret):
    """Did the webhook prove it knows the secret? Without a secret we accept everything."""
    if not secret:
      return True
    return cls.check_webhook_secret(headers, body, secret)

  @classmethod
  def repository_url(cls, payload):
    """The web URL of the repository a webhook is about, to know which host sent it (and its secret)."""
    return None

  @classmethod
  def check_webhook_secret(cls, headers, body, secret):
    return False

  @classmethod
  def is_push(cls, payload, headers):
    """Is the webhook a push event? Cheap: we call it before checking the webhook's secret."""
    return True

  @classmethod
  def parse_push(cls, payload, headers):
    """
    Normalizes a push webhook. Returns None for other events (e.g. "ping"), or:
      {
        "ref": "refs/heads/main",
        "checkout_sha": "<sha>",  # None when the branch was deleted
        "project": {...},          # the repository, stored in Project.data['git'], see git_hosts/__init__.py
        "committers": [{"name", "email", "username", "avatar_url"}...],  # to show avatars
      }
    Raises KeyError/TypeError/ValueError for malformed payloads.
    """
    raise ValueError(f"{cls.type} hosts have no push webhooks")

  def describe(self, git):
    """Adds the host to a repository's data."""
    return {**git, "hosting_type": self.type, "host": self.url}


  # ==========================================
  # Avatars
  # ==========================================

  def avatar_url(self, name, committer=None):
    """
    The avatar of a commit's author. We show lists of commits, so it must be fast: no network calls.
    committer: what we learned about them from webhooks: {email, username, avatar_url, host}
    """
    committer = committer or {}
    if committer.get('avatar_url'):
      return committer['avatar_url']
    # usernames are only meaningful on the host where we saw them
    if committer.get('username') and self.user_avatar_url and committer.get('host') == self.url:
      return self.user_avatar_url.format(url=self.url, username=quote(committer['username']))
    return default_avatar_url(committer)


def default_avatar_url(committer):
  if is_email((committer or {}).get('email')):
    return gravatar_url(committer['email'])
  return ''
