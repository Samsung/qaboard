"""
Git hosts: where the projects' repositories live (GitLab, GitHub, Gitea/Forgejo, Bitbucket, or any git server).
We clone the repositories, receive their push webhooks, link to them, show avatars and talk to their CI.

Configuration
-------------
QABOARD_GIT_HOSTS is a JSON list, or the path to a JSON/YAML file with the list:
  [
    {"type": "github", "url": "https://github.com", "token": "ghp_..."},
    {"type": "gitlab", "url": "https://gitlab.example.com", "token_env": "GITLAB_ACCESS_TOKEN", "webhook_secret": "..."}
  ]
  - type: gitlab, github, gitea (or forgejo), bitbucket, generic
  - url: the host's web URL
  - token (or token_env, the name of a variable with the token): to clone and call the API.
    Use "user:password" if the host needs a user name (e.g. Bitbucket app passwords).
  - webhook_secret (or webhook_secret_env): the secret its webhooks send. Default: QABOARD_WEBHOOK_SECRET
  - api_url: if it's not the usual one for this type of host (e.g. https://api.github.com)
  - hostnames: other names of the host, to recognize repository URLs, e.g. an ssh alias
  - name: shown to users
  - user_avatar_url: users' avatars, with {url} and {username}
    (defaults: {url}/{username}.png for GitHub, {url}/user/avatar/{username}/-1 for Gitea/Forgejo).
    For GitLab, only for users who didn't upload an avatar. Default: QABOARD_AVATAR_URL (with {user_name})

Backward compatible with the variables we used before:
  - GITLAB_HOST and GITLAB_ACCESS_TOKEN. GITLAB_HOST defaults to https://gitlab.com if QABOARD_GIT_HOSTS isn't set either.
    Without a scheme, we use https://. Credentials in the URL are used if there's no GITLAB_ACCESS_TOKEN.
    QABOARD_GITLAB_HOSTS (comma-separated): hostnames are other names of GITLAB_HOST (e.g. an alias),
    URLs (with a scheme) are other GitLab servers that may receive GITLAB_ACCESS_TOKEN.
  - github.com, with GITHUB_ACCESS_TOKEN.
    QABOARD_GITHUB_HOSTS: GitHub Enterprise hosts that may receive GITHUB_ACCESS_TOKEN (comma-separated).
    Without a scheme, we use the scheme of the repositories' web_url (https by default).
  If QABOARD_GIT_HOSTS lists those hosts without a token, they get those tokens.
The default host, for projects we know nothing about, is GITLAB_HOST if set, else the first in QABOARD_GIT_HOSTS.

The server reads tokens and webhook secrets from its environment only, not from the CLI's shared secrets (QA_SECRETS):
they may have e.g. a CI token that is not meant for the server. Other settings can also come from the site package.
Invalid settings don't stop the server (or migrations): we log them, ignore what's invalid,
and refuse webhooks until they're fixed (see `GitHosts.errors`).

Repository data
---------------
Push webhooks store the repository in Project.data['git'], with the same keys for all hosts:
  {
    "hosting_type": "github",           # gitlab, github, gitea, bitbucket, generic
    "host": "https://github.com",       # the host's url, as listed in /api/v1/config's `git_hosts`
    "path_with_namespace": "org/repo",  # the repository, also the id of the root QA-Board project
    "web_url": "https://github.com/org/repo",
    "name": "repo",
    "description": "...",
    "avatar_url": "https://...",        # the project's (or GitHub owner's) avatar
    "default_branch": "main",
    "namespace": "org",
    "git_http_url": "...", "git_ssh_url": "...",
  }
GitLab projects keep all the other fields of GitLab's push events (id, visibility_level...).
Projects created by the CLI, or before hosts were configurable, can lack some of those keys:
use `git_hosts.for_repo(git)` to know their host.
"""
import os
import sys
import json
from pathlib import Path
from urllib.parse import urlparse, unquote

import yaml

from .base import GitHost, default_avatar_url, hostname_of
from .gitlab import GitLabHost
from .github import GitHubHost
from .gitea import GiteaHost
from .bitbucket import BitbucketHost
from . import committers


HOST_TYPES = {
  'gitlab': GitLabHost,
  'github': GitHubHost,
  'gitea': GiteaHost,
  'forgejo': GiteaHost,
  'bitbucket': BitbucketHost,
  'generic': GitHost,
}


class UntrustedHost(ValueError):
  pass


