"""moving to jsonb

Revision ID: bdacefe1d00c
Revises: 5f4fae68863e
Create Date: 2023-10-02 14:33:19.765907

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB


# revision identifiers, used by Alembic.
revision = 'bdacefe1d00c'
down_revision = '5f4fae68863e'
branch_labels = None
depends_on = None



migrated_tables = ("ci_commits", "batches", "outputs", "projects")
# to test for dev,
#  CREATE TABLE outputs_dev AS
#   SELECT * FROM outputs
#   WHERE outputs.id>21301391;
# and ran the migration, and reverted the alembic version manually in the db
# migrated_tables = ("outputs_dev",)
column = "data"


def upgrade():
  for table in migrated_tables:
    op.alter_column(
        table, column, existing_type=sa.JSON, type_=JSONB, postgresql_using=f"{column}::jsonb"
    )

def downgrade():
  for table in migrated_tables:
    op.alter_column(
        table, column, existing_type=JSONB, type_=sa.JSON, postgresql_using=f"{column}::json"
    )
