"""
Settings admins change in the web app (Admin → Settings): the environment wins, then the database, then the default.
The admin panel shows, for each setting, where its value comes from and what the other layers say.

- Secret settings (tokens, passwords) are encrypted in the database (backend/encryption.py), and never shown again:
  admins replace or clear them.
- "Records" settings are lists of small objects edited in a form, e.g. the Jenkins servers and their tokens. Their
  secret fields are encrypted one by one, so that admins still see the rest (the hostnames, the users).
- Bootstrap settings (the database, SECRET_KEY, QABOARD_URL, QABOARD_ADMINS, the storage roots...) only come from the
  environment: they're needed before the database is reachable, or they're a security boundary that a stolen admin
  session must not be able to move. SERVER_VARIABLES lists them, so the panel shows them, read-only.

The database values are cached a few seconds per process, so every worker and replica sees changes quickly.
"""
import os
import json
import time
import uuid
import threading
from typing import Any, Callable, NamedTuple, Optional
from urllib.parse import urlparse


def env_flag(value: str) -> bool:
  """"false", "0", "no", "off" or empty mean False, any other value (e.g. "true", "1") means True."""
  return value.strip().lower() not in ("", "0", "false", "no", "off")


def env_list(value: str) -> list:
  return [v.strip() for v in value.split(',') if v.strip()]


def sandbox_html() -> bool:
  """
  QABOARD_SANDBOX_HTML: the runs' HTML and SVG files can't act as whoever opens them. Off by default, for now: reports
  with scripts then run them in our origin. Read by the proxy too (services/nginx/configure.sh), set it for both.
  """
  return env_flag(os.environ.get('QABOARD_SANDBOX_HTML', ''))


def login_type() -> str:
  return (os.environ.get('QABOARD_LOGIN_TYPE') or 'LOCAL').upper()


class Records(list):
  """The type of settings that are lists of records, e.g. Jenkins servers: [{"id": ..., "hostname": ..., ...}]"""
Records.__name__ = 'records'


class Field(NamedTuple):
  """A field of the records of a "records" setting"""
  name: str
  label: str
  # str, bool, choice, list (of texts), hostname (URLs are reduced to their hostname), url
  type: str = 'str'
  required: bool = False
  # encrypted, never shown again
  secret: bool = False
  choices: Optional[tuple] = None
  placeholder: Optional[str] = None
  help: Optional[str] = None
  default: Any = None


class Definition(NamedTuple):
  description: str
  # a value, or a function returning it
  default: Any
  # bool, int, str, list, Records
  type: type
  env: Optional[str] = None
  # turns the environment variable's text into the value. Raises ValueError for invalid values.
  parse_env: Optional[Callable[[str], Any]] = None
  choices: Optional[tuple] = None
  nullable: bool = False
  minimum: Optional[int] = None
  maximum: Optional[int] = None
  # encrypted in the database, never shown again
  secret: bool = False
  # for people: "Require signing in"
  label: Optional[str] = None
  # see GROUPS
  group: str = 'security'
  # e.g. days, seconds, GB
  unit: Optional[str] = None
  placeholder: Optional[str] = None
  # explains defaults that depend on something else, e.g. "On with LOCAL sign-in, off with LDAP or SAML"
  default_text: Optional[str] = None
  docs: Optional[str] = None
  # for "records" settings
  fields: tuple = ()
  # the field that identifies a record, unique, e.g. hostname
  record_key: Optional[str] = None
  # what a record is, for people: "Jenkins server"
  record_noun: Optional[str] = None
  # secrets that are URLs are shown as https://hooks.slack.com/…, the others not at all
  mask: str = 'hidden'
  # extra checks, raises ValueError with a sentence for people
  check: Optional[Callable[[Any], None]] = None
  # a multi-line text
  multiline: bool = False


class Group(NamedTuple):
  id: str
  title: str
  icon: str
  description: str
  docs: Optional[str] = None


GROUPS = [
  Group('sign_in', "Sign-in", "log-in", "Who can sign in, who gets an account, and how long sessions last.", "/docs/backend-admin/sign-in"),
  Group('access', "Projects and access", "people", "Who sees projects, and what signed-in users can do on them.", "/docs/backend-admin/project-access"),
  Group('tokens', "API tokens and results", "key", "How `qa`, CI jobs and scripts authenticate, and how long tokens last.", "/docs/backend-admin/user-management#api-tokens"),
  Group('git', "Git hosts", "git-repo", "Where the projects' repositories live: QA-Board clones them, receives their push webhooks, shows their avatars and CI statuses.", "/docs/backend-admin/git-hosts"),
  Group('jenkins', "Jenkins", "build", "The Jenkins servers that QA-Board starts builds on, for projects' integrations.", "/docs/triggering-third-party-tools#trigger-jenkins-builds"),
  Group('email', "Email", "envelope", "How QA-Board sends emails: to users when their batches end, and to admins when scheduled jobs fail.", "/docs/deploy#emails"),
  Group('web_app', "Web app", "application", "What the web app shows users: where they get help, the docs, avatars, install instructions."),
  Group('analytics', "Usage analytics", "timeline-line-chart", "What QA-Board records about how people use it (Admin → Usage).", "/docs/backend-admin/usage-analytics"),
  Group('storage', "Storage and performance", "database", "Where exports go, and caches and shortcuts for large projects.", "/docs/backend-admin/storage"),
  Group('security', "Security", "shield", "Encryption of the secrets stored here, cross-origin requests, and the audit log.", "/docs/backend-admin/settings#secrets-and-the-encryption-key"),
  Group('server', "Server", "server", "How this server is deployed. These only come from its environment.", "/docs/deploy#optional-environment-variables"),
]
GROUP_IDS = {g.id for g in GROUPS}


def _json_records(name, to_record):
  """Parses environment variables like JENKINS_AUTH: {"hostname": {...}} => records"""
  def parse(raw):
    try:
      value = json.loads(raw)
    except ValueError as e:
      raise ValueError(f"not valid JSON ({e})")
    if not isinstance(value, dict) or not all(isinstance(v, dict) for v in value.values()):
      raise ValueError('expected {"hostname": {...}, ...}')
    return [to_record(hostname, entry) for hostname, entry in value.items()]
  return parse


def _parse_git_hosts(raw):
  """QABOARD_GIT_HOSTS (JSON, or a JSON/YAML file) => records, with the tokens of `token_env` and `webhook_secret_env`"""
  from .git_hosts import read_hosts_config
  records = []
  for entry in read_hosts_config(raw):
    record = {name: entry.get(name) for name in ('type', 'url', 'name', 'api_url', 'user_avatar_url') if entry.get(name)}
    hostnames = entry.get('hostnames') or []
    record['hostnames'] = [hostnames] if isinstance(hostnames, str) else list(hostnames)
    for secret in ('token', 'webhook_secret'):
      value = entry.get(secret) or (os.environ.get(entry[f'{secret}_env'], '') if entry.get(f'{secret}_env') else '')
      if value:
        record[secret] = value
    records.append(record)
  return records