class GitHosts:
  """The git hosts we know about."""

  def __init__(self, hosts, default, webhook_secret='', errors=()):
    self.hosts = list(hosts)
    self.default = default
    self.webhook_secret = webhook_secret
    # Invalid settings. We ignored them, but we don't know which webhook secrets were meant: we refuse webhooks.
    self.errors = list(errors)

  def __iter__(self):
    return iter(self.hosts)

  def __repr__(self):
    return f"<GitHosts {self.hosts}>"

  def public(self):
    return [h.public() for h in self.hosts]

  def has_webhook_secrets(self):
    """
    If any host has a webhook secret, webhooks from hosts without one are refused:
    otherwise anyone could send a push event that claims a repository is on such a host.
    """
    return bool(self.webhook_secret) or any(h.webhook_secret for h in self.hosts)

  def find(self, url, type=None):
    """The host of a URL or hostname."""
    if type:
      type = HOST_TYPES[type].type if type in HOST_TYPES else type
    return next((h for h in self.hosts if h.matches(url) and (not type or h.type == type)), None)

  def of_type(self, type):
    if self.default.type == type:
      return self.default
    return next((h for h in self.hosts if h.type == type), None)

  def for_repo(self, git=None, project_url=None):
    """
    The host of a repository, from its Project.data['git'] (see above).
    project_url: from qaboard.yaml, for projects that have no git data.
    If data['git']['host'] is not configured anymore, we look at its web_url, then use the default host of its type.
    """
    git = git or {}
    hosting_type = git.get('hosting_type')
    for url in (git.get('host'), git.get('web_url'), project_url):
      host = self.find(url, hosting_type) if isinstance(url, str) and url else None
      if host:
        return self.with_scheme_of(host, git.get('web_url'))
    if git.get('web_url') and hosting_type not in (None, 'gitlab'):
      raise UntrustedHost(f"Unknown {hosting_type} host: {git['web_url']}. Add it to QABOARD_GIT_HOSTS.")
    # Before hosts were configurable, all repositories were on GITLAB_HOST, except GitHub's.
    host = self.of_type(hosting_type) if hosting_type else self.default
    if not host:
      raise UntrustedHost(f"No {hosting_type} host is configured. Add one to QABOARD_GIT_HOSTS.")
    return host

  def with_scheme_of(self, host, web_url):
    """Hosts from QABOARD_GITHUB_HOSTS use the scheme of their repositories, like before."""
    if not host.scheme_from_repositories or not isinstance(web_url, str) or not web_url.startswith('http://'):
      return host
    return host.with_scheme('http')

  def describe(self, git, project_url=None):
    """Adds hosting_type and host to a repository's data (if we know its host)."""
    try:
      return self.for_repo(git, project_url).describe(git or {})
    except UntrustedHost:
      return git


def read_hosts_config(value):
  """QABOARD_GIT_HOSTS: a JSON list, or the path to a JSON/YAML file"""
  if not value:
    return []
  if isinstance(value, list):
    return value
  value = value.strip()
  try:
    if value.startswith(('[', '{')):
      hosts = json.loads(value)
    else:
      with Path(value).expanduser().open() as f:
        hosts = yaml.safe_load(f) or []
  except (OSError, ValueError, yaml.YAMLError) as e:
    raise ValueError(f"Could not read QABOARD_GIT_HOSTS: {e}")
  if not isinstance(hosts, list) or not all(isinstance(h, dict) for h in hosts):
    raise ValueError("QABOARD_GIT_HOSTS should be a list of {type, url, ...}")
  return hosts


def make_host(entry, get_secret):
  entry = dict(entry)
  type = entry.pop('type', None)
  if type not in HOST_TYPES:
    raise ValueError(f"QABOARD_GIT_HOSTS: unknown type {type!r}, expected one of {', '.join(HOST_TYPES)}")
  for key in ('token', 'webhook_secret'):
    variable = entry.pop(f'{key}_env', None)
    if variable and not entry.get(key):
      entry[key] = get_secret(variable, '')
  if isinstance(entry.get('hostnames'), str):
    entry['hostnames'] = [entry['hostnames']]
  try:
    return HOST_TYPES[type](**entry)
  except TypeError as e:
    raise ValueError(f"QABOARD_GIT_HOSTS: invalid entry for {entry.get('url')}: {e}")


def legacy_url(name, value):
  """
  GITLAB_HOST & co. Like before, we accept hostnames without a scheme (we use https), and credentials in the URL.
  Returns (url, "user:password" or None)
  """
  value = str(value).strip().rstrip('/')
  if '://' not in value:
    print(f"WARNING: {name}={value} has no scheme, we use https://{value}", file=sys.stderr)
    value = f"https://{value}"
  try:
    parsed = urlparse(value)
    port = parsed.port
  except ValueError as e:
    raise ValueError(f"Invalid {name}: {value!r} ({e})")
  credentials = None
  if parsed.username or parsed.password:
    credentials = f"{unquote(parsed.username or '')}:{unquote(parsed.password or '')}"
    value = parsed._replace(netloc=f"{parsed.hostname}{f':{port}' if port else ''}").geturl()
  return value, credentials


def server_setting(name, default=None):
  """Settings: environment variables > site package. Not the CLI's secrets files."""
  from qaboard.site_config import _site_defaults
  return os.environ.get(name, _site_defaults.get(name, default))


def server_secret(name, default=None):
  """Tokens and secrets: only from the environment."""
  return os.environ.get(name, default)


