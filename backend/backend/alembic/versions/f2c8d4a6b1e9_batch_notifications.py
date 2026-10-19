"""Notifications when batches end (e.g. an email when tuning started from QA-Board ends)

- batch_notifications: one row per `qa batch` command users want to hear about.
- An index of the pending runs by the command that started them: when a run ends, we check cheaply
  if its command still has pending runs. Only pending runs are indexed, so it stays small.
Also declared in the models, for databases created by the app.

Revision ID: f2c8d4a6b1e9
Revises: b8e1d5c3f9a2
Create Date: 2026-10-19 09:00:00.000000

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision = 'f2c8d4a6b1e9'
down_revision = 'b8e1d5c3f9a2'
branch_labels = None
depends_on = None


index_name = 'idx_outputs_pending_root_command'


def upgrade():
  # The app creates missing tables when it starts (Base.metadata.create_all)
  if not sa.inspect(op.get_bind()).has_table('batch_notifications'):
    op.create_table(
      'batch_notifications',
      sa.Column('id', sa.Integer(), primary_key=True),
      sa.Column('created_date', sa.DateTime(), nullable=False),
      sa.Column('command_id', sa.String(), nullable=False, unique=True),
      sa.Column('channel', sa.String(), nullable=False, server_default='email'),
      sa.Column('user_name', sa.String()),
      sa.Column('recipient', sa.String()),
      sa.Column('ci_commit_id', sa.Integer(), sa.ForeignKey('ci_commits.id', ondelete='CASCADE'), nullable=False, index=True),
      sa.Column('batch_id', sa.Integer(), sa.ForeignKey('batches.id', ondelete='SET NULL'), nullable=True),
      sa.Column('status', sa.String(), nullable=False, server_default='waiting'),
      sa.Column('finished_at', sa.DateTime()),
      sa.Column('sent_at', sa.DateTime()),
      sa.Column('error', sa.Text()),
      sa.Column('data', postgresql.JSONB(), nullable=False, server_default='{}'),
    )

  # outputs is big: CONCURRENTLY doesn't block writes while the index builds, but can't run in a transaction.
  # If it fails, it leaves an INVALID index that IF NOT EXISTS would keep: we drop it and build it again.
  with op.get_context().autocommit_block():
    is_invalid = op.get_bind().execute(sa.text(
      "SELECT 1 FROM pg_index JOIN pg_class ON pg_class.oid = pg_index.indexrelid WHERE pg_class.relname = :name AND NOT pg_index.indisvalid"
    ), {"name": index_name}).first()
    if is_invalid:
      op.drop_index(index_name, table_name='outputs', postgresql_concurrently=True, if_exists=True)
    op.create_index(
      index_name, 'outputs', [sa.text("(data->>'root_command_id')")],
      postgresql_where=sa.text('is_pending'),
      postgresql_concurrently=True, if_not_exists=True,
    )


def downgrade():
  with op.get_context().autocommit_block():
    op.drop_index(index_name, table_name='outputs', postgresql_concurrently=True, if_exists=True)
  op.drop_table('batch_notifications')
