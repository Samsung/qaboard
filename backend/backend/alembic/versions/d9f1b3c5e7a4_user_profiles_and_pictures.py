"""Users' profiles and pictures, from their sign-in methods (backend/sign_in/profiles.py)

- users.profile: title, department, organization, and which picture we have: refreshed at each sign-in and daily
- user_pictures: the pictures themselves, served by /api/v1/users/<id>/picture

Revision ID: d9f1b3c5e7a4
Revises: c7e1a9d3b5f2
Create Date: 2026-11-06 10:00:00.000000

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision = 'd9f1b3c5e7a4'
down_revision = 'c7e1a9d3b5f2'
branch_labels = None
depends_on = None


def has_table(table):
  return sa.inspect(op.get_bind()).has_table(table)


def has_column(table, column):
  return any(c['name'] == column for c in sa.inspect(op.get_bind()).get_columns(table))


def upgrade():
  if not has_column('users', 'profile'):
    op.add_column('users', sa.Column('profile', postgresql.JSONB(), nullable=False, server_default='{}'))
  if not has_table('user_pictures'):
    op.create_table(
      'user_pictures',
      sa.Column('user_id', sa.Integer(), sa.ForeignKey('users.id', ondelete='CASCADE'), primary_key=True),
      sa.Column('content_type', sa.String(), nullable=False),
      sa.Column('data', sa.LargeBinary(), nullable=False),
      sa.Column('sha256', sa.String(64), nullable=False),
      sa.Column('source', sa.String(), nullable=True),
      sa.Column('source_url', sa.Text(), nullable=True),
      sa.Column('updated_at', sa.DateTime(), nullable=False),
    )


def downgrade():
  op.drop_table('user_pictures')
  op.drop_column('users', 'profile')
