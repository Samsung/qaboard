"""Added data JSON field for batch

Revision ID: 7bb944065bfd
Revises: 847475604161
Create Date: 2018-09-26 13:57:11.786313

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = '7bb944065bfd'
down_revision = '847475604161'
branch_labels = None
depends_on = None


def upgrade():
  op.add_column('batches', sa.Column('data', sa.JSON))


def downgrade():
  op.drop_column("batches", "data")