def _check_url(value, schemes=('http', 'https'), what="a URL"):
  parsed = urlparse(value)
  if parsed.scheme not in schemes or (parsed.scheme in ('http', 'https') and not parsed.netloc):
    raise ValueError(f"must be {what}, e.g. {'https://example.com' if 'https' in schemes else schemes[0] + ':...'}")


def _check_not_local(host: str):
  """
  Hosts the server sends requests to, on behalf of anyone (the image proxy, Jenkins): not itself or the cloud's
  metadata service. Private networks are fine: that's where companies' servers are.
  """
  import ipaddress
  name = host.strip().strip('[]').lower()
  if name in ('localhost', 'localhost.localdomain') or name.endswith('.localhost'):
    raise ValueError(f"can't be {host}: the server would send requests to itself")
  try:
    ip = ipaddress.ip_address(name)
  except ValueError:
    return
  if ip.is_loopback or ip.is_link_local or ip.is_unspecified or ip.is_multicast:
    raise ValueError(f"can't be {host}: the server would send requests to itself or its cloud's metadata service")


def _check_hosts(values):
  for value in values:
    _check_not_local(urlparse(f"//{value}").hostname or value)


def _check_timezone(value):
  import pytz
  try:
    pytz.timezone(value)
  except pytz.UnknownTimeZoneError:
    raise ValueError(f"unknown time zone {value!r}, expected e.g. Europe/Paris or Asia/Jerusalem")


def _check_email(value):
  from email.utils import parseaddr
  address = parseaddr(value)[1]
  if '@' not in address or ' ' in address:
    raise ValueError("must be an email address, e.g. QA-Board <qaboard@example.com>")


def _check_exports_root(value):
  from .storage import check_storage_path, UnsafePathError
  if not value.startswith('/'):
    raise ValueError("must be an absolute path, e.g. /algo/qaboard/exports")
  try:
    check_storage_path(value)
  except UnsafePathError as e:
    raise ValueError(str(e))


def _email_default_sender():
  import socket
  return f"QA-Board <qaboard@{setting('email.domain') or socket.getfqdn()}>"


DEFINITIONS = {
  # ---- Sign-in
  'auth.require_sign_in': Definition(
    "Anonymous users can't see anything: the API answers 401 except for signing in, and for ingest unless ingest.auth is \"token\".",
    False, bool, env='QABOARD_LOGIN_REQUIRED', parse_env=env_flag,
    label="Require signing in", group='sign_in', docs="/docs/backend-admin/user-management#blocking-anonymous-users",
  ),
  'auth.access_policy': Definition(
    "Who gets an account when they first sign in: \"open\" (everyone a sign-in method accepts), \"domains\" (emails in auth.allowed_email_domains, the others wait for an admin), \"approval\" (everyone waits for an admin).",
    'open', str, env='QABOARD_ACCESS_POLICY', choices=('open', 'domains', 'approval'),
    label="Who gets an account", group='sign_in', docs="/docs/backend-admin/sign-in#decide-who-gets-an-account",
  ),
  'auth.allowed_email_domains': Definition(
    "With auth.access_policy \"domains\": the email domains whose users get an account right away, e.g. example.com.",
    [], list, env='QABOARD_ALLOWED_EMAIL_DOMAINS', parse_env=env_list,
    label="Email domains accepted right away", group='sign_in', placeholder="example.com",
  ),
  'auth.access_request_webhook': Definition(
    "An incoming webhook (Slack, Teams, Mattermost...) told when users wait for an admin. QA-Board sends {\"text\": \"...\"}.",
    None, str, env='QABOARD_ACCESS_REQUEST_WEBHOOK', nullable=True, secret=True, mask='url',
    label="Access requests webhook", group='sign_in', placeholder="https://hooks.slack.com/services/…",
    check=_check_url,
  ),
  'auth.local_signup': Definition(
    "Anyone can create a local account with a password. Off by default with LDAP or SAML: local accounts could take the names of directory users.",
    lambda: login_type() == 'LOCAL', bool, env='QABOARD_DISABLE_SIGNUP', parse_env=lambda v: not env_flag(v),
    label="Local sign-up", group='sign_in',
    default_text="On when QABOARD_LOGIN_TYPE is LOCAL, off with LDAP or SAML.",
  ),
  'auth.provider_order': Definition(
    "The order of the sign-in methods on the sign-in page, by id (e.g. sso, keycloak, ldap, local). Admin → Sign-in sets it with its arrows. Methods not listed come after, in their default order.",
    [], list, env='QABOARD_SIGN_IN_ORDER', parse_env=env_list,
    label="Order of the sign-in methods", group='sign_in', placeholder="sso", docs="/docs/backend-admin/sign-in",
  ),
  'auth.sso_auto_redirect': Definition(
    "When signing in is required and there is a single single sign-on method, the sign-in page goes straight to it. /login?local=1 still shows the password form.",
    False, bool, env='QABOARD_SSO_AUTO_REDIRECT', parse_env=env_flag,
    label="Go straight to single sign-on", group='sign_in',
  ),
  'auth.login_hint': Definition(
    "Shown in the sign-in dialog to users whose user name or password is wrong, e.g. \"Use your Windows credentials.\"",
    None, str, env='QABOARD_LOGIN_HINT', nullable=True,
    label="Sign-in hint", group='sign_in', placeholder="Use your Windows credentials.",
  ),
  'sessions.idle_days': Definition(
    "Browser sessions end after this many days without activity.",
    30, int, minimum=1, label="Idle sessions end after", group='sign_in', unit='days',
  ),
  'sessions.max_days': Definition(
    "Browser sessions end after this many days, active or not: users sign in again.",
    180, int, minimum=1, maximum=365, label="Sessions end after", group='sign_in', unit='days',
  ),

  # ---- Projects and access
  'projects.default_visibility': Definition(
    "Who can see the projects whose owners didn't choose: \"public\" (anyone who can open QA-Board), \"internal\" (signed-in users), \"private\" (only their members).",
    'public', str, env='QABOARD_DEFAULT_VISIBILITY', choices=('public', 'internal', 'private'),
    label="Default project visibility", group='access',
  ),
  'projects.signed_in_role': Definition(
    "The role of signed-in users on public and internal projects: \"developer\" (they can send results and act on runs, as before project roles) or \"viewer\". Members of a project, and private projects, follow their grants.",
    'developer', str, env='QABOARD_SIGNED_IN_ROLE', choices=('viewer', 'developer'),
    label="Role of signed-in users", group='access',
  ),
  'storage.others_visible_to': Definition(
    "Who sees other people's storage usage (Storage usage > Everyone's, Users): \"members\" (the project's developers and owners, from a grant, a group or qaboard.yaml: not every signed-in user) or \"signed_in\" (everyone who can see the project). Admins see everything.",
    'members', str, env='QABOARD_STORAGE_OTHERS_VISIBLE_TO', choices=('members', 'signed_in'),
    label="Who sees others' storage usage", group='access',
  ),

  # ---- API tokens and results
  'ingest.auth': Definition(
    "How runs, batches and commits sent by `qa` are authenticated: \"off\" accepts anonymous results (they're marked unverified), \"warn\" also warns the senders, \"token\" requires a token with the ingest scope.",
    'off', str, env='QABOARD_INGEST_AUTH', choices=('off', 'warn', 'token'),
    label="Authenticate results sent by qa", group='tokens', docs="/docs/backend-admin/user-management#results-sent-by-qa",
  ),
  'tokens.default_lifetime_days': Definition(
    "The default lifetime of the tokens users create in the web app.",
    90, int, minimum=1, label="Default token lifetime", group='tokens', unit='days',
  ),
  'tokens.max_lifetime_days': Definition(
    "The longest lifetime users may choose for their tokens. Empty: no maximum, and tokens without an expiry date are allowed.",
    None, int, nullable=True, minimum=1, label="Longest token lifetime", group='tokens', unit='days',
    default_text="No maximum: tokens may never expire.",
  ),
  'tokens.cli_idle_expiry_days': Definition(
    "Tokens created by `qa auth login` expire after this many days without being used.",
    180, int, minimum=1, label="Unused CLI tokens expire after", group='tokens', unit='days',
  ),
  'tokens.ci_lifetime_minutes': Definition(
    "How long the tokens that CI jobs get without a stored secret (trusted CI jobs of service accounts) work.",
    360, int, minimum=5, maximum=1440, label="CI jobs' tokens last", group='tokens', unit='minutes',
  ),

  # ---- Git hosts
  'git.hosts': Definition(
    "The git hosts of your projects, with their tokens (to clone private repositories and call their API) and the secrets their webhooks send. github.com is always known. GITLAB_HOST, GITLAB_ACCESS_TOKEN, GITHUB_ACCESS_TOKEN and QABOARD_WEBHOOK_SECRET, if set, still apply on top.",
    [], Records, env='QABOARD_GIT_HOSTS', parse_env=_parse_git_hosts,
    label="Git hosts", group='git', docs="/docs/backend-admin/git-hosts", record_key='url', record_noun="git host",
    default_text="gitlab.com and github.com, without tokens (or GITLAB_HOST).",
    fields=(
      Field('type', "Type", 'choice', required=True, choices=('gitlab', 'github', 'gitea', 'forgejo', 'bitbucket', 'generic'), default='gitlab'),
      Field('url', "URL", 'url', required=True, placeholder="https://gitlab.example.com"),
      Field('name', "Name", placeholder="Shown to users, by default the hostname"),
      Field('token', "Access token", secret=True, help="To clone private repositories and call the API. user:password for hosts that need a user name, e.g. Bitbucket app passwords."),
      Field('webhook_secret', "Webhook secret", secret=True, help="The secret its push webhooks send. Empty: the shared webhook secret below."),
      Field('api_url', "API URL", 'url', placeholder="If it's not the usual one, e.g. https://api.github.com"),
      Field('hostnames', "Other hostnames", 'list', placeholder="git-alias, ssh.gitlab.example.com", help="Other names of the host, to recognize repository URLs, e.g. an ssh alias."),
      Field('user_avatar_url', "Users' avatars", placeholder="{url}/{username}.png", help="With {url} and {username}. For GitLab, only for users who didn't upload one."),
    ),
  ),
  'git.webhook_secret': Definition(
    "The secret push webhooks must send (GitLab's \"Secret token\", GitHub's \"Secret\"...), for git hosts without their own. Without it, anyone who can reach the server can send fake push events.",
    None, str, env='QABOARD_WEBHOOK_SECRET', nullable=True, secret=True,
    label="Webhook secret", group='git', docs="/docs/backend-admin/git-hosts",
  ),
  'git.gitlab_web_logins': Definition(
    "Accounts QA-Board signs in to GitLab's web pages with, to show users the images of private repositories (projects' avatars and badges): GitLab's API can't serve them.",
    [], Records, env='GITLAB_AUTH', record_key='hostname',
    parse_env=_json_records('GITLAB_AUTH', lambda hostname, e: {"hostname": hostname, "user": e.get('user'), "password": e.get('password'), "type": e.get('type', 'user'), "http": bool(e.get('http'))}),
    label="GitLab accounts for images", group='git', record_noun="GitLab account",
    fields=(
      Field('hostname', "Hostname", 'hostname', required=True, placeholder="gitlab.example.com"),
      Field('user', "User", required=True),
      Field('password', "Password", secret=True, required=True),
      Field('type', "Account type", 'choice', choices=('user', 'ldap_user'), default='user', help="ldap_user for LDAP accounts."),
      Field('http', "Over plain HTTP", 'bool', default=False),
    ),
  ),

  # ---- Jenkins
  'jenkins.servers': Definition(
    "The Jenkins servers QA-Board starts builds on and reads their statuses from, with a user's API token. QA-Board only sends these credentials to these hosts.",
    [], Records, env='JENKINS_AUTH', record_key='hostname',
    parse_env=_json_records('JENKINS_AUTH', lambda hostname, e: {"hostname": hostname, "user": e.get('user'), "token": e.get('token'), "crumb": e.get('crumb')}),
    label="Jenkins servers", group='jenkins', docs="/docs/triggering-third-party-tools#trigger-jenkins-builds", record_noun="Jenkins server",
    fields=(
      Field('hostname', "Hostname", 'hostname', required=True, placeholder="jenkins.example.com", help="As in the jobs' build_url. You can paste a URL."),
      Field('user', "User", required=True),
      Field('token', "API token", secret=True, required=True, help="The user's API token (Jenkins → the user → Security → API Token)."),
      Field('crumb', "Crumb", secret=True, help="Only for Jenkins servers that require a CSRF crumb with API tokens."),
    ),
  ),
  'jenkins.build_token': Definition(
    "The authentication token of \"Trigger builds remotely\", sent to the jobs whose integration has no `token`. Older versions sent \"qaboard\": set it to that if your jobs expect it.",
    None, str, env='JENKINS_BUILD_TOKEN', nullable=True, secret=True,
    label="Remote build token", group='jenkins',
  ),
  'jenkins.anonymous_jobs': Definition(
    "Jenkins jobs that callers without a token can start even if no project's qaboard.yaml lists them: a job matches when its path (/job/...) contains one of these texts (case-sensitive), \"*\" matches all. A way out while scripts move to tokens: they get a warning. Ignored when ingest.auth is \"token\".",
    [], list, env='QABOARD_JENKINS_ANONYMOUS_JOBS', parse_env=env_list,
    label="Jobs anyone can start", group='jenkins', docs="/docs/backend-admin/user-management#jenkins-jobs-started-without-a-token",
  ),

  # ---- Email
  'email.smtp_host': Definition(
    "The SMTP server QA-Board sends emails with. Without it, no emails are sent, and users can't ask for them.",
    None, str, env='QABOARD_SMTP_HOST', nullable=True,
    label="SMTP server", group='email', placeholder="smtp.example.com",
  ),
  'email.smtp_security': Definition(
    "How the connection to the SMTP server is secured: \"none\", \"starttls\" or \"ssl\".",
    'none', str, env='QABOARD_SMTP_SECURITY', choices=('none', 'starttls', 'ssl'),
    label="Connection security", group='email',
  ),
  'email.smtp_port': Definition(
    "The SMTP server's port.",
    None, int, env='QABOARD_SMTP_PORT', nullable=True, minimum=1, maximum=65535,
    label="SMTP port", group='email', default_text="25, or 587 with starttls, 465 with ssl.",
  ),
  'email.smtp_user': Definition(
    "If the SMTP server needs a login.",
    None, str, env='QABOARD_SMTP_USER', nullable=True, label="SMTP user", group='email',
  ),
  'email.smtp_password': Definition(
    "The SMTP user's password.",
    None, str, env='QABOARD_SMTP_PASSWORD', nullable=True, secret=True, label="SMTP password", group='email',
  ),
  'email.smtp_timeout': Definition(
    "How long QA-Board waits for the SMTP server.",
    15, int, env='QABOARD_SMTP_TIMEOUT', minimum=1, maximum=300, label="SMTP timeout", group='email', unit='seconds',
  ),
  'email.from': Definition(
    "The sender of the emails.",
    _email_default_sender, str, env='QABOARD_EMAIL_FROM', label="Sender", group='email',
    placeholder="QA-Board <qaboard-noreply@example.com>", check=_check_email,
    default_text="QA-Board <qaboard@…>, at the email domain below, else at the server's hostname.",
  ),
  'email.reply_to': Definition(
    "Where replies go, e.g. the team that supports QA-Board.",
    None, str, env='QABOARD_EMAIL_REPLY_TO', nullable=True, label="Reply-to", group='email',
    placeholder="qaboard-support@example.com", check=_check_email,
  ),
  'email.domain': Definition(
    "Users whose account has no email address get emails at <user name>@<this domain>, e.g. example.com with LDAP user names.",
    None, str, env='QABOARD_EMAIL_DOMAIN', nullable=True, parse_env=lambda v: v.strip().lstrip('@') or None,
    label="Email domain of users", group='email', placeholder="example.com",
  ),
  'email.timezone': Definition(
    "The time zone of the times in emails.",
    'UTC', str, env='QABOARD_EMAIL_TIMEZONE', label="Time zone", group='email', placeholder="Asia/Jerusalem", check=_check_timezone,
  ),
  'jobs.failure_emails': Definition(
    "Email when a scheduled job (Admin > Storage > Schedules) fails or ends with errors. Requires an SMTP server.",
    True, bool, env='QABOARD_JOBS_FAILURE_EMAILS', parse_env=env_flag,
    label="Email when scheduled jobs fail", group='email',
  ),
  'jobs.failure_email_to': Definition(
    "Who gets the emails about scheduled jobs that went wrong: user names or emails. Empty: the admins.",
    [], list, env='QABOARD_JOBS_FAILURE_EMAIL_TO', parse_env=env_list,
    label="Who gets them", group='email', default_text="The admins.",
  ),

  # ---- Web app
  'web.support_url': Definition(
    "Where users report bugs and send feedback: a web page, or a mailto: link.",
    'https://github.com/Samsung/qaboard/issues', str, env='QABOARD_SUPPORT_URL',
    label="Support link", group='web_app', check=lambda v: _check_url(v, ('http', 'https', 'mailto'), "a URL or a mailto: link"),
  ),
  'web.docs_root': Definition(
    "Where the web app's links to the docs point. By default, the docs served by this server at /docs/, which match its version.",
    '/', str, env='QABOARD_DOCS_ROOT', label="Docs", group='web_app', placeholder="https://samsung.github.io/qaboard/",
  ),
  'web.avatar_url': Definition(
    "Users' avatars, e.g. from a company directory, with {user_name}: in the user menu, and for GitLab committers who didn't upload one.",
    None, str, env='QABOARD_AVATAR_URL', nullable=True,
    label="Avatars", group='web_app', placeholder="https://directory.example.com/photos/{user_name}.jpg",
  ),
  'web.cli_requirements': Definition(
    "What scripts install besides qaboard to use `qa` here, as pip requirements, e.g. your site package. The web app's Script snippets list them.",
    [], list, env='QABOARD_CLI_REQUIREMENTS', parse_env=env_list,
    label="Packages scripts install", group='web_app', placeholder="qaboard-site>=1.2",
  ),
  'web.webcde_installer': Definition(
    "Runs whose outputs have a cde.sh get a button to open them in WebCDE, a desktop app. When it isn't running, users are told to install it from here.",
    None, str, env='QABOARD_WEBCDE_INSTALLER', nullable=True, label="WebCDE installer", group='web_app',
  ),
  'web.proxy_hosts': Definition(
    "Hostnames the web app may load images from through the server (it adds no credentials), besides the git hosts, the avatars' host and gravatar: the hosts of projects' avatar_url and integrations' images.",
    [], list, env='QABOARD_PROXY_HOSTS', parse_env=env_list,
    label="Other image hosts", group='web_app', placeholder="badges.example.com", check=_check_hosts,
  ),

  # ---- Usage analytics
  'analytics.enabled': Definition(
    "Record what people do in the web app and with `qa` (Admin > Usage): page views, features used, commands run. Off: the web app sends nothing, and the server drops what reaches it.",
    True, bool, env='QABOARD_ANALYTICS_ENABLED', parse_env=env_flag,
    label="Record usage", group='analytics',
  ),
  'analytics.posthog_api_key': Definition(
    "Also send the web app's events to PostHog, with this project API key (it's public: browsers send it).",
    None, str, env='POSTHOG_API_KEY', nullable=True, label="PostHog project key", group='analytics', placeholder="phc_…",
  ),
  'analytics.posthog_host': Definition(
    "PostHog's address, if it's not PostHog Cloud's.",
    None, str, env='POSTHOG_HOST', nullable=True, label="PostHog host", group='analytics', placeholder="https://posthog.example.com",
    check=_check_url,
  ),

  # ---- Storage and performance
  'storage.exports_root': Definition(
    "Where \"Export to a shared folder\" puts exports: <this folder>/<user>/<project>/<date>-<id>, all in one place where users find and delete them (Storage usage > Exports). Empty: in a share/ folder next to the commit's runs, as before. It must be in the storage (QABOARD_STORAGE_ROOTS).",
    None, str, env='QABOARD_EXPORTS_ROOT', nullable=True,
    label="Exports folder", group='storage', placeholder="/algo/qaboard/exports", check=_check_exports_root,
    default_text="A share/ folder next to each commit's runs.",
  ),
  'storage.image_cache_gb': Definition(
    "The disk space of the decoded images users read pixel values of, or compare with \"Where they differ\": the least recently used are removed. A 12 MP 16-bit RGB image takes 72 MB.",
    20, int, env='QABOARD_IMAGE_CACHE_GB', parse_env=lambda v: max(1, round(float(v))), minimum=1,
    label="Image cache size", group='storage', unit='GB',
  ),
  'metrics.skip_aggregation': Definition(
    "Projects whose commit lists don't show the batches' aggregated metrics (median, average): for projects with so many runs that computing them slows the lists down. Project ids, or their start, e.g. group/ for all the projects of a group. Commit pages still show them.",
    [], list, env='QABOARD_SKIP_METRICS_AGGREGATION', parse_env=env_list,
    label="Projects without metrics in commit lists", group='storage', placeholder="group/huge-project",
  ),

  # ---- Security
  'auth.allowed_origins': Definition(
    "Other origins (e.g. https://dashboards.example.com) allowed to make changes with the users' cookies. The server's own origin is always allowed.",
    [], list, env='QABOARD_ALLOWED_ORIGINS', parse_env=env_list,
    label="Other allowed origins", group='security', placeholder="https://dashboards.example.com",
  ),
  'audit.retention_days': Definition(
    "Audit events older than this are deleted by `qaboard-admin purge-audit` (run it from a scheduled job).",
    730, int, minimum=30, label="Keep audit events for", group='security', unit='days',
  ),
}


