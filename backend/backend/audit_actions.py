"""
What the audit log records, in one place: every action (its label, category, and whether projects see it in their
history), and the endpoints that change things without an audit event, with why.

Adding an action: add it to ACTIONS, then call `audit('category.verb', ...)` (backend/audit.py). The web app reads
the labels and icons from /api/v1/audit/actions, and shows `meta` as details: nothing to change there.
Tests fail on an action that isn't here (QABOARD_AUDIT_STRICT, set by the tests) and on a new endpoint that changes
things without an audit event nor a reason in NOT_AUDITED (tests/test_audit_actions.py).
"""
from typing import NamedTuple


class Category(NamedTuple):
  label: str
  # a Blueprint icon name
  icon: str


CATEGORIES = {
  'sign_in': Category("Sign-in", 'log-in'),
  'tokens': Category("Tokens", 'key'),
  'users': Category("Users and groups", 'people'),
  'access': Category("Project access", 'lock'),
  'runs': Category("Runs and batches", 'play'),
  'ci': Category("CI", 'build'),
  'milestones': Category("Milestones", 'flag'),
  'projects': Category("Project settings", 'projects'),
  'storage': Category("Storage", 'database'),
  'jobs': Category("Jobs", 'time'),
  'settings': Category("Server settings", 'cog'),
  'audit': Category("Audit log", 'history'),
}


class Action(NamedTuple):
  # what happened, as a sentence without subject: "Deleted a batch"
  label: str
  category: str
  # shown in the history of the event's project (project_id) to its members, not only to admins
  project: bool = False


ACTIONS = {
  # Sign-in
  'auth.login': Action("Signed in", 'sign_in'),
  'auth.login_failed': Action("Failed to sign in", 'sign_in'),
  'auth.logout': Action("Signed out", 'sign_in'),
  'auth.signup': Action("Signed up", 'sign_in'),
  'session.revoke': Action("Signed out a session", 'sign_in'),
  'session.revoke_all': Action("Signed out all sessions", 'sign_in'),
  'identity.link': Action("Linked a sign-in identity", 'sign_in'),
  'identity.unlink': Action("Unlinked a sign-in identity", 'sign_in'),
  'provider.create': Action("Added a sign-in provider", 'sign_in'),
  'provider.update': Action("Changed a sign-in provider", 'sign_in'),
  'provider.delete': Action("Removed a sign-in provider", 'sign_in'),
  'setup.first_admin': Action("Created the first admin", 'sign_in'),
  'setup.token_rejected': Action("Used a wrong setup token", 'sign_in'),
  # Tokens
  'token.create': Action("Created a token", 'tokens'),
  'token.exchange': Action("Exchanged a CI job's identity for a token", 'tokens'),
  'token.revoke': Action("Revoked a token", 'tokens'),
  'token.new_ip': Action("Token used from a new address", 'tokens'),
  # it creates a CLI token: its own token.create event follows
  'device.approve': Action("Approved a CLI sign-in", 'tokens'),
  'device.deny': Action("Denied a CLI sign-in", 'tokens'),
  # Users and groups
  'user.create': Action("Created a user", 'users'),
  'user.update': Action("Updated a user", 'users'),
  'user.password_change': Action("Changed their password", 'users'),
  'user.password_change_failed': Action("Failed to change their password", 'users'),
  'user.password_reset': Action("Reset a password", 'users'),
  'group.create': Action("Created a group", 'users'),
  'group.update': Action("Changed a group", 'users'),
  'group.delete': Action("Deleted a group", 'users'),
  'group_member.add': Action("Added a group member", 'users'),
  'group_member.remove': Action("Removed a group member", 'users'),
  'group_rule.create': Action("Added a group rule", 'users'),
  'group_rule.delete': Action("Removed a group rule", 'users'),
  'groups.sync': Action("Synced groups from the directory", 'users'),
  'service_account.create': Action("Created a service account", 'users'),
  'service_account.delete': Action("Deleted a service account", 'users'),
  'service_account.ci_trust.create': Action("Trusted CI jobs for a service account", 'users'),
  'service_account.ci_trust.delete': Action("Stopped trusting CI jobs for a service account", 'users'),
  # Project access
  'grant.create': Action("Gave a role", 'access', project=True),
  'grant.update': Action("Changed a role", 'access', project=True),
  'grant.delete': Action("Removed a role", 'access', project=True),
  'visibility.update': Action("Changed the visibility", 'access', project=True),
  'access_request.create': Action("Requested access", 'access', project=True),
  'access_request.update': Action("Updated an access request", 'access', project=True),
  'access_request.approved': Action("Approved an access request", 'access', project=True),
  'access_request.denied': Action("Denied an access request", 'access', project=True),
  # Runs and batches
  'batch.start': Action("Started a batch", 'runs', project=True),
  'batch.redo': Action("Re-ran runs", 'runs', project=True),
  'batch.stop': Action("Stopped a batch", 'runs', project=True),
  'batch.rename': Action("Renamed a batch", 'runs', project=True),
  'batch.move': Action("Moved runs to another batch", 'runs', project=True),
  'batch.delete': Action("Deleted a batch", 'runs', project=True),
  'run.update': Action("Changed a run", 'runs', project=True),
  'run.delete': Action("Deleted a run", 'runs', project=True),
  'runs.fail': Action("Marked runs as failed", 'runs', project=True),
  # CI
  'jenkins.build': Action("Started a Jenkins build", 'ci', project=True),
  'ci.gitlab_job_play': Action("Started a GitLab job", 'ci', project=True),
  'ci.github_workflow_dispatch': Action("Started a GitHub workflow", 'ci', project=True),
  # from the source code (git checkout && qa save-artifacts on the server) or by the CI (recreate_artifacts)
  'artifacts.restore': Action("Restored a commit's artifacts", 'ci', project=True),
  # Milestones
  'milestone.create': Action("Saved a milestone", 'milestones', project=True),
  'milestone.update': Action("Changed a milestone", 'milestones', project=True),
  'milestone.delete': Action("Deleted a milestone", 'milestones', project=True),
  'milestone.import': Action("Imported milestones", 'milestones', project=True),
  # Project settings
  'project_settings.update': Action("Changed the project's settings", 'projects', project=True),
  # Storage
  'storage.delete': Action("Deleted runs' files", 'storage'),
  'storage.delete_exports': Action("Deleted exports", 'storage'),
  'storage.delete_paths': Action("Deleted untracked files", 'storage'),
  'storage.delete_scan': Action("Deleted a storage scan", 'storage'),
  'storage.import_runs': Action("Imported runs from a scan", 'storage'),
  'storage.garbage_collect': Action("Deleted old results", 'storage', project=True),
  'storage_location.create': Action("Added a storage location", 'storage'),
  'storage_location.update': Action("Changed a storage location", 'storage'),
  'storage_location.delete': Action("Removed a storage location", 'storage'),
  # Jobs
  'job.create': Action("Started a job", 'jobs'),
  'job.cancel': Action("Cancelled a job", 'jobs'),
  'job_schedule.create': Action("Scheduled a job", 'jobs'),
  'job_schedule.update': Action("Changed a job schedule", 'jobs'),
  'job_schedule.delete': Action("Removed a job schedule", 'jobs'),
  # Server settings
  'setting.update': Action("Changed a setting", 'settings'),
  'setting.import_env': Action("Saved a setting from the environment", 'settings'),
  'setting.test_email': Action("Sent a test email", 'settings'),
  'encryption.rotate': Action("Re-encrypted the stored secrets", 'settings'),
  'encryption.show_key': Action("Printed the encryption key", 'settings'),
  # Audit log
  'audit.purge': Action("Deleted old audit events", 'audit'),
}

