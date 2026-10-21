"""User management, part 3: roles on projects, groups, visibility

- groups, group_members, group_rules: groups, filled by admins or by sign-in claims
- role_grants: viewer/developer/owner for users and groups, on all projects or on a project and the ones under it
- project_visibility: public/internal/private for a project and the ones under it
- access_requests: + resource_id, role, for project access requests
Nothing is seeded: the defaults (projects.default_visibility, projects.signed_in_role) keep today's behaviour.
Also declared in the models, for databases created by the app.

Revision ID: e5a7c9b1d3f4
Revises: b8c0d2e4f6a8
Create Date: 2026-10-21 10:00:00.000000

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision = 'e5a7c9b1d3f4'
down_revision = 'b8c0d2e4f6a8'
branch_labels = None
depends_on = None


def has_table(table):
  return sa.inspect(op.get_bind()).has_table(table)


def has_column(table, column):
  return any(c['name'] == column for c in sa.inspect(op.get_bind()).get_columns(table))


def upgrade():
  if not has_table('groups'):
    op.create_table(
      'groups',
      sa.Column('id', sa.Integer(), primary_key=True),
      sa.Column('name', sa.String(), nullable=False, unique=True),
      sa.Column('description', sa.Text(), nullable=False, server_default=''),
      sa.Column('created_at', sa.DateTime(), nullable=False),
    )
  if not has_table('group_members'):
    op.create_table(
      'group_members',
      sa.Column('id', sa.Integer(), primary_key=True),
      sa.Column('group_id', sa.Integer(), sa.ForeignKey('groups.id', ondelete='CASCADE'), nullable=False, index=True),
      sa.Column('user_id', sa.Integer(), sa.ForeignKey('users.id', ondelete='CASCADE'), nullable=False, index=True),
      sa.Column('source', sa.String(), nullable=False, server_default='manual'),
      sa.Column('added_by_id', sa.Integer(), sa.ForeignKey('users.id', ondelete='SET NULL'), nullable=True),
      sa.Column('added_at', sa.DateTime(), nullable=False),
      sa.UniqueConstraint('group_id', 'user_id', name='uq_group_members_group_user'),
    )
  if not has_table('group_rules'):
    op.create_table(
      'group_rules',
      sa.Column('id', sa.Integer(), primary_key=True),
      sa.Column('group_id', sa.Integer(), sa.ForeignKey('groups.id', ondelete='CASCADE'), nullable=False, index=True),
      sa.Column('provider_id', sa.String(), nullable=True),
      sa.Column('claim', sa.String(), nullable=False),
      sa.Column('values', postgresql.JSONB(), nullable=False, server_default='[]'),
      sa.Column('created_at', sa.DateTime(), nullable=False),
    )
  if not has_table('role_grants'):
    op.create_table(
      'role_grants',
      sa.Column('id', sa.Integer(), primary_key=True),
      sa.Column('subject_type', sa.String(), nullable=False),
      sa.Column('subject_id', sa.Integer(), nullable=False, index=True),
      sa.Column('resource_type', sa.String(), nullable=False),
      sa.Column('resource_id', sa.String(), nullable=False, server_default='', index=True),
      sa.Column('role', sa.String(), nullable=False),
      sa.Column('source', sa.String(), nullable=False, server_default='manual'),
      sa.Column('granted_by_id', sa.Integer(), sa.ForeignKey('users.id', ondelete='SET NULL'), nullable=True),
      sa.Column('granted_at', sa.DateTime(), nullable=False),
      sa.Column('expires_at', sa.DateTime(), nullable=True),
      sa.UniqueConstraint('subject_type', 'subject_id', 'resource_type', 'resource_id', name='uq_role_grants_subject_resource'),
    )
  if not has_table('project_visibility'):
    op.create_table(
      'project_visibility',
      sa.Column('path', sa.String(), primary_key=True),
      sa.Column('visibility', sa.String(), nullable=False),
      sa.Column('updated_by_id', sa.Integer(), sa.ForeignKey('users.id', ondelete='SET NULL'), nullable=True),
      sa.Column('updated_at', sa.DateTime(), nullable=False),
    )
  if not has_column('access_requests', 'resource_id'):
    op.add_column('access_requests', sa.Column('resource_id', sa.String(), nullable=True))
    op.create_index('ix_access_requests_resource_id', 'access_requests', ['resource_id'])
  if not has_column('access_requests', 'role'):
    op.add_column('access_requests', sa.Column('role', sa.String(), nullable=True))


def downgrade():
  op.drop_index('ix_access_requests_resource_id', 'access_requests')
  op.drop_column('access_requests', 'role')
  op.drop_column('access_requests', 'resource_id')
  op.drop_table('project_visibility')
  op.drop_table('role_grants')
  op.drop_table('group_rules')
  op.drop_table('group_members')
  op.drop_table('groups')