def load_git_hosts(get=None, get_secret=None, strict=False):
  """
  get(name, default): reads the settings. Default: environment variables > site package.
  get_secret(name, default): reads tokens and webhook secrets. Default: environment variables. In tests: `get`.
  strict: raise ValueError for invalid settings, instead of logging and ignoring them (see GitHosts.errors).
  """
  if get is None:
    get, get_secret = server_setting, get_secret or server_secret
  get_secret = get_secret or get
  errors = []
  def invalid(message):
    if strict:
      raise ValueError(message)
    print(f"ERROR: {message}. Webhooks are refused until it's fixed.", file=sys.stderr)
    errors.append(message)

  hosts_config = get('QABOARD_GIT_HOSTS')
  try:
    entries = read_hosts_config(hosts_config)
  except ValueError as e:
    invalid(str(e))
    entries = []
  configured = []
  for entry in entries:
    try:
      configured.append(make_host(entry, get_secret))
    except ValueError as e:
      invalid(str(e))

  gitlab_token, github_token = get_secret('GITLAB_ACCESS_TOKEN', '') or '', get_secret('GITHUB_ACCESS_TOKEN', '') or ''
  def legacy_host(cls, name, value, token):
    try:
      url, credentials = legacy_url(name, value)
      if credentials and token:
        print(f"WARNING: we ignore the credentials in {name}, and use its token", file=sys.stderr)
      return cls(url, token=token or credentials or '')
    except ValueError as e:
      invalid(f"{name}: {e}")
  split = lambda name: [h.strip() for h in str(get(name, '') or '').split(',') if h.strip()]

  gitlab_host = get('GITLAB_HOST')
  legacy = []
  if gitlab_host:
    legacy_gitlab = legacy_host(GitLabHost, 'GITLAB_HOST', gitlab_host, gitlab_token)
  elif not hosts_config:
    legacy_gitlab = GitLabHost('https://gitlab.com', token=gitlab_token)
  else:
    legacy_gitlab = None
  gitlab_aliases = []
  for value in split('QABOARD_GITLAB_HOSTS'):
    if '://' in value: # another GitLab server
      legacy.append(legacy_host(GitLabHost, 'QABOARD_GITLAB_HOSTS', value, gitlab_token))
    elif hostname_of(value):
      gitlab_aliases.append(hostname_of(value))
  github_hosts = [GitHubHost('https://github.com', token=github_token)]
  for value in split('QABOARD_GITHUB_HOSTS'):
    host = legacy_host(GitHubHost, 'QABOARD_GITHUB_HOSTS', value if '://' in value else f"https://{value}", github_token)
    if host and '://' not in value:
      host.scheme_from_repositories = True
    github_hosts.append(host)
  legacy = [legacy_gitlab, *legacy, *github_hosts]

  hosts = list(configured)
  for candidate in legacy:
    if not candidate:
      continue
    # A GitLab and a GitHub host can have the same hostname, e.g. GITLAB_HOST was a GitHub Enterprise server
    same = next((h for h in hosts if h.type == candidate.type and h.hostname == candidate.hostname), None)
    if same:
      same.token = same.token or candidate.token
    elif candidate.hostname == 'github.com' and any(h.hostname == 'github.com' for h in hosts):
      pass # e.g. configured as a "generic" host
    else:
      hosts.append(candidate)

  if legacy_gitlab:
    default = next(h for h in hosts if h.type == 'gitlab' and h.hostname == legacy_gitlab.hostname)
  else:
    default = hosts[0]

  # Other names of the GitLab server, like before: the same token, scheme, users...
  gitlab = default if default.type == 'gitlab' else next((h for h in hosts if h.type == 'gitlab'), None)
  for alias in gitlab_aliases:
    if any(h.matches(alias) for h in hosts if h.type == 'gitlab'):
      continue
    if gitlab:
      gitlab.hostnames.add(alias)
    else:
      hosts.append(GitLabHost(f"https://{alias}", token=gitlab_token))

  webhook_secret = get_secret('QABOARD_WEBHOOK_SECRET', '') or ''
  # The site's avatars for users, e.g. from a company directory, for GitLab users who didn't upload one
  avatar_url = get('QABOARD_AVATAR_URL')
  for host in hosts:
    host.webhook_secret = host.webhook_secret or webhook_secret
    if avatar_url and host.type == 'gitlab' and not host.user_avatar_url:
      host.user_avatar_url = avatar_url.replace('{user_name}', '{username}')
  return GitHosts(hosts, default, webhook_secret, errors)


git_hosts = load_git_hosts()


def committer_avatar_url(name, git=None, project_url=None):
  """The avatar of a commit's author, in a repository described by Project.data['git']. No network calls."""
  if not name:
    return ''
  committer = committers.lookup(name)
  try:
    host = git_hosts.for_repo(git, project_url)
  except UntrustedHost:
    return default_avatar_url(committer)
  return host.avatar_url(name, committer)