class ServerVariable(NamedTuple):
  """Read-only in the admin panel: only from the environment"""
  name: str
  label: str
  group: str
  description: str
  # why it can't be changed in the web app
  why: str
  # what we show: the value, or a function returning it (None: not set)
  value: Callable[[], Any] = None
  secret: bool = False
  default_text: Optional[str] = None
  docs: Optional[str] = None


BOOTSTRAP = "Read when the server starts, before it can reach the database."
BOUNDARY = "A security boundary: someone who takes over an admin's session must not be able to move it."
RUNS_COMMANDS = "The server runs it as a command: changing it from a web page would let admins run any command on the server."


def _env(name):
  return lambda: os.environ.get(name, '').strip() or None


def _redact_url(url):
  if not url:
    return None
  parsed = urlparse(url)
  if parsed.password:
    return parsed._replace(netloc=f"{parsed.username}:•••@{parsed.hostname}{f':{parsed.port}' if parsed.port else ''}").geturl()
  return url


def _database():
  e = os.environ.get
  return f"{e('QABOARD_DB_USER') or 'qaboard'}@{e('QABOARD_DB_HOST') or 'db'}:{e('QABOARD_DB_PORT') or '5432'}/{e('QABOARD_DB_NAME') or 'qaboard'}"


def _secret_key():
  return "set" if os.environ.get('SECRET_KEY') else None


