"""Storage locations, and when running runs last reported (heartbeats)

Revision ID: f4b6d8a0c2e4
Revises: e3a5c7d9f1b2
Create Date: 2026-11-18 06:00:00.000000

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision = 'f4b6d8a0c2e4'
down_revision = 'e3a5c7d9f1b2'
branch_labels = None
depends_on = None


def has_table(table):
  return sa.inspect(op.get_bind()).has_table(table)


def has_column(table, column):
  return any(c['name'] == column for c in sa.inspect(op.get_bind()).get_columns(table))


def upgrade():
  if not has_table('storage_locations'):
    op.create_table(
      'storage_locations',
      sa.Column('id', sa.Integer(), primary_key=True),
      sa.Column('url', sa.String(), nullable=False, unique=True),
      sa.Column('path', sa.String(), nullable=False),
      sa.Column('projects', postgresql.JSONB(), nullable=False, server_default='[]'),
      sa.Column('options', postgresql.JSONB(), nullable=False, server_default='{}'),
      sa.Column('created_at', sa.DateTime(), nullable=False, server_default=sa.text('now()')),
      sa.Column('updated_at', sa.DateTime(), nullable=False, server_default=sa.text('now()')),
    )
  if not has_column('outputs', 'reported_at'):
    op.add_column('outputs', sa.Column('reported_at', sa.DateTime(), nullable=True))


def downgrade():
  op.drop_column('outputs', 'reported_at')
  op.drop_table('storage_locations')
