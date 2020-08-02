"""Add Batch.batch_dir_override

Revision ID: 44c55bb36f57
Revises: c44a0b869765
Create Date: 2020-08-02 05:39:48.915317

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = '44c55bb36f57'
down_revision = 'c44a0b869765'
branch_labels = None
depends_on = None


def upgrade():
  op.add_column('batches', sa.Column('batch_dir_override', sa.String))


def downgrade():
  op.drop_column('batches', 'batch_dir_override')
# 13:27.40
# 13: