"""
GitHub (github.com or GitHub Enterprise Server)
"""
from .base import GitHost, hmac_sha256, same_secret


class GitHubHost(GitHost):
  type = 'github'
  webhook = 'github'
  token_user = 'x-access-token'
  # https://github.com/<login>.png redirects to the user's avatar, also on GitHub Enterprise
  default_user_avatar_url = '{url}/{username}.png'

  def default_api_url(self):
    if self.hostname == 'github.com':
      return 'https://api.github.com'
    return f"{self.url}/api/v3"

  def api_headers(self):
    return {
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      **super().api_headers(),
    }

  @classmethod
  def check_webhook_secret(cls, headers, body, secret):
    # https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries
    return same_secret(headers.get('X-Hub-Signature-256'), 'sha256=' + hmac_sha256(secret, body))

  @classmethod
  def repository_url(cls, payload):
    return (payload.get('repository') or {}).get('html_url')

  @classmethod
  def is_push(cls, payload, headers):
    return headers.get('X-GitHub-Event', 'push') == 'push'

  @classmethod
  def parse_push(cls, payload, headers):
    # https://docs.github.com/en/webhooks/webhook-events-and-payloads#push
    if not cls.is_push(payload, headers):
      return None
    repo = payload['repository']
    owner = repo.get('owner') or {}
    sender = payload.get('sender') or {}
    committers = []
    for commit in payload.get('commits') or []:
      for person in (commit.get('author'), commit.get('committer')):
        if person:
          committers.append({"name": person.get('name'), "email": person.get('email'), "username": person.get('username')})
    # Only the sender has an avatar
    for c in committers:
      if c['username'] and c['username'] == sender.get('login'):
        c['avatar_url'] = sender.get('avatar_url')
    return {
      "ref": payload['ref'],
      "checkout_sha": None if payload.get('deleted') else payload.get('after'),
      "project": {
        "path_with_namespace": repo['full_name'],
        "web_url": repo['html_url'],
        "name": repo['name'],
        "description": repo.get('description'),
        "avatar_url": owner.get('avatar_url'),
        "default_branch": repo.get('default_branch') or repo.get('master_branch'),
        "namespace": owner.get('login'),
        "git_http_url": repo.get('clone_url'),
        "git_ssh_url": repo.get('ssh_url'),
      },
      "committers": committers,
    }
