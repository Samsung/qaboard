"""Storage: what deleted runs leave (storage_usage.deleted_*), exports, and storage scans.
Also declared in the models, for databases created by the app.

Revision ID: c1e3a5b7d9f2
Revises: e5a7c9b1d3f4
Create Date: 2026-10-22 12:00:00.000000

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision = 'c1e3a5b7d9f2'
down_revision = 'e5a7c9b1d3f4'
branch_labels = None
depends_on = None


def upgrade():
  inspector = sa.inspect(op.get_bind())
  columns = {c['name'] for c in inspector.get_columns('storage_usage')}
  for name, type_ in (('deleted_runs', sa.Integer()), ('deleted_bytes', sa.BigInteger()), ('deleted_unmeasured', sa.Integer())):
    if name not in columns:
      op.add_column('storage_usage', sa.Column(name, type_, nullable=False, server_default='0'))
  if not inspector.has_table('exports'):
    op.create_table('exports',
      sa.Column('id', sa.Integer(), primary_key=True),
      sa.Column('path', sa.Text(), nullable=False, unique=True),
      sa.Column('project_id', sa.String(), nullable=True),
      sa.Column('hexsha', sa.String(), nullable=True),
      sa.Column('batch_label', sa.String(), nullable=True),
      sa.Column('created_by', sa.String(), nullable=True),
      sa.Column('owner', sa.String(), nullable=True),
      sa.Column('source', sa.String(), nullable=False, server_default='web'),
      sa.Column('created_at', sa.DateTime(), nullable=False),
      sa.Column('updated_at', sa.DateTime(), nullable=False),
      sa.Column('bytes', sa.BigInteger(), nullable=True),
      sa.Column('linked_bytes', sa.BigInteger(), nullable=True),
      sa.Column('files', sa.Integer(), nullable=True),
      sa.Column('measured_at', sa.DateTime(), nullable=True),
      sa.Column('deleted_at', sa.DateTime(), nullable=True),
      sa.Column('deleted_by', sa.String(), nullable=True),
      sa.Column('data', postgresql.JSONB(), nullable=False, server_default='{}'),
    )
    op.create_index('ix_exports_owner', 'exports', ['owner'])
    op.create_index('ix_exports_created_by', 'exports', ['created_by'])
    op.create_index('ix_exports_path', 'exports', ['path'], postgresql_ops={'path': 'text_pattern_ops'})
  if not inspector.has_table('storage_scans'):
    op.create_table('storage_scans',
      sa.Column('id', sa.Integer(), primary_key=True),
      sa.Column('job_id', sa.BigInteger(), nullable=True),
      sa.Column('roots', postgresql.JSONB(), nullable=False, server_default='[]'),
      sa.Column('status', sa.String(), nullable=False, server_default='running'),
      sa.Column('created_at', sa.DateTime(), nullable=False),
      sa.Column('finished_at', sa.DateTime(), nullable=True),
      sa.Column('totals', postgresql.JSONB(), nullable=False, server_default='{}'),
      sa.Column('min_bytes', sa.BigInteger(), nullable=False, server_default='0'),
    )
  if not inspector.has_table('storage_scan_entries'):
    op.create_table('storage_scan_entries',
      sa.Column('scan_id', sa.Integer(), sa.ForeignKey('storage_scans.id', ondelete='CASCADE'), primary_key=True),
      sa.Column('path', sa.Text(), primary_key=True),
      sa.Column('parent', sa.Text(), nullable=True),
      sa.Column('name', sa.Text(), nullable=False),
      sa.Column('depth', sa.Integer(), nullable=False),
      sa.Column('is_dir', sa.Boolean(), nullable=False),
      sa.Column('kind', sa.String(), nullable=False),
      sa.Column('bytes', sa.BigInteger(), nullable=False),
      sa.Column('files', sa.Integer(), nullable=False),
      sa.Column('newest_mtime', sa.DateTime(), nullable=True),
      sa.Column('owners', postgresql.JSONB(), nullable=False, server_default='{}'),
      sa.Column('owner', sa.String(), nullable=True),
      sa.Column('kinds', postgresql.JSONB(), nullable=False, server_default='{}'),
      sa.Column('ref', postgresql.JSONB(), nullable=False, server_default='{}'),
      sa.Column('small', postgresql.JSONB(), nullable=False, server_default='{}'),
      sa.Column('action', sa.String(), nullable=True),
    )
    op.create_index('ix_storage_scan_entries_parent', 'storage_scan_entries', ['scan_id', 'parent', sa.text('bytes DESC')])
    op.create_index('ix_storage_scan_entries_kind', 'storage_scan_entries', ['scan_id', 'kind', sa.text('bytes DESC')])
    op.create_index('ix_storage_scan_entries_owner', 'storage_scan_entries', ['scan_id', 'owner'])


def downgrade():
  op.drop_table('storage_scan_entries')
  op.drop_table('storage_scans')
  op.drop_table('exports')
  for name in ('deleted_unmeasured', 'deleted_bytes', 'deleted_runs'):
    op.drop_column('storage_usage', name)
