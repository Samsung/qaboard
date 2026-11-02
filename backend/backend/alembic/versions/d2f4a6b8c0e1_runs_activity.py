"""Activity: when runs were queued, started and ended, and the indexes to find what runs now and what ended recently.
Also declared in the models, for databases created by the app.

outputs is big in production (tens of GB), but nothing here rewrites it or blocks writes for long:
- the new columns are nullable without defaults: PostgreSQL only changes its catalog. It still needs a short
  exclusive lock: we give up after a few seconds rather than wait behind long queries (and block every query
  queued behind us). If it times out, run the migration again.
- the indexes are built CONCURRENTLY: writes go on while they're built. It reads the table twice: expect minutes.
  ix_outputs_active only has the pending runs, ix_outputs_finished_at only the runs that end from now on: both stay small.

Revision ID: d2f4a6b8c0e1
Revises: c1e3a5b7d9f2
Create Date: 2026-10-22 18:00:00.000000

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'd2f4a6b8c0e1'
down_revision = 'c1e3a5b7d9f2'
branch_labels = None
depends_on = None


columns = ('queued_at', 'started_at', 'finished_at')
indexes = [
  # name, table, columns, where
  ('ix_outputs_active', 'outputs', ['batch_id'], 'is_pending'),
  ('ix_outputs_finished_at', 'outputs', ['finished_at'], 'finished_at IS NOT NULL'),
  ('ix_batches_submissions', 'batches', ['id'], "data ? 'submissions'"),
]


def upgrade():
  existing = {c['name'] for c in sa.inspect(op.get_bind()).get_columns('outputs')}
  missing = [name for name in columns if name not in existing]
  if missing:
    op.execute("SET LOCAL lock_timeout = '10s'")
    for name in missing:
      op.add_column('outputs', sa.Column(name, sa.DateTime(), nullable=True))

  # CONCURRENTLY can't run in a transaction. If it fails, it leaves an INVALID index, that IF NOT EXISTS
  # would keep: we drop it, and build it again.
  with op.get_context().autocommit_block():
    for name, table, index_columns, where in indexes:
      is_invalid = op.get_bind().execute(sa.text(
        "SELECT 1 FROM pg_index JOIN pg_class ON pg_class.oid = pg_index.indexrelid WHERE pg_class.relname = :name AND NOT pg_index.indisvalid"
      ), {"name": name}).first()
      if is_invalid:
        op.drop_index(name, table_name=table, postgresql_concurrently=True, if_exists=True)
      op.create_index(name, table, index_columns, postgresql_where=sa.text(where), postgresql_concurrently=True, if_not_exists=True)


def downgrade():
  with op.get_context().autocommit_block():
    for name, table, _, _ in indexes:
      op.drop_index(name, table_name=table, postgresql_concurrently=True, if_exists=True)
  for name in columns:
    op.drop_column('outputs', name)
