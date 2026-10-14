"""
Minimal push webhooks from each type of git host, with the fields we use.
"""

def gitlab_push(web_url="https://gitlab.example.com/group/repo"):
  # https://docs.gitlab.com/ee/user/project/integrations/webhook_events.html#push-events
  return {
    "object_kind": "push",
    "ref": "refs/heads/feature/x",
    "checkout_sha": "da1560886d4f094c3e6c9ef40349f7d38b5d27d7",
    "user_name": "John Smith",
    "user_username": "jsmith",
    "user_email": "john@example.com",
    "user_avatar": "https://gitlab.example.com/uploads/-/system/user/avatar/4/avatar.png",
    "project": {
      "id": 15,
      "name": "repo",
      "description": "A project",
      "web_url": web_url,
      "avatar_url": None,
      "git_ssh_url": "git@gitlab.example.com:group/repo.git",
      "git_http_url": f"{web_url}.git",
      "namespace": "group",
      "visibility_level": 0,
      "path_with_namespace": "group/repo",
      "default_branch": "master",
    },
    "commits": [
      {"id": "da1560886d4f094c3e6c9ef40349f7d38b5d27d7", "author": {"name": "Jane Doe", "email": "jane@example.com"}},
    ],
  }


def github_push(html_url="https://github.com/org/repo"):
  # https://docs.github.com/en/webhooks/webhook-events-and-payloads#push
  return {
    "ref": "refs/heads/main",
    "before": "0" * 40,
    "after": "6113728f27ae82c7b1a177c8d03f9e96e0adf246",
    "deleted": False,
    "repository": {
      "id": 1296269,
      "name": "repo",
      "full_name": "org/repo",
      "html_url": html_url,
      "description": "This your first repo!",
      "default_branch": "main",
      "clone_url": f"{html_url}.git",
      "ssh_url": "git@github.com:org/repo.git",
      "owner": {"login": "org", "avatar_url": "https://avatars.githubusercontent.com/u/1?v=4"},
    },
    "pusher": {"name": "octocat", "email": "octocat@github.com"},
    "sender": {"login": "octocat", "avatar_url": "https://avatars.githubusercontent.com/u/583231?v=4"},
    "commits": [{
      "id": "6113728f27ae82c7b1a177c8d03f9e96e0adf246",
      "author": {"name": "The Octocat", "email": "octocat@github.com", "username": "octocat"},
      "committer": {"name": "GitHub", "email": "noreply@github.com", "username": "web-flow"},
    }],
  }


def gitea_push(html_url="https://codeberg.org/org/repo"):
  # https://docs.gitea.com/usage/webhooks
  return {
    "ref": "refs/heads/main",
    "before": "0" * 40,
    "after": "bffeb74224043ba2feb48d137756c8a9331c449a",
    "repository": {
      "name": "repo",
      "full_name": "org/repo",
      "html_url": html_url,
      "description": "",
      "default_branch": "main",
      "avatar_url": "",
      "clone_url": f"{html_url}.git",
      "owner": {"login": "org", "avatar_url": "https://codeberg.org/avatars/1"},
    },
    "pusher": {"login": "gitea", "full_name": "Gitea User", "email": "gitea@example.com", "avatar_url": "https://codeberg.org/avatars/2"},
    "sender": {"login": "gitea", "full_name": "Gitea User", "email": "gitea@example.com", "avatar_url": "https://codeberg.org/avatars/2"},
    "commits": [{
      "id": "bffeb74224043ba2feb48d137756c8a9331c449a",
      "author": {"name": "Gitea User", "email": "gitea@example.com", "username": "gitea"},
    }],
  }


def bitbucket_push(href="https://bitbucket.org/workspace/repo"):
  # https://support.atlassian.com/bitbucket-cloud/docs/event-payloads/#Push
  return {
    "actor": {"display_name": "Emma", "nickname": "emma", "links": {"avatar": {"href": "https://avatar-management.example.com/emma.png"}}},
    "repository": {
      "name": "repo",
      "full_name": "workspace/repo",
      "links": {"html": {"href": href}, "avatar": {"href": "https://bytebucket.org/ravatar/repo"}},
    },
    "push": {"changes": [{
      "old": {"type": "branch", "name": "main"},
      "new": {"type": "branch", "name": "main", "target": {"hash": "709d658dc5b6d6afcd46049c2f332ee3f515a67d"}},
      "commits": [{
        "hash": "709d658dc5b6d6afcd46049c2f332ee3f515a67d",
        "author": {"raw": "Emma <emma@example.com>", "user": {"display_name": "Emma", "nickname": "emma"}},
      }],
    }]},
  }
