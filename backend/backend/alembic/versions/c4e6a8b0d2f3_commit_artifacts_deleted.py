"""ci_commits.deleted is renamed artifacts_deleted: it says whether the commit's artifacts were deleted, nothing about
its runs. The cleanup of old results (clean.py) skipped the runs of commits whose artifacts were deleted, so they were
never deleted. It now looks for commits with runs that weren't deleted, with an index of those runs by batch.
Also declared in the models, for databases created by the app.

outputs is big in production (tens of GB): the index is built CONCURRENTLY, writes go on. The rename only changes the
catalog (an instant, short lock).

Revision ID: c4e6a8b0d2f3
Revises: b8d0f2a4c6e1
Create Date: 2026-11-26 10:00:00.000000

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'c4e6a8b0d2f3'
down_revision = 'b8d0f2a4c6e1'
branch_labels = None
depends_on = None

name = 'ix_outputs_live_batch_id'


def columns():
  return {c['name'] for c in sa.inspect(op.get_bind()).get_columns('ci_commits')}


def upgrade():
  if 'deleted' in columns() and 'artifacts_deleted' not in columns():
    op.alter_column('ci_commits', 'deleted', new_column_name='artifacts_deleted')
  # If it fails, CONCURRENTLY leaves an INVALID index that IF NOT EXISTS would keep: we drop it and build it again.
  with op.get_context().autocommit_block():
    is_invalid = op.get_bind().execute(sa.text(
      "SELECT 1 FROM pg_index JOIN pg_class ON pg_class.oid = pg_index.indexrelid WHERE pg_class.relname = :name AND NOT pg_index.indisvalid"
    ), {"name": name}).first()
    if is_invalid:
      op.drop_index(name, table_name='outputs', postgresql_concurrently=True, if_exists=True)
    op.create_index(name, 'outputs', ['batch_id'], postgresql_where=sa.text("deleted IS NOT TRUE"),
                    postgresql_concurrently=True, if_not_exists=True)


def downgrade():
  with op.get_context().autocommit_block():
    op.drop_index(name, table_name='outputs', postgresql_concurrently=True, if_exists=True)
  if 'artifacts_deleted' in columns() and 'deleted' not in columns():
    op.alter_column('ci_commits', 'artifacts_deleted', new_column_name='deleted')
