"""Added data JSON field for ci_commit

Revision ID: 847475604161
Revises: 156752e2d05e
Create Date: 2018-07-22 10:25:08.212386

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = '847475604161'
down_revision = '156752e2d05e'
branch_labels = None
depends_on = None


def upgrade():
  op.add_column('ci_commits', sa.Column('data', sa.JSON))


def downgrade():
  op.drop_column("ci_commits", "data")
