"""Service accounts: users.owner_type and users.owner_id say who manages a service account (kind "service")

- owner_type "instance": the admins. owner_type "project": the owners of the project in owner_id, and its tokens
  can't reach outside of it.
Users already had `kind` (human/service). Also declared in the model, for databases created by the app.
Older versions of QA-Board ignore the columns: service accounts' tokens then work like any user's.

Revision ID: b6d8f0a2c4e6
Revises: fdaa945682a8
Create Date: 2026-10-27 10:00:00.000000

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'b6d8f0a2c4e6'
down_revision = 'fdaa945682a8'
branch_labels = None
depends_on = None


def has_column(table, column):
  return any(c['name'] == column for c in sa.inspect(op.get_bind()).get_columns(table))


def has_index(table, index):
  return any(i['name'] == index for i in sa.inspect(op.get_bind()).get_indexes(table))


def upgrade():
  if not has_column('users', 'owner_type'):
    op.add_column('users', sa.Column('owner_type', sa.String(), nullable=True))
  if not has_column('users', 'owner_id'):
    op.add_column('users', sa.Column('owner_id', sa.String(), nullable=True))
  if not has_index('users', 'ix_users_owner_id'):
    op.create_index('ix_users_owner_id', 'users', ['owner_id'])


def downgrade():
  op.drop_index('ix_users_owner_id', 'users')
  op.drop_column('users', 'owner_id')
  op.drop_column('users', 'owner_type')
