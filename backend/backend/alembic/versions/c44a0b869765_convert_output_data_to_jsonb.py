"""Convert output.data to JSONB

Revision ID: c44a0b869765
Revises: 8d84dfaf350d
Create Date: 2020-03-25 17:09:15.810682

"""
from alembic import op
import sqlalchemy as sa
import sqlalchemy.dialects.postgresql as postgresql


# revision identifiers, used by Alembic.
revision = 'c44a0b869765'
down_revision = '8d84dfaf350d'
branch_labels = None
depends_on = None


def upgrade():
  op.alter_column('outputs', 'data', type_=postgresql.JSONB, postgresql_using='data::text::jsonb')


def downgrade():
  op.alter_column('outputs', 'data', type_=sa.dialects.postgresql.JSON, postgresql_using='data::jsonb::text')