SERVER_VARIABLES = [
  ServerVariable('QABOARD_URL', "Public URL", 'server', "The address users open: links in emails, single sign-on redirects. With https://, session cookies are only sent over HTTPS.",
                 BOOTSTRAP, _env('QABOARD_URL'), default_text="http://qaboard"),
  ServerVariable('QABOARD_DB_*', "Database", 'server', "The PostgreSQL database: QABOARD_DB_HOST, QABOARD_DB_PORT, QABOARD_DB_NAME, QABOARD_DB_USER and QABOARD_DB_PASSWORD.",
                 BOOTSTRAP, _database),
  ServerVariable('REDIS_HOST', "Cache", 'server', "The Redis cache shared by the replicas (REDIS_HOST, REDIS_PORT). The server still works without it, slower.",
                 BOOTSTRAP, lambda: f"{os.environ.get('REDIS_HOST') or 'localhost'}:{os.environ.get('REDIS_PORT') or '6379'}"),
  ServerVariable('CELERY_BROKER_URL', "Task queue", 'server', "The RabbitMQ broker of the Celery workers that run batches.",
                 BOOTSTRAP, lambda: _redact_url(os.environ.get('CELERY_BROKER_URL'))),
  ServerVariable('QABOARD_TUNING_RUNNER', "Runner of web app batches", 'server', "How batches and tuning started from the web app run: local, celery or lsf.",
                 RUNS_COMMANDS, _env('QABOARD_TUNING_RUNNER'), default_text="local", docs="/docs/tuning-from-the-webapp"),
  ServerVariable('QA_RUNNERS_LSF_BRIDGE', "LSF bridge", 'server', "With the lsf runner: the command that submits LSF jobs.",
                 RUNS_COMMANDS, _env('QA_RUNNERS_LSF_BRIDGE')),
  ServerVariable('SENTRY_DSN', "Sentry", 'server', "Where errors and performance data are reported (SENTRY_DSN, SENTRY_FRONTEND_DSN, SENTRY_ENVIRONMENT...).",
                 BOOTSTRAP, lambda: (urlparse(os.environ['SENTRY_DSN']).hostname or "set") if os.environ.get('SENTRY_DSN') else None, docs="/docs/backend-admin/monitoring"),
  ServerVariable('QABOARD_VERSION', "Version", 'server', "The deployed version.", "Set by the deployment.", _env('QABOARD_VERSION')),

  ServerVariable('QABOARD_LOGIN_TYPE', "Sign-in method", 'sign_in', "LOCAL, LDAP or SAML. Single sign-on providers (Admin → Sign-in) come on top of any of them.",
                 BOOTSTRAP, lambda: login_type(), docs="/docs/backend-admin/user-management#authentication-providers"),
  ServerVariable('QABOARD_ADMINS', "Admins from the environment", 'sign_in', "User names or verified emails that are admins whatever the database says: the way back in if no admin can sign in.",
                 BOUNDARY, _env('QABOARD_ADMINS'), docs="/docs/backend-admin/user-management#admins-and-the-admin-panel"),
  ServerVariable('QABOARD_LDAP_HOST', "LDAP", 'sign_in', "The LDAP server and its service account (QABOARD_LDAP_*), with QABOARD_LOGIN_TYPE=LDAP.",
                 BOOTSTRAP, _env('QABOARD_LDAP_HOST'), docs="/docs/backend-admin/user-management#environment-variables"),
  ServerVariable('QABOARD_OIDC_ISSUER', "Single sign-on from the environment", 'sign_in', "An OpenID Connect provider configured with QABOARD_OIDC_*. Providers added in Admin → Sign-in need none of it.",
                 BOOTSTRAP, _env('QABOARD_OIDC_ISSUER'), docs="/docs/backend-admin/sign-in"),

  ServerVariable('QABOARD_ENCRYPTION_KEY', "Encryption key", 'security', "Encrypts the secrets stored in the database. Or QABOARD_ENCRYPTION_KEY_FILE, else a key the server generates in its data folder.",
                 "The key must never be stored next to what it encrypts: a dump of the database would then hold the secrets.",
                 lambda: "set" if os.environ.get('QABOARD_ENCRYPTION_KEY') or os.environ.get('QABOARD_ENCRYPTION_KEY_FILE') else None, secret=True,
                 default_text="Generated by the server", docs="/docs/backend-admin/settings#secrets-and-the-encryption-key"),
  ServerVariable('SECRET_KEY', "Session signing key", 'security', "Signs the users' sessions. All the replicas must share it.",
                 BOUNDARY, _secret_key, secret=True, default_text="Generated by the server, in its data folder"),
  ServerVariable('QABOARD_TRUSTED_PROXY_HOPS', "Trusted proxies", 'security', "How many proxies in front of QA-Board add X-Forwarded-For: the audit log records the clients' addresses behind them.",
                 BOUNDARY, _env('QABOARD_TRUSTED_PROXY_HOPS'), default_text="0"),
  ServerVariable('QABOARD_SANDBOX_HTML', "Sandboxed HTML reports", 'security', "The runs' HTML and SVG files can't act as whoever opens them.",
                 "The proxy reads it too: it must be set where both are deployed.", lambda: "on" if sandbox_html() else None, default_text="off", docs="/docs/viewers#html-reports"),

  ServerVariable('QABOARD_STORAGE_ROOTS', "Storage roots", 'storage', "The folders where projects store their results. The server never writes, deletes or runs code outside them.",
                 BOUNDARY, _env('QABOARD_STORAGE_ROOTS'), default_text="/mnt/qaboard"),
  ServerVariable('QABOARD_FILES_UNIX_PERMISSIONS', "Folders with Unix permissions", 'storage', "Folders where users only read the files their Unix account can read.",
                 BOUNDARY, _env('QABOARD_FILES_UNIX_PERMISSIONS'), docs="/docs/backend-admin/user-management#unix-permissions"),
  ServerVariable('QABOARD_ACCOUNTS_COMMAND', "Accounts command", 'storage', "Prints the users' Unix accounts, like /etc/passwd (and QABOARD_GROUPS_COMMAND the groups), for file owners and Unix permissions.",
                 RUNS_COMMANDS, _env('QABOARD_ACCOUNTS_COMMAND'), docs="/docs/backend-admin/user-management#users-accounts"),
  ServerVariable('QABOARD_DATA_DIR', "Data folder", 'storage', "Where the server keeps its own files: clones of the repositories, caches, generated keys.",
                 BOOTSTRAP, _env('QABOARD_DATA_DIR'), default_text="/var/qaboard"),
  ServerVariable('QABOARD_IMAGE_SERVERS', "Image servers", 'storage', "The IIIF image servers of each file extension.",
                 "The proxy and the image servers are configured with it.", _env('QABOARD_IMAGE_SERVERS'), default_text='{"default": "/iiif/2/"}'),
]


