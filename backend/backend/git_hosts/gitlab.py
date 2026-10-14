"""
GitLab (gitlab.com or self-managed)
"""
import time

from .base import GitHost, same_secret, is_email
from ..hybrid_cache import hybrid_cache


class GitLabHost(GitHost):
  type = 'gitlab'
  webhook = 'gitlab'
  token_user = 'oauth2'

  def __init__(self, *args, **kwargs):
    super().__init__(*args, **kwargs)
    self._users_per_name = {}
    self._users_failed_at = -float('inf')

  def default_api_url(self):
    return f"{self.url}/api/v4"

  def api_headers(self):
    return {"Private-Token": self.token} if self.token else {}

  @classmethod
  def check_webhook_secret(cls, headers, body, secret):
    # https://docs.gitlab.com/ee/user/project/integrations/webhooks.html#validate-payloads-by-using-a-secret-token
    return same_secret(headers.get('X-Gitlab-Token'), secret)

  @classmethod
  def repository_url(cls, payload):
    return (payload.get('project') or {}).get('web_url')

  @classmethod
  def is_push(cls, payload, headers):
    return payload.get('object_kind', 'push') in ('push', 'tag_push')

  @classmethod
  def parse_push(cls, payload, headers):
    # https://docs.gitlab.com/ee/user/project/integrations/webhook_events.html#push-events
    if not cls.is_push(payload, headers):
      return None
    committers = [
      {"name": c['author'].get('name'), "email": c['author'].get('email')}
      for c in payload.get('commits') or [] if c.get('author')
    ]
    committers.append({
      "name": payload.get('user_name'),
      "username": payload.get('user_username'),
      "email": payload.get('user_email'),
      "avatar_url": payload.get('user_avatar'),
    })
    return {
      "ref": payload['ref'],
      "checkout_sha": payload.get('checkout_sha'),
      # We keep all of GitLab's fields: users' integrations may use them, e.g. ${git.id}
      "project": dict(payload['project']),
      "committers": committers,
    }

  def avatar_url(self, name, committer=None):
    user = self.find_user(name)
    if user:
      avatar_url = user.get('avatar_url') or ''
      # Users who never uploaded an avatar get a gravatar, some companies have their own
      if self.user_avatar_url and 'gravatar' in avatar_url and user.get('username') and not is_ldap_guest(user):
        return self.user_avatar_url.format(url=self.url, username=user['username'])
      return avatar_url
    return super().avatar_url(name, committer)

  def find_user(self, name):
    """Tries to match a commit's author name to a GitLab user."""
    if not self.token or not name:
      return None
    if name not in self._users_per_name:
      # If GitLab is down, we don't retry for each commit
      if time.monotonic() - self._users_failed_at < 10 * 60:
        return None
      try:
        users = gitlab_users(self)
      except Exception as e:
        print(f"WARNING: Could not list the users of {self}: {e}")
        self._users_failed_at = time.monotonic()
        return None
      key = name.lower()
      candidates = (key, key.replace('.', ''), key.replace(' ', ''), key.replace(' ', '.'))
      self._users_per_name[name] = next((users[k] for k in candidates if k in users), None)
    return self._users_per_name[name]


def is_ldap_guest(user):
  return any('ou=guests' in (i.get('extern_uid') or '') for i in user.get('identities') or [])


@hybrid_cache(ttl=12*60*60) # 12h. The key is the host's repr: its URL, not its token.
def gitlab_users(host):
  """
  All the users of a GitLab host, by every name a commit author could use:
  name, username, email (needs an admin token), "first.last", "flast"...
  """
  users_db = {}
  page = 1
  while True:
    r = host.api('GET', '/users', params={'per_page': 100, 'page': page}, timeout=60)
    r.raise_for_status()
    users_on_page = r.json()
    if not users_on_page:
      break
    print(f"GET {host.api_url}/users page={page}: {len(users_on_page)} users")
    for u in users_on_page:
      if is_email(u.get('email')):
        users_db[u['email']] = u
        email_base = u['email'].split('@')[0]
        users_db[email_base] = u
        users_db[email_base.lower()] = u
        users_db[email_base.lower().replace('.', '')] = u
      users_db[u['name'].lower()] = u
      users_db[u['username'].lower()] = u
      try:
        first_name, family_name = u['name'].lower().split(' ')
      except ValueError:
        continue
      users_db[first_name[0] + family_name[:5]] = u
      users_db[f'{first_name}.{family_name}'] = u
      users_db.setdefault(first_name, u)
    page += 1
  return users_db
