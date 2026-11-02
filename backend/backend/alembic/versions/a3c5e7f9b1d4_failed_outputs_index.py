"""An index of the failed runs by batch: the home page finds the user's batches with failed runs
(api/api.py get_batches ?status=failed) without reading every run of their batches.
Also declared in the models, for databases created by the app.

outputs is big in production (tens of GB), but few runs fail: the index is small. It's built CONCURRENTLY, writes go on.

Revision ID: a3c5e7f9b1d4
Revises: f1d3b5a7c9e2
Create Date: 2026-10-24 19:00:00.000000

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'a3c5e7f9b1d4'
down_revision = 'f1d3b5a7c9e2'
branch_labels = None
depends_on = None


name = 'ix_outputs_failed'


def upgrade():
  # If it fails, CONCURRENTLY leaves an INVALID index that IF NOT EXISTS would keep: we drop it and build it again.
  with op.get_context().autocommit_block():
    is_invalid = op.get_bind().execute(sa.text(
      "SELECT 1 FROM pg_index JOIN pg_class ON pg_class.oid = pg_index.indexrelid WHERE pg_class.relname = :name AND NOT pg_index.indisvalid"
    ), {"name": name}).first()
    if is_invalid:
      op.drop_index(name, table_name='outputs', postgresql_concurrently=True, if_exists=True)
    op.create_index(name, 'outputs', ['batch_id'], postgresql_where=sa.text("is_failed AND deleted IS NOT TRUE"),
                    postgresql_concurrently=True, if_not_exists=True)


def downgrade():
  with op.get_context().autocommit_block():
    op.drop_index(name, table_name='outputs', postgresql_concurrently=True, if_exists=True)