# Secrets in the database: {"$encrypted": "qb1:..."}
ENCRYPTED = '$encrypted'
MASK = '••••••••'


class SettingError(ValueError):
  """A setting can't be saved, for a reason that's not its value: e.g. there's no encryption key. HTTP 409."""


CACHE_SECONDS = 5
_cache = {"rows": None, "loaded_at": 0.0, "version": 0, "signature": None}
_lock = threading.Lock()


def _database_rows() -> dict:
  """{key: Setting row's data} from the database, cached for CACHE_SECONDS"""
  now = time.monotonic()
  if _cache["rows"] is not None and now - _cache["loaded_at"] < CACHE_SECONDS:
    return _cache["rows"]
  from backend import db_session
  from .models import Setting
  try:
    # On a connection of our own, not the caller's session: reading settings must never open, keep or roll back the
    # caller's transaction. E.g. when uWSGI's master imports the app (backend/api/webhooks.py reads the git hosts),
    # a transaction left open in its session would be inherited by every forked worker, on the same connection.
    from sqlalchemy import select
    with db_session.get_bind().connect() as connection:
      result = connection.execute(select(Setting.key, Setting.value, Setting.updated_by_id, Setting.updated_at))
      rows = {key: {"value": (value or {}).get('value'), "updated_by_id": by, "updated_at": at} for key, value, by, at in result}
  except Exception as e:
    # e.g. before the migrations ran: the defaults are safe
    print(f"[settings] WARNING: could not read the settings: {type(e).__name__}")
    rows = {}
  try:
    signature = json.dumps({k: r["value"] for k, r in rows.items()}, sort_keys=True, default=str)
  except (TypeError, ValueError):
    signature = None
  with _lock:
    if signature != _cache["signature"]:
      _cache["version"] += 1
    _cache.update(rows=rows, loaded_at=now, signature=signature)
  return rows


def _database_values() -> dict:
  return {key: row["value"] for key, row in _database_rows().items()}


def version() -> int:
  """Changes when the values in the database change: e.g. to rebuild what's computed from them (the git hosts)"""
  _database_rows()
  return _cache["version"]


def invalidate_cache():
  with _lock:
    _cache.update(rows=None, loaded_at=0.0)


def default(key: str):
  value = DEFINITIONS[key].default
  return value() if callable(value) else value


def _env_raw(definition: Definition) -> Optional[str]:
  # empty means unset: docker-compose.yml passes some variables as `VAR=${VAR:-}`
  if not definition.env:
    return None
  raw = os.environ.get(definition.env, '')
  return raw if raw.strip() else None


def _from_env(key: str):
  """(is set, value, problem) from the environment. Invalid values are ignored: (False, None, problem)."""
  definition = DEFINITIONS[key]
  raw = _env_raw(definition)
  if raw is None:
    return False, None, None
  try:
    if definition.parse_env:
      value = definition.parse_env(raw)
    else:
      value = _normalize(definition, raw if definition.type is str else _parse_text(definition, raw))
    if definition.type is Records or not definition.parse_env:
      value = validate(key, value)
    return True, value, None
  except ValueError as e:
    shown = '…' if definition.secret or definition.type is Records else repr(raw)
    return False, None, f"${definition.env}={shown}: {e}"


def from_env(key: str):
  """(is set, value) from the environment"""
  is_set, value, problem = _from_env(key)
  if problem:
    # the admin panel's checklist shows it (invalid_env)
    print(f"[settings] WARNING: ignoring {problem}")
  return is_set, value


def _parse_text(definition: Definition, raw: str):
  if definition.type is bool:
    return env_flag(raw)
  if definition.type is int:
    if not raw.strip() and definition.nullable:
      return None
    try:
      return int(raw)
    except ValueError:
      raise ValueError(f"expected a number, got {raw!r}")
  if definition.type is list:
    return env_list(raw)
  return raw


def _decrypt(value):
  from .encryption import decrypt
  return decrypt(value[ENCRYPTED]) if isinstance(value, dict) and ENCRYPTED in value else value


def reveal(key: str, stored):
  """The value of a setting from what the database holds: secrets decrypted. Raises encryption.UnknownKey."""
  definition = DEFINITIONS[key]
  if definition.type is Records and isinstance(stored, list):
    return [{name: _decrypt(v) for name, v in record.items()} for record in stored if isinstance(record, dict)]
  if definition.secret:
    return _decrypt(stored)
  return stored


def _from_database(key: str):
  """(is set, value, problem)"""
  rows = _database_rows()
  if key not in rows:
    return False, None, None
  from .encryption import UnknownKey
  try:
    return True, reveal(key, rows[key]["value"]), None
  except UnknownKey as e:
    return False, None, f"The value saved here can't be decrypted. {e}"


def source(key: str) -> str:
  if from_env(key)[0]:
    return 'env'
  if _from_database(key)[0]:
    return 'database'
  return 'default'


def setting(key: str):
  """The value of a setting: from the environment, else the database, else the default."""
  is_set, value = from_env(key)
  if is_set:
    return value
  is_set, value, problem = _from_database(key)
  if problem:
    print(f"[settings] ERROR: {key}: {problem} QA-Board uses the default.")
  if is_set:
    return value
  return default(key)


