"""rename slam_output to output

Revision ID: 6f8f309611c5
Revises: f6a4bc0b55f8
Create Date: 2018-05-22 17:22:36.926716

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = '6f8f309611c5'
down_revision = 'f6a4bc0b55f8'
branch_labels = None
depends_on = None


def upgrade():
  op.rename_table('slam_outputs', 'outputs')

def downgrade():
  op.rename_table('outputs', 'slam_outputs')
