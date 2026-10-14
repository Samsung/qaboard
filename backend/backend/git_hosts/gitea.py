"""
Gitea and Forgejo (e.g. Codeberg). Their webhooks look like GitHub's.
"""
from .base import GitHost, hmac_sha256, same_secret


ZERO_SHA = '0' * 40


class GiteaHost(GitHost):
  type = 'gitea'
  webhook = 'gitea'
  token_user = 'oauth2' # any user name works when the password is a token
  default_user_avatar_url = '{url}/user/avatar/{username}/-1'

  def default_api_url(self):
    return f"{self.url}/api/v1"

  def api_headers(self):
    return {"Authorization": f"token {self.token}"} if self.token else {}

  @classmethod
  def check_webhook_secret(cls, headers, body, secret):
    # https://docs.gitea.com/usage/webhooks, https://forgejo.org/docs/latest/user/webhooks/
    expected = hmac_sha256(secret, body)
    for header in ('X-Forgejo-Signature', 'X-Gitea-Signature', 'X-Gogs-Signature'):
      if headers.get(header):
        return same_secret(headers[header], expected)
    return same_secret(headers.get('X-Hub-Signature-256'), f"sha256={expected}")

  @classmethod
  def repository_url(cls, payload):
    return (payload.get('repository') or {}).get('html_url')

  @classmethod
  def is_push(cls, payload, headers):
    event = headers.get('X-Forgejo-Event') or headers.get('X-Gitea-Event') or headers.get('X-Gogs-Event') or 'push'
    return event == 'push'

  @classmethod
  def parse_push(cls, payload, headers):
    if not cls.is_push(payload, headers):
      return None
    repo = payload['repository']
    owner = repo.get('owner') or {}
    committers = []
    for commit in payload.get('commits') or []:
      for person in (commit.get('author'), commit.get('committer')):
        if person:
          committers.append({"name": person.get('name'), "email": person.get('email'), "username": person.get('username')})
    for user in (payload.get('pusher'), payload.get('sender')):
      if user:
        committers.append({
          "name": user.get('full_name') or user.get('login'),
          "email": user.get('email'),
          "username": user.get('login') or user.get('username'),
          "avatar_url": user.get('avatar_url'),
        })
    after = payload.get('after')
    return {
      "ref": payload['ref'],
      "checkout_sha": None if not after or after == ZERO_SHA else after,
      "project": {
        "path_with_namespace": repo['full_name'],
        "web_url": repo['html_url'],
        "name": repo['name'],
        "description": repo.get('description'),
        "avatar_url": repo.get('avatar_url') or owner.get('avatar_url'),
        "default_branch": repo.get('default_branch'),
        "namespace": owner.get('login') or owner.get('username'),
        "git_http_url": repo.get('clone_url'),
        "git_ssh_url": repo.get('ssh_url'),
      },
      "committers": committers,
    }
