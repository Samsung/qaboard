"""Storage usage per batch and user (backend/storage_usage.py), and an index to find the commits with new runs.
Also declared in the models, for databases created by the app.

Revision ID: b8c0d2e4f6a8
Revises: a7b9c1d3e5f7
Create Date: 2026-10-22 09:00:00.000000

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'b8c0d2e4f6a8'
down_revision = 'a7b9c1d3e5f7'
branch_labels = None
depends_on = None


def upgrade():
  inspector = sa.inspect(op.get_bind())
  if not inspector.has_table('storage_usage'):
    op.create_table('storage_usage',
      sa.Column('batch_id', sa.Integer(), sa.ForeignKey('batches.id', ondelete='CASCADE'), primary_key=True),
      sa.Column('user_name', sa.String(), primary_key=True),
      sa.Column('project_id', sa.String(), nullable=False),
      sa.Column('ci_commit_id', sa.Integer(), nullable=False),
      sa.Column('hexsha', sa.String(), nullable=False),
      sa.Column('branch', sa.String(), nullable=True),
      sa.Column('batch_label', sa.String(), nullable=False),
      sa.Column('nb_runs', sa.Integer(), nullable=False),
      sa.Column('bytes', sa.BigInteger(), nullable=False),
      sa.Column('folder', sa.Text(), nullable=True),
      sa.Column('last_run_at', sa.DateTime(), nullable=True),
      sa.Column('updated_at', sa.DateTime(), nullable=False),
    )
    op.create_index('ix_storage_usage_user_bytes', 'storage_usage', ['user_name', sa.text('bytes DESC')])
    op.create_index('ix_storage_usage_project_bytes', 'storage_usage', ['project_id', sa.text('bytes DESC')])
    op.create_index('ix_storage_usage_ci_commit_id', 'storage_usage', ['ci_commit_id'])
    op.create_index('ix_storage_usage_folder', 'storage_usage', ['folder'], postgresql_ops={'folder': 'text_pattern_ops'})
  # ci_commits can be big: CONCURRENTLY doesn't block writes while the index builds, but can't run in a transaction
  with op.get_context().autocommit_block():
    op.execute("CREATE INDEX CONCURRENTLY IF NOT EXISTS ix_ci_commits_latest_output_datetime ON ci_commits (latest_output_datetime)")


def downgrade():
  with op.get_context().autocommit_block():
    op.execute("DROP INDEX CONCURRENTLY IF EXISTS ix_ci_commits_latest_output_datetime")
  op.drop_table('storage_usage')