assert all(action.category in CATEGORIES for action in ACTIONS.values())

PROJECT_ACTIONS = sorted(name for name, action in ACTIONS.items() if action.project)


# Endpoints whose events are recorded in a method, that tests/test_audit_actions.py can't follow: where
AUDITED_IN_METHODS = {
  'commit.py:commit_save_artifacts': "CiCommit.restore_artifacts records artifacts.restore",
}


# Endpoints that change things and record no audit event, by "file.py:function" in backend/api/.
# A route that records events through a helper (tokens.issue, locations.add...) needs no entry: the test follows calls.
NOT_AUDITED = {
  # Results sent by `qa run`/`qa batch`/start_run(): the run itself says who sent it (Output.data, its token).
  # Auditing each call would flood the log.
  'commit.py:api_ci_commit': "ingest: CI says which commit it builds",
  'commit_artifacts.py:upload_commit_artifact': "ingest: a commit's artifacts",
  'batch.py:update_batch': "ingest: `qa batch` says which batch it runs",
  'batch.py:append_submission_log': "ingest: a batch's log, only with the batch's own token",
  'outputs.py:new_output_webhook': "ingest: a run's results",
  'outputs.py:add_output_metrics': "ingest: a run's metrics",
  'outputs.py:report_output_progress': "ingest: a run's heartbeat",
  'outputs.py:authorize_upload': "ingest: checks a run may send its files",
  'outputs.py:upload_output_file': "ingest: a run's files",
  'webhooks.py:gitlab_webhook': "git hosts' pushes: deleted branches' batches are audited as batch.delete",
  'webhooks.py:github_webhook': "git hosts' pushes: deleted branches' batches are audited as batch.delete",
  'webhooks.py:gitea_webhook': "git hosts' pushes: deleted branches' batches are audited as batch.delete",
  'webhooks.py:bitbucket_webhook': "git hosts' pushes: deleted branches' batches are audited as batch.delete",
  # POST, but they only read or compute
  'tuning.py:check_tuning': "read-only: validates a batch before it starts",
  'tuning.py:groups': "read-only: lists the batches a project defines",
  'tuning.py:get_group': "read-only: one batch definition",
  'image.py:get_rois': "read-only: an image diff",
  'video.py:get_video_diff': "read-only: a video diff",
  'storage.py:storage_preview': "read-only: what a deletion would delete",
  'admin_jobs.py:admin_estimate_job': "read-only: what a job would do",
  'admin_sign_in.py:admin_test_provider': "read-only: tries a sign-in provider's configuration",
  'export_files.py:export_runs': "a download of files the caller can already read",
  'export_to_folder.py:export_to_folder': "copies runs the caller can read to a folder it shares",
  'integrations.py:gitlab_job': "read-only: a GitLab job's status",
  'integrations.py:github_workflow_run': "read-only: a GitHub workflow's status",
  'integrations.py:jenkins_build': "read-only: a Jenkins build's status (POST for its URL in the body)",
  'integrations.py:proxy_webook': "forwards a project's own webhook; what it starts is audited by its target",
  'storage.py:storage_measure_export': "read-only: measures an export's size",
  # The user's own conveniences
  'users.py:update_preferences': "the user's own preferences",
  'api.py:post_project_view': "the user's own recently viewed projects",
  'milestones.py:favorite_milestone': "the user's own favorites",
  'milestones.py:favorite_group': "the user's own favorites",
  'usage.py:usage_events': "usage analytics, not actions (backend/usage.py)",
  # Sign-in protocol steps: what they lead to (token.create, auth.login) is audited
  'tokens.py:device_code': "starts a CLI sign-in; device.approve and token.create are audited",
  'tokens.py:device_token': "polls a CLI sign-in; device.approve and token.create are audited",
}
