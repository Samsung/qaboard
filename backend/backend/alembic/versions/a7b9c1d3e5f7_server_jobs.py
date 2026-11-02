"""Server jobs: maintenance jobs started by admins or schedules (e.g. hard-deleting deleted runs), their errors,
schedules and workers. See backend/jobs/. Also declared in the models, for databases created by the app.

Revision ID: a7b9c1d3e5f7
Revises: d4e6f8a0b2c3
Create Date: 2026-10-21 15:00:00.000000

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision = 'a7b9c1d3e5f7'
down_revision = 'd4e6f8a0b2c3'
branch_labels = None
depends_on = None


def has_table(table):
  return sa.inspect(op.get_bind()).has_table(table)


def upgrade():
  if not has_table('job_schedules'):
    op.create_table('job_schedules',
      sa.Column('id', sa.Integer(), primary_key=True),
      sa.Column('name', sa.String(), nullable=False),
      sa.Column('kind', sa.String(), nullable=False),
      sa.Column('params', postgresql.JSONB(), nullable=False, server_default='{}'),
      sa.Column('cron', sa.String(), nullable=False),
      sa.Column('timezone', sa.String(), nullable=False, server_default='UTC'),
      sa.Column('enabled', sa.Boolean(), nullable=False, server_default='true'),
      sa.Column('next_run_at', sa.DateTime(), nullable=True),
      sa.Column('last_run_at', sa.DateTime(), nullable=True),
      sa.Column('last_job_id', sa.BigInteger(), nullable=True),
      sa.Column('last_message', sa.Text(), nullable=True),
      sa.Column('created_at', sa.DateTime(), nullable=False),
      sa.Column('updated_at', sa.DateTime(), nullable=False),
      sa.Column('updated_by_id', sa.Integer(), sa.ForeignKey('users.id', ondelete='SET NULL'), nullable=True),
    )
  if not has_table('jobs'):
    op.create_table('jobs',
      sa.Column('id', sa.BigInteger(), primary_key=True),
      sa.Column('kind', sa.String(), nullable=False),
      sa.Column('params', postgresql.JSONB(), nullable=False, server_default='{}'),
      sa.Column('status', sa.String(), nullable=False, server_default='queued'),
      sa.Column('progress', postgresql.JSONB(), nullable=False, server_default='{}'),
      sa.Column('log', postgresql.JSONB(), nullable=False, server_default='[]'),
      sa.Column('error', sa.Text(), nullable=True),
      sa.Column('created_at', sa.DateTime(), nullable=False),
      sa.Column('created_by_id', sa.Integer(), sa.ForeignKey('users.id', ondelete='SET NULL'), nullable=True),
      sa.Column('created_by_label', sa.String(), nullable=True),
      sa.Column('schedule_id', sa.Integer(), sa.ForeignKey('job_schedules.id', ondelete='SET NULL'), nullable=True),
      sa.Column('started_at', sa.DateTime(), nullable=True),
      sa.Column('finished_at', sa.DateTime(), nullable=True),
      sa.Column('heartbeat_at', sa.DateTime(), nullable=True),
      sa.Column('worker', sa.String(), nullable=True),
      sa.Column('attempts', sa.Integer(), nullable=False, server_default='0'),
      sa.Column('cancel_requested', sa.Boolean(), nullable=False, server_default='false'),
    )
    op.create_index('ix_jobs_status', 'jobs', ['status'])
    op.create_index('ix_jobs_schedule_id', 'jobs', ['schedule_id'])
  if not has_table('job_errors'):
    op.create_table('job_errors',
      sa.Column('id', sa.BigInteger(), primary_key=True),
      sa.Column('job_id', sa.BigInteger(), sa.ForeignKey('jobs.id', ondelete='CASCADE'), nullable=False),
      sa.Column('created_at', sa.DateTime(), nullable=False),
      sa.Column('kind', sa.String(), nullable=False),
      sa.Column('message', sa.Text(), nullable=False),
      sa.Column('project_id', sa.String(), nullable=True),
      sa.Column('batch_id', sa.Integer(), nullable=True),
      sa.Column('output_id', sa.Integer(), nullable=True),
      sa.Column('path', sa.Text(), nullable=True),
      sa.Column('owner', sa.String(), nullable=True),
    )
    op.create_index('ix_job_errors_job_id_kind', 'job_errors', ['job_id', 'kind'])
  if not has_table('job_workers'):
    op.create_table('job_workers',
      sa.Column('id', sa.String(), primary_key=True),
      sa.Column('started_at', sa.DateTime(), nullable=False),
      sa.Column('seen_at', sa.DateTime(), nullable=False),
      sa.Column('job_id', sa.BigInteger(), nullable=True),
      sa.Column('version', sa.String(), nullable=True),
    )


def downgrade():
  op.drop_table('job_workers')
  op.drop_table('job_errors')
  op.drop_table('jobs')
  op.drop_table('job_schedules')
