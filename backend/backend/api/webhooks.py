"""
Here is the "write" part of the API, to signal more data is ready.
It includes the actual webhooks sent by git hosts (GitLab, GitHub...), as well as
API calls to update batches and outputs.
"""
import sys
import json

from flask import request, jsonify
from sqlalchemy.orm.attributes import flag_modified

from backend import app, db_session
from ..models import CiCommit, Output, Project
from ..models.Project import update_project
from ..git_hosts import git_hosts, committers, HOST_TYPES, UntrustedHost
from .auth import login_required


@app.route('/api/v1/commit/<path:project_id>/<commit_id>/batches', methods=['DELETE'])
@app.route('/api/v1/commit/<path:project_id>/<commit_id>/batches/', methods=['DELETE'])
@app.route('/api/v1/commit/<commit_id>/batches', methods=['DELETE'])
@app.route('/api/v1/commit/<commit_id>/batches/', methods=['DELETE'])
@login_required
def delete_commit(commit_id, project_id=None):
  try:
    ci_commits = CiCommit.query.filter(CiCommit.hexsha == commit_id)
    if project_id:
      ci_commits = ci_commits.filter(CiCommit.project_id == project_id)
    for ci_commit in ci_commits.yield_per(1000):
      print("DELETING", ci_commit)
      if ci_commit.hexsha in ci_commit.project.milestone_commits:
        return f"403 ERROR: Cannot delete milestones", 403
      for batch in ci_commit.batches:
        print(f" > {batch}")
        stop_status = batch.stop(db_session)
        if "error" in stop_status:
          return jsonify(stop_status), 500
        batch.delete(session=db_session)
      return {"status": "OK"}
  except Exception as e:
    return f"404 ERROR {e}: {commit_id} in {project_id}", 404
  return f"404 ERROR: Cannot find commit", 404



# ==========================================
# Push webhooks from git hosts
# ==========================================
# When git hosts call us on every push, we update our local copy of the repository,
# the projects and their qaboard.yaml configuration, and learn about committers to show their avatars.
#
# Webhooks must prove they know their host's `webhook_secret` (default: QABOARD_WEBHOOK_SECRET),
# e.g. GitLab's "Secret token" or GitHub's "Secret". See git_hosts/__init__.py
# Anyone can call us: until we checked the secret, we only do cheap work (no parsing besides JSON).

# GitHub caps push payloads at 25MB, and the other hosts send less: we never refuse a real push.
# Parsing is linear in the payload's size (keep it so: no regular expressions that backtrack).
MAX_WEBHOOK_SIZE = 25 * 1024 * 1024


def receive_push(host_type):
  host_class = HOST_TYPES[host_type]
  if git_hosts.errors:
    return jsonify({"error": "The server's git hosts settings are invalid: webhooks are refused until they are fixed. See the server's logs."}), 503
  if (request.content_length or 0) > MAX_WEBHOOK_SIZE:
    return jsonify({"error": "Payload too large"}), 413
  body = request.stream.read(MAX_WEBHOOK_SIZE + 1)
  if len(body) > MAX_WEBHOOK_SIZE:
    return jsonify({"error": "Payload too large"}), 413
  try:
    payload = json.loads(body)
    if not isinstance(payload, dict):
      raise ValueError("expected a JSON object")
    repo_url = host_class.repository_url(payload)
    is_push = host_class.is_push(payload, request.headers)
  except (ValueError, TypeError, AttributeError) as e:
    return jsonify({"error": f"Invalid webhook payload: {e}"}), 400

  # We check the secret of the host the repository is on
  host = git_hosts.find(repo_url, host_class.type) if isinstance(repo_url, str) and repo_url else None
  if not host and host_class.type == 'gitlab':
    # Like before git hosts were configurable: GitLab pushes are from GITLAB_HOST, maybe under another hostname
    host = git_hosts.of_type('gitlab')
  if not host:
    if not is_push: # e.g. GitHub's "ping" for organization webhooks
      return jsonify({"status": "ignored", "reason": "not a push event"})
    return jsonify({"error": f"Unknown git host for {repo_url}. Add it to QABOARD_GIT_HOSTS."}), 403
  if not host.webhook_secret and git_hosts.has_webhook_secrets():
    return jsonify({"error": f"Other git hosts have a webhook secret, but not {host.url}: set its webhook_secret in QABOARD_GIT_HOSTS."}), 401
  if not host_class.is_webhook_authentic(request.headers, body, host.webhook_secret):
    return jsonify({"error": "Invalid webhook secret"}), 401

  try:
    push = host_class.parse_push(payload, request.headers)
  except (KeyError, TypeError, ValueError, AttributeError, IndexError) as e:
    return jsonify({"error": f"Invalid {host_type} push webhook: {e!r}"}), 400
  if push is None:
    return jsonify({"status": "ignored", "reason": "not a push event"})
  repository = push['project'].get('path_with_namespace')
  print(f"Push to {repository} on {host}: {push['ref']} {push['checkout_sha']}", file=sys.stderr)
  existing_host = project_host(repository)
  if existing_host and (existing_host.type, existing_host.hostname) != (host.type, host.hostname):
    # Project ids are repository paths, they don't say on which host: a repository on another host would replace it
    return jsonify({"error": f"The project {repository} is a repository on {existing_host.url}, not on {host.url}."}), 409
  committers.remember(push['committers'], host_url=host.url)
  push['project'] = host.describe(push['project'])
  update_project(push, db_session)
  return jsonify({"status": "OK"})


def project_host(project_id):
  """The host of an existing project, if push events told us (the CLI doesn't)."""
  if not isinstance(project_id, str):
    return None
  project = Project.query.filter(Project.id == project_id).one_or_none()
  git = (project.data or {}).get('git') if project else None
  if not isinstance(git, dict) or not (git.get('host') or git.get('web_url')):
    return None
  try:
    return git_hosts.for_repo(git)
  except UntrustedHost:
    return None # its host is not configured anymore


@app.route('/webhook/gitlab', methods=['GET', 'POST'])
def gitlab_webhook():
  # https://docs.gitlab.com/ee/user/project/integrations/webhooks.html
  return receive_push('gitlab')


@app.route('/webhook/github', methods=['GET', 'POST'])
def github_webhook():
  # https://docs.github.com/en/webhooks/webhook-events-and-payloads#push
  return receive_push('github')


@app.route('/webhook/gitea', methods=['GET', 'POST'])
@app.route('/webhook/forgejo', methods=['GET', 'POST'])
def gitea_webhook():
  # https://docs.gitea.com/usage/webhooks, https://forgejo.org/docs/latest/user/webhooks/
  return receive_push('gitea')


@app.route('/webhook/bitbucket', methods=['GET', 'POST'])
def bitbucket_webhook():
  # https://support.atlassian.com/bitbucket-cloud/docs/event-payloads/#Push
  return receive_push('bitbucket')
