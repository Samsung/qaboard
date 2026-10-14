"""Describe the git host of projects: add `hosting_type` and `host` to projects.data['git']

Revision ID: d1a6c0f9e2b3
Revises: 3b7e9c1d4a52
Create Date: 2026-10-06 12:00:00.000000

Before git hosts were configurable, projects.data['git'] was GitLab's push webhook `project`,
or for GitHub a few fields and hosting_type='github'. We find the host of each project (see backend/git_hosts)
from its web_url, or qaboard.yaml's project.url, and the configured hosts. Like before, we default to GITLAB_HOST.

Data only: idempotent (only projects without hosting_type or host are updated), in batches.
The code still works with projects that were not migrated, so the downgrade does nothing.
"""
import json

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'd1a6c0f9e2b3'
down_revision = '3b7e9c1d4a52'
branch_labels = None
depends_on = None

BATCH_SIZE = 500


def upgrade():
  from backend.git_hosts import git_hosts
  if git_hosts.errors:
    # We'd describe projects with the wrong hosts, for good. The code works with projects that were not migrated,
    # and push webhooks describe projects again.
    print(f"WARNING: not describing the git host of projects, the git host settings are invalid: {git_hosts.errors}")
    return
  connection = op.get_bind()
  last_id, updated = '', 0
  while True:
    rows = connection.execute(sa.text("""
      SELECT id, data->'git', data->'qatools_config'->'project'->>'url'
      FROM projects
      WHERE id > :last_id
        AND jsonb_typeof(data->'git') = 'object'
        AND (data->'git'->>'hosting_type' IS NULL OR data->'git'->>'host' IS NULL)
      ORDER BY id
      LIMIT :limit
    """), {"last_id": last_id, "limit": BATCH_SIZE}).fetchall()
    if not rows:
      break
    for project_id, git, project_url in rows:
      described = git_hosts.describe(git, project_url)
      if described == git: # unknown host
        continue
      connection.execute(
        sa.text("UPDATE projects SET data = jsonb_set(data, '{git}', CAST(:git AS jsonb)) WHERE id = :id"),
        {"git": json.dumps(described), "id": project_id},
      )
      updated += 1
    last_id = rows[-1][0]
  print(f"Described the git host of {updated} projects")


def downgrade():
  pass
