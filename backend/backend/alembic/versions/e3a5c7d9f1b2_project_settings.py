"""Project settings: what a project's owners set from its Admin pages (docs/rfcs/project-admin.md)

Revision ID: e3a5c7d9f1b2
Revises: d9f1b3c5e7a4
Create Date: 2026-11-10 06:00:00.000000

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision = 'e3a5c7d9f1b2'
down_revision = 'd9f1b3c5e7a4'
branch_labels = None
depends_on = None


def has_table(table):
  return sa.inspect(op.get_bind()).has_table(table)


def upgrade():
  if not has_table('project_settings'):
    op.create_table(
      'project_settings',
      sa.Column('project_id', sa.String(), primary_key=True),
      sa.Column('data', postgresql.JSONB(), nullable=False, server_default='{}'),
      sa.Column('updated', postgresql.JSONB(), nullable=False, server_default='{}'),
      sa.Column('updated_by_id', sa.Integer(), sa.ForeignKey('users.id', ondelete='SET NULL'), nullable=True),
      sa.Column('updated_at', sa.DateTime(), nullable=False, server_default=sa.text('now()')),
    )


def downgrade():
  op.drop_table('project_settings')