def _validate_field(key: str, field: Field, value):
  where = f"{key}: {field.label}"
  if value in (None, '') or (field.type == 'list' and value == []):
    if field.required:
      raise ValueError(f"{where} is required")
    return [] if field.type == 'list' else (False if field.type == 'bool' else None)
  if field.type == 'bool':
    if not isinstance(value, bool):
      raise ValueError(f"{where} must be true or false")
    return value
  if field.type == 'list':
    if isinstance(value, str):
      value = env_list(value)
    if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
      raise ValueError(f"{where} must be a list of texts")
    return [v.strip() for v in value if v.strip()]
  if not isinstance(value, str):
    raise ValueError(f"{where} must be a text")
  value = value.strip()
  if field.type == 'hostname':
    hostname = urlparse(value).hostname if '//' in value else value.split('/')[0].split(':')[0]
    if not hostname or ' ' in hostname:
      raise ValueError(f"{where} must be a hostname, e.g. jenkins.example.com")
    try:
      _check_not_local(hostname)
    except ValueError as e:
      raise ValueError(f"{where} {e}")
    return hostname.lower()
  if field.type == 'url':
    value = value.rstrip('/')
    try:
      _check_url(value)
    except ValueError as e:
      raise ValueError(f"{where} {e}")
  if field.choices and value not in field.choices:
    raise ValueError(f"{where} must be one of: {', '.join(field.choices)}")
  return value


def _validate_records(key: str, definition: Definition, value) -> list:
  if not isinstance(value, list) or not all(isinstance(r, dict) for r in value):
    raise ValueError(f"{key} must be a list of {{{', '.join(f.name for f in definition.fields)}}}")
  records, seen = [], set()
  for record in value:
    clean = {}
    if record.get('id'):
      clean['id'] = str(record['id'])
    for field in definition.fields:
      raw = record.get(field.name, field.default)
      # secrets being kept: see prepare()
      if field.secret and isinstance(raw, dict) and ENCRYPTED in raw:
        clean[field.name] = raw
        continue
      clean[field.name] = _validate_field(key, field, raw)
    unknown = set(record) - {f.name for f in definition.fields} - {'id'}
    if unknown:
      raise ValueError(f"{key}: unknown field{'s' if len(unknown) > 1 else ''} {', '.join(sorted(unknown))}")
    if definition.record_key:
      identity = str(clean.get(definition.record_key) or '').lower()
      if identity in seen:
        raise ValueError(f"{key}: {identity} is listed twice")
      seen.add(identity)
    records.append(clean)
  return records


def validate(key: str, value):
  """The value, checked against the setting's definition. Raises ValueError with a sentence for people."""
  if key not in DEFINITIONS:
    raise ValueError(f"Unknown setting: {key}")
  definition = DEFINITIONS[key]
  if value is None:
    if definition.nullable:
      return None
    raise ValueError(f"{key} can't be empty")
  if definition.type is bool:
    if not isinstance(value, bool):
      raise ValueError(f"{key} must be true or false")
  elif definition.type is int:
    if isinstance(value, bool) or not isinstance(value, int):
      raise ValueError(f"{key} must be a whole number")
    if definition.minimum is not None and value < definition.minimum:
      raise ValueError(f"{key} must be at least {definition.minimum}")
    if definition.maximum is not None and value > definition.maximum:
      raise ValueError(f"{key} must be at most {definition.maximum}")
  elif definition.type is list:
    if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
      raise ValueError(f"{key} must be a list of texts")
    value = [v.strip() for v in value if v.strip()]
  elif definition.type is Records:
    return _validate_records(key, definition, value)
  elif definition.type is str:
    if not isinstance(value, str):
      raise ValueError(f"{key} must be a text")
    value = value.strip()
    if not value:
      if definition.nullable:
        return None
      raise ValueError(f"{key} can't be empty")
  if definition.choices and value not in definition.choices:
    raise ValueError(f"{key} must be one of: {', '.join(definition.choices)}")
  if definition.check and value is not None:
    try:
      definition.check(value)
    except ValueError as e:
      raise ValueError(f"{key} {e}")
  return value


def _encrypt(plaintext: str) -> dict:
  from .encryption import encrypt, NoEncryptionKey, KeyMismatch
  try:
    return {ENCRYPTED: encrypt(plaintext)}
  except (NoEncryptionKey, KeyMismatch) as e:
    raise SettingError(str(e))


def prepare(key: str, value):
  """
  What to store for a new value of a setting: validated, with its secrets encrypted. None resets to the default.
  Records: a secret field that is `true` keeps the stored secret of the record with the same id, a text replaces it,
  and empty clears it.
  """
  definition = DEFINITIONS.get(key)
  if definition is None:
    raise ValueError(f"Unknown setting: {key}")
  if value is None:
    return None
  if definition.type is Records:
    if not isinstance(value, list):
      raise ValueError(f"{key} must be a list")
    from .models import Setting
    row = Setting.query.filter(Setting.key == key).one_or_none()
    current = (row.value or {}).get('value') if row is not None else None
    stored = {r.get('id'): r for r in (current if isinstance(current, list) else []) if isinstance(r, dict) and r.get('id')}
    secrets = [f for f in definition.fields if f.secret]
    incoming = []
    for record in value:
      if not isinstance(record, dict):
        raise ValueError(f"{key} must be a list of records")
      record = dict(record)
      for field in secrets:
        # what admins saw: true (set) or false (not set)
        if record.get(field.name) is False:
          record[field.name] = None
        if record.get(field.name) is True:
          kept = stored.get(record.get('id'), {}).get(field.name)
          if not kept:
            raise ValueError(f"{key}: {field.label} of {record.get(definition.record_key) or 'a new entry'} must be given again")
          record[field.name] = kept
      incoming.append(record)
    records = validate(key, incoming)
    for record in records:
      record.setdefault('id', uuid.uuid4().hex[:12])
      for field in secrets:
        if isinstance(record.get(field.name), str):
          record[field.name] = _encrypt(record[field.name])
    return records
  value = validate(key, value)
  if definition.secret and value is not None:
    return _encrypt(value)
  return value


def store(key: str, stored, by=None):
  """Stores what prepare() returned, in the current database session: the caller commits."""
  from backend import db_session
  from .models import Setting
  from .tokens import utcnow
  row = Setting.query.filter(Setting.key == key).one_or_none()
  if stored is None:
    if row is not None:
      db_session.delete(row)
    return
  if row is None:
    row = Setting(key=key)
    db_session.add(row)
  row.value = {"value": stored}
  row.updated_by_id = by.id if by is not None else None
  row.updated_at = utcnow()


def save(key: str, value, by=None):
  """Stores a valid value (None resets the default), in the current database session: the caller commits. Returns the new value."""
  store(key, prepare(key, value), by=by)
  invalidate_cache()
  return default(key) if value is None else value


def import_env(key: str, by=None):
  """Saves the environment's value in the database, so that the variable can be removed from the environment"""
  is_set, value, problem = _from_env(key)
  if problem:
    raise ValueError(problem)
  if not is_set:
    raise ValueError(f"${DEFINITIONS[key].env} isn't set")
  definition = DEFINITIONS[key]
  if definition.type is Records:
    # new records: their secrets come from the environment
    value = [{k: v for k, v in record.items() if k != 'id'} for record in value]
  store(key, prepare(key, value), by=by)
  invalidate_cache()


