"""add an output_dir_override folder

Revision ID: 10dea94d2dc1
Revises: 6f8f309611c5
Create Date: 2018-05-23 11:43:43.030517

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = '10dea94d2dc1'
down_revision = '6f8f309611c5'
branch_labels = None
depends_on = None


def upgrade():
  op.add_column('outputs', sa.Column('output_dir_override', sa.String))

def downgrade():
  op.drop_column('outputs', 'output_dir_override')
