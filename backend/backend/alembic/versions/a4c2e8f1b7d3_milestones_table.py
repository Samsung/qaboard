"""Milestones get their own tables, with owners and favorites (of milestones and of groups)

Until now, shared milestones were saved in projects.data['milestones'] (keyed by "project/commit/batch", so only
one per batch) and private ones in browsers. We copy the shared ones to the new table, owned by their first
owner. projects.data['milestones'] is kept: older versions still read it after a rollback.
Browsers move their private milestones to their user's account when they log in (POST /api/v1/milestones/import).

Revision ID: a4c2e8f1b7d3
Revises: e7f3b2a91c40
Create Date: 2026-10-18 09:00:00.000000

"""
import json
import datetime

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision = 'a4c2e8f1b7d3'
down_revision = 'e7f3b2a91c40'
branch_labels = None
depends_on = None


# A copy of backend.milestones.from_legacy as it was: migrations must not change when the app does
def from_legacy(key, milestone, project_id):
  if not isinstance(milestone, dict) or not isinstance(milestone.get('commit'), str) or not milestone['commit']:
    return None
  date = None
  if isinstance(milestone.get('date'), str):
    try:
      date = datetime.datetime.fromisoformat(milestone['date'].replace('Z', '+00:00'))
      if date.tzinfo is not None:
        date = date.astimezone(datetime.timezone.utc).replace(tzinfo=None)
    except ValueError:
      date = None
  commit_project = milestone.get('project')
  data = {k: milestone[k] for k in ('branch', 'committer_name') if isinstance(milestone.get(k), str)}
  data['legacy_key'] = key
  owners = [o for o in milestone.get('owners') or [] if isinstance(o, dict) and isinstance(o.get('user_name'), str)]
  if owners:
    data['legacy_owners'] = owners
  return {
    'project_id': project_id,
    'label': str(milestone.get('label') or '')[:200],
    'group': '',
    'notes': str(milestone.get('notes') or '')[:20_000],
    'commit_hexsha': milestone['commit'],
    'commit_project_id': commit_project if isinstance(commit_project, str) and commit_project != project_id else None,
    'batch': str(milestone.get('batch') or 'default'),
    'filter': str(milestone.get('filter') or ''),
    'data': data,
    'created_at': date,
    'updated_at': date,
  }


def upgrade():
  bind = op.get_bind()
  tables = sa.inspect(bind).get_table_names()
  # The app creates missing tables when it starts (Base.metadata.create_all)
  if 'milestones' not in tables:
    op.create_table(
      'milestones',
      sa.Column('id', sa.Integer, primary_key=True),
      sa.Column('project_id', sa.String(), sa.ForeignKey('projects.id', ondelete='CASCADE'), nullable=False),
      sa.Column('user_id', sa.Integer, sa.ForeignKey('users.id', ondelete='SET NULL'), nullable=True),
      sa.Column('shared', sa.Boolean, nullable=False, server_default='false'),
      sa.Column('label', sa.String(), nullable=False, server_default=''),
      sa.Column('group', sa.String(), nullable=False, server_default=''),
      sa.Column('notes', sa.Text(), nullable=False, server_default=''),
      sa.Column('commit_hexsha', sa.String(), nullable=False),
      sa.Column('commit_project_id', sa.String(), nullable=True),
      sa.Column('batch', sa.String(), nullable=False, server_default='default'),
      sa.Column('filter', sa.String(), nullable=False, server_default=''),
      sa.Column('data', postgresql.JSONB(), nullable=False, server_default='{}'),
      sa.Column('created_at', sa.DateTime, nullable=False, server_default=sa.func.now()),
      sa.Column('updated_at', sa.DateTime, nullable=False, server_default=sa.func.now()),
    )
    op.create_index('ix_milestones_project_id', 'milestones', ['project_id'])
    op.create_index('ix_milestones_user_id', 'milestones', ['user_id'])
    op.create_index('ix_milestones_commit_hexsha', 'milestones', ['commit_hexsha'])
  if 'milestone_favorites' not in tables:
    op.create_table(
      'milestone_favorites',
      sa.Column('user_id', sa.Integer, sa.ForeignKey('users.id', ondelete='CASCADE'), primary_key=True),
      sa.Column('milestone_id', sa.Integer, sa.ForeignKey('milestones.id', ondelete='CASCADE'), primary_key=True),
      sa.Column('created_at', sa.DateTime, nullable=False, server_default=sa.func.now()),
    )
    op.create_index('ix_milestone_favorites_milestone_id', 'milestone_favorites', ['milestone_id'])
  if 'milestone_group_favorites' not in tables:
    op.create_table(
      'milestone_group_favorites',
      sa.Column('user_id', sa.Integer, sa.ForeignKey('users.id', ondelete='CASCADE'), primary_key=True),
      sa.Column('project_id', sa.String(), sa.ForeignKey('projects.id', ondelete='CASCADE'), primary_key=True),
      sa.Column('section', sa.String(), primary_key=True),
      sa.Column('group', sa.String(), primary_key=True),
      sa.Column('created_at', sa.DateTime, nullable=False, server_default=sa.func.now()),
    )

  # Copy the shared milestones, once
  users = dict(bind.execute(sa.text("SELECT user_name, id FROM users WHERE user_name IS NOT NULL")).fetchall())
  imported = {
    (project_id, key)
    for project_id, key in bind.execute(sa.text("SELECT project_id, data->>'legacy_key' FROM milestones WHERE data ? 'legacy_key'")).fetchall()
  }
  # projects.data is json, not jsonb, in databases where bdacefe1d00c_moving_to_jsonb was stamped instead of applied
  projects = bind.execute(sa.text(
    "SELECT id, CAST(data AS jsonb)->'milestones' FROM projects WHERE jsonb_typeof(CAST(data AS jsonb)->'milestones') = 'object'"
  )).fetchall()
  insert = sa.text("""
    INSERT INTO milestones (project_id, user_id, shared, label, "group", notes, commit_hexsha, commit_project_id, batch, filter, data, created_at, updated_at)
    VALUES (:project_id, :user_id, true, :label, :group, :notes, :commit_hexsha, :commit_project_id, :batch, :filter, CAST(:data AS jsonb),
            COALESCE(:created_at, now()), COALESCE(:updated_at, now()))
  """)
  count, skipped = 0, 0
  for project_id, milestones in projects:
    if isinstance(milestones, str):
      milestones = json.loads(milestones)
    for key, milestone in (milestones or {}).items():
      if (project_id, key) in imported:
        continue
      fields = from_legacy(key, milestone, project_id)
      if fields is None:
        print(f"WARNING: skipping the milestone {key} of {project_id}, it has no commit: {milestone}")
        skipped += 1
        continue
      owners = [users[o['user_name']] for o in fields['data'].get('legacy_owners', []) if o['user_name'] in users]
      # One bad milestone must not abort the migration: migrate.sh would then just stamp it, and copy nothing
      try:
        with bind.begin_nested():
          bind.execute(insert, {**fields, 'user_id': owners[0] if owners else None, 'data': json.dumps(fields['data'])})
        count += 1
      except Exception as e:
        print(f"WARNING: could not copy the milestone {key} of {project_id}: {e}")
        skipped += 1
  print(f"Copied {count} shared milestones" + (f", skipped {skipped} (see the warnings above)" if skipped else ""))


def downgrade():
  # projects.data['milestones'] still has the milestones from before the upgrade
  op.drop_table('milestone_group_favorites')
  op.drop_table('milestone_favorites')
  op.drop_table('milestones')
