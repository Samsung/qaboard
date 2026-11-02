# Git hosts: what's left to do

GitHub, GitLab, Gitea/Forgejo and Bitbucket Cloud are configured with `QABOARD_GIT_HOSTS`
(see `backend/backend/git_hosts/` and website/docs/backend-admin/git-hosts.mdx).
GitHub has webhooks, commit statuses from `qa batch`, CI checks for bit-accuracy, and GitHub Actions integrations.

## Deferred

### GitHub App authentication
- Use GitHub App installation tokens instead of personal access tokens: org-level access, automatic rotation.

### Per-user credentials
- All users share the hosts' tokens (e.g. to start GitHub Actions workflows or GitLab jobs).
  Use the logged-in user's own OAuth token instead.

### Workflows on a given commit
- GitHub's workflow_dispatch only runs on a branch or tag, and doesn't say which run it started:
  we look for a new run of the workflow on that ref for a few seconds.

### Other hosts
- Gitea/Forgejo and Bitbucket: commit statuses from `qa`, and CI integrations (Gitea/Forgejo Actions, Bitbucket Pipelines).
- Bitbucket Data Center webhooks (`repo:refs_changed`): today it can only be a `generic` host (cloning).

### Pull/merge requests
- Show pull requests and merge requests, and link results to them.

### Git clones are not host-qualified
- Project ids and clones are `group/repo`: the same path on two hosts would collide.
