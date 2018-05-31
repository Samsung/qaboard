"""Added misc JSON fields for outputs and inputs

Revision ID: e37bfe94d6e0
Revises: 93a369d8ac64
Create Date: 2018-05-31 12:26:11.914743

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'e37bfe94d6e0'
down_revision = '93a369d8ac64'
branch_labels = None
depends_on = None


def upgrade():
  op.add_column('test_inputs', sa.Column('data', sa.JSON))
  op.add_column('outputs', sa.Column('data', sa.JSON))


def downgrade():
  op.drop_column("test_inputs", "data")
  op.drop_column("outputs", "data")