def invalid_env() -> dict:
  """{key: problem} for the settings whose environment variable is set but invalid (they're ignored)"""
  return {key: problem for key in DEFINITIONS for problem in [_from_env(key)[2]] if problem}


def undecryptable() -> dict:
  """{key: problem} for the settings saved here that can't be decrypted"""
  return {key: problem for key in DEFINITIONS for problem in [_from_database(key)[2]] if problem}


def _normalize(definition: Definition, value):
  # QABOARD_INGEST_AUTH=Token means "token"
  if definition.choices and isinstance(value, str):
    return value.strip().lower()
  return value


def masked(key: str, value):
  """What admins see of a setting: secrets hidden (URLs as https://hooks.slack.com/…), records without their secrets"""
  definition = DEFINITIONS[key]
  if definition.type is Records and isinstance(value, list):
    secret_fields = {f.name for f in definition.fields if f.secret}
    return [{name: (bool(v) if name in secret_fields else v) for name, v in record.items()} for record in value]
  if not definition.secret or value in (None, ''):
    return value
  if definition.mask == 'url':
    url = urlparse(str(value))
    return f"{url.scheme}://{url.netloc}/…" if url.scheme and url.netloc else MASK
  return MASK


def _user_names() -> dict:
  """{id: user name} of the admins who changed the settings"""
  ids = {row["updated_by_id"] for row in _database_rows().values() if row["updated_by_id"]}
  if not ids:
    return {}
  from .models import User
  try:
    return {user.id: user.user_name for user in User.query.filter(User.id.in_(ids)).all()}
  except Exception:
    return {}


def _iso(date):
  return date.isoformat() + 'Z' if date is not None and getattr(date, 'tzinfo', None) is None else (date.isoformat() if date else None)


def _type_name(definition: Definition) -> str:
  return definition.type.__name__


def describe(key: str, user_names=None) -> dict:
  definition = DEFINITIONS[key]
  if user_names is None:
    user_names = _user_names()
  env_set, env_value, env_problem = _from_env(key)
  db_set, db_value, db_problem = _from_database(key)
  row = _database_rows().get(key)
  current_source = 'env' if env_set else 'database' if db_set else 'default'
  value = env_value if env_set else db_value if db_set else default(key)
  default_value = default(key)
  if definition.type is Records and env_set:
    env_value = [{"id": f"env-{i}", **r} for i, r in enumerate(env_value)]
    if current_source == 'env':
      value = env_value
  same = env_set and row is not None and db_set and _comparable(definition, env_value) == _comparable(definition, db_value)
  return {
    "key": key,
    "kind": "setting",
    "label": definition.label or key,
    "group": definition.group,
    "value": masked(key, value),
    "is_set": value not in (None, '', []),
    "default": masked(key, default_value),
    "default_text": definition.default_text,
    "secret": definition.secret,
    "source": current_source,
    "env": definition.env,
    "description": definition.description,
    "type": _type_name(definition),
    "choices": list(definition.choices) if definition.choices else None,
    "nullable": definition.nullable,
    "minimum": definition.minimum,
    "maximum": definition.maximum,
    "unit": definition.unit,
    "placeholder": definition.placeholder,
    "docs": definition.docs,
    "multiline": definition.multiline,
    "fields": [field._asdict() for field in definition.fields] or None,
    "record_key": definition.record_key,
    "record_noun": definition.record_noun,
    # the environment wins: changing the database value would have no effect
    "editable": current_source != 'env',
    # what each layer says: the environment wins over the database, that wins over the default
    "layers": {
      "env": {"name": definition.env, "set": env_set, "value": masked(key, env_value) if env_set else None, "error": env_problem},
      "database": {
        "set": row is not None,
        "value": masked(key, db_value) if db_set else None,
        "updated_by": user_names.get(row["updated_by_id"]) if row else None,
        "updated_at": _iso(row["updated_at"]) if row else None,
        "error": db_problem,
      },
      "default": {"value": masked(key, default_value), "text": definition.default_text},
    },
    # saved here, but the environment wins
    "shadowed": env_set and row is not None,
    "env_matches_database": bool(same),
    "can_import_env": env_set and not same,
    "error": env_problem or db_problem,
  }


def _comparable(definition: Definition, value):
  if definition.type is Records and isinstance(value, list):
    return [{k: v for k, v in r.items() if k != 'id'} for r in value]
  return value


def _is_in_env(name: str) -> bool:
  if name.endswith('*'):
    return any(k.startswith(name[:-1]) and v.strip() for k, v in os.environ.items())
  return bool(os.environ.get(name, '').strip()) or (name == 'QABOARD_ENCRYPTION_KEY' and bool(os.environ.get('QABOARD_ENCRYPTION_KEY_FILE', '').strip()))


def describe_server_variable(variable: ServerVariable) -> dict:
  try:
    value = variable.value() if variable.value else None
  except Exception as e:
    value = f"error: {type(e).__name__}"
  return {
    "key": variable.name,
    "kind": "environment",
    "label": variable.label,
    "group": variable.group,
    "env": variable.name,
    "value": value,
    "is_set": value is not None,
    "secret": variable.secret,
    "source": 'env' if _is_in_env(variable.name) else 'default',
    "description": variable.description,
    "why": variable.why,
    "default_text": variable.default_text,
    "docs": variable.docs,
    "editable": False,
  }


def describe_all() -> list:
  user_names = _user_names()
  return [describe(key, user_names) for key in DEFINITIONS]


def describe_groups() -> list:
  return [group._asdict() for group in GROUPS]


def describe_server() -> list:
  return [describe_server_variable(v) for v in SERVER_VARIABLES]


def stored_secrets():
  """The encrypted values of the settings, for backend/encryption.py"""
  from .models import Setting
  from .encryption import StoredSecret
  for row in Setting.query.all():
    definition = DEFINITIONS.get(row.key)
    if definition is None:
      continue
    value = (row.value or {}).get('value')
    def replacer(path, row=row):
      def replace(encrypted):
        data = json.loads(json.dumps(row.value))
        target = data
        for part in path[:-1]:
          target = target[part]
        target[path[-1]] = {ENCRYPTED: encrypted}
        row.value = data
      return replace
    if definition.type is Records and isinstance(value, list):
      labels = {f.name: f.label for f in definition.fields}
      for i, record in enumerate(value):
        for name, v in (record or {}).items():
          if isinstance(v, dict) and ENCRYPTED in v:
            yield StoredSecret('setting', f"{row.key}: {record.get(definition.record_key) or i + 1}, {labels.get(name, name)}", v[ENCRYPTED], replacer(['value', i, name]))
    elif isinstance(value, dict) and ENCRYPTED in value:
      yield StoredSecret('setting', row.key, value[ENCRYPTED], replacer(['value']))


def plaintext_secrets():
  """(label, plaintext, replace) for secret settings saved before they were encrypted"""
  from .models import Setting
  for row in Setting.query.all():
    definition = DEFINITIONS.get(row.key)
    value = (row.value or {}).get('value')
    if definition is not None and definition.secret and isinstance(value, str) and value:
      def replace(encrypted, row=row):
        row.value = {"value": {ENCRYPTED: encrypted}}
      yield row.key, value, replace
