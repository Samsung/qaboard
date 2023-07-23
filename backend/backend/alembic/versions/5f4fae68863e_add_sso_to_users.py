"""add_sso_to_users

Revision ID: 5f4fae68863e
Revises: 44c55bb36f57
Create Date: 2023-07-20 09:14:59.224465

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = '5f4fae68863e'
down_revision = '44c55bb36f57'
branch_labels = None
depends_on = None


def upgrade():
    op.add_column('users', sa.Column('is_sso', sa.Boolean))
    op.drop_constraint('users_full_name_key', 'users')

def downgrade():
    op.drop_column("users", "is_sso")
    op.create_unique_constraint('users_full_name_key', 'users', ['full_name'])