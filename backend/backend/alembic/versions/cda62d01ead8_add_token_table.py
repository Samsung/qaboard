"""Add Token table

Revision ID: cda62d01ead8
Revises: 9d423882514e
Create Date: 2024-10-31 08:50:21.226634

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

# revision identifiers, used by Alembic.
revision = 'cda62d01ead8'
down_revision = '9d423882514e'
branch_labels = None
depends_on = None


def upgrade():
  op.create_table(
    'tokens',
    sa.Column('id', sa.Integer, primary_key=True),
    sa.Column('user_id', sa.Integer, sa.ForeignKey('users.id'), nullable=False),
    sa.Column('token', sa.String(length=64), nullable=False, unique=True, index=True),
    sa.Column('expires_at', sa.DateTime, nullable=False),
    sa.Column('revoked', sa.Boolean, default=False),
    sa.Column('created_at', sa.DateTime, default=sa.func.now())
  )
  op.create_index(op.f('ix_tokens_token'), 'tokens', ['token'], unique=True)


def downgrade():
  op.drop_index(op.f('ix_tokens_token'), table_name='tokens')
  op.drop_table('tokens')