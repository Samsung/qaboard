"""Inputs and collections: which projects used which input, and versioned collections of inputs

input_projects is filled from the outputs that exist (one INSERT ... SELECT ... GROUP BY): then the backend upserts it
when runs are created. Also an index of the runs that weren't deleted by input, for the Inputs tab. See docs/design/inputs-and-collections.md and backend/models/Collection.py.

Revision ID: b8d0f2a4c6e1
Revises: a7c9e1b3d5f6
Create Date: 2026-11-22 09:00:00.000000

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision = 'b8d0f2a4c6e1'
down_revision = 'a7c9e1b3d5f6'
branch_labels = None
depends_on = None

LIVE_INDEX = 'ix_outputs_live_test_input_id_batch_id'


def has_table(table):
  return sa.inspect(op.get_bind()).has_table(table)


def upgrade():
  # The app creates missing tables when it starts (Base.metadata.create_all): they may be there already, empty
  if not has_table('input_projects'):
    op.create_table(
      'input_projects',
      sa.Column('test_input_id', sa.Integer(), sa.ForeignKey('test_inputs.id', ondelete='CASCADE'), primary_key=True),
      sa.Column('project_id', sa.String(), sa.ForeignKey('projects.id', ondelete='CASCADE'), primary_key=True),
      sa.Column('first_run_at', sa.DateTime(), nullable=False),
      sa.Column('last_run_at', sa.DateTime(), nullable=False),
      sa.Column('runs', sa.Integer(), nullable=False, server_default='0'),
    )
    op.create_index('ix_input_projects_project_id_last_run_at', 'input_projects', ['project_id', sa.text('last_run_at DESC')])

  if not has_table('collections'):
    op.create_table(
      'collections',
      sa.Column('id', sa.Integer(), primary_key=True),
      sa.Column('project_id', sa.String(), sa.ForeignKey('projects.id', ondelete='CASCADE'), nullable=False),
      sa.Column('name', sa.String(), nullable=False),
      sa.Column('description', sa.Text(), nullable=False, server_default=''),
      sa.Column('created_by', sa.Integer(), sa.ForeignKey('users.id', ondelete='SET NULL'), nullable=True),
      sa.Column('created_at', sa.DateTime(), nullable=False, server_default=sa.text("(now() at time zone 'utc')")),
      sa.Column('updated_at', sa.DateTime(), nullable=False, server_default=sa.text("(now() at time zone 'utc')")),
      sa.Column('archived_at', sa.DateTime(), nullable=True),
      sa.Column('latest_version', sa.Integer(), nullable=False, server_default='1'),
      sa.UniqueConstraint('project_id', 'name', name='uq_collections_project_id_name'),
    )

  if not has_table('collection_versions'):
    op.create_table(
      'collection_versions',
      sa.Column('id', sa.Integer(), primary_key=True),
      sa.Column('collection_id', sa.Integer(), sa.ForeignKey('collections.id', ondelete='CASCADE'), nullable=False),
      sa.Column('version', sa.Integer(), nullable=False),
      sa.Column('created_by', sa.Integer(), sa.ForeignKey('users.id', ondelete='SET NULL'), nullable=True),
      sa.Column('created_at', sa.DateTime(), nullable=False, server_default=sa.text("(now() at time zone 'utc')")),
      sa.Column('notes', sa.Text(), nullable=False, server_default=''),
      sa.Column('size', sa.Integer(), nullable=False, server_default='0'),
      sa.UniqueConstraint('collection_id', 'version', name='uq_collection_versions_collection_id_version'),
    )

  if not has_table('collection_members'):
    op.create_table(
      'collection_members',
      sa.Column('version_id', sa.Integer(), sa.ForeignKey('collection_versions.id', ondelete='CASCADE'), primary_key=True),
      sa.Column('position', sa.Integer(), primary_key=True, autoincrement=False),
      sa.Column('test_input_id', sa.Integer(), sa.ForeignKey('test_inputs.id', ondelete='RESTRICT'), nullable=False),
      sa.Column('region', postgresql.JSONB(), nullable=True),
    )
    op.create_index('ix_collection_members_test_input_id', 'collection_members', ['test_input_id'])

  if not has_table('collection_favorites'):
    op.create_table(
      'collection_favorites',
      sa.Column('user_id', sa.Integer(), sa.ForeignKey('users.id', ondelete='CASCADE'), primary_key=True),
      sa.Column('collection_id', sa.Integer(), sa.ForeignKey('collections.id', ondelete='CASCADE'), primary_key=True),
      sa.Column('created_at', sa.DateTime(), nullable=False, server_default=sa.text("(now() at time zone 'utc')")),
    )
    op.create_index('ix_collection_favorites_collection_id', 'collection_favorites', ['collection_id'])

  if not has_table('collection_pins'):
    op.create_table(
      'collection_pins',
      sa.Column('id', sa.Integer(), primary_key=True),
      sa.Column('collection_id', sa.Integer(), sa.ForeignKey('collections.id', ondelete='CASCADE'), nullable=False),
      sa.Column('group_id', sa.Integer(), sa.ForeignKey('groups.id', ondelete='CASCADE'), nullable=True),
      sa.Column('pinned_by', sa.Integer(), sa.ForeignKey('users.id', ondelete='SET NULL'), nullable=True),
      sa.Column('created_at', sa.DateTime(), nullable=False, server_default=sa.text("(now() at time zone 'utc')")),
      sa.UniqueConstraint('collection_id', 'group_id', name='uq_collection_pins_collection_id_group_id'),
    )
    # NULLs are distinct in unique constraints before PostgreSQL 15: one pin for everyone
    op.create_index('uq_collection_pins_everyone', 'collection_pins', ['collection_id'], unique=True, postgresql_where=sa.text('group_id IS NULL'))

  # The projects that used each input, from the runs we have. Outputs without a creation date count as now.
  result = op.get_bind().execute(sa.text("""
    INSERT INTO input_projects (test_input_id, project_id, first_run_at, last_run_at, runs)
    SELECT o.test_input_id, c.project_id,
           coalesce(min(o.created_date), now() at time zone 'utc'), coalesce(max(o.created_date), now() at time zone 'utc'), count(*)
    FROM outputs o
    JOIN batches b ON b.id = o.batch_id
    JOIN ci_commits c ON c.id = b.ci_commit_id
    WHERE o.test_input_id IS NOT NULL AND c.project_id IS NOT NULL
    GROUP BY o.test_input_id, c.project_id
    ON CONFLICT (test_input_id, project_id) DO UPDATE SET
      first_run_at = LEAST(input_projects.first_run_at, EXCLUDED.first_run_at),
      last_run_at = GREATEST(input_projects.last_run_at, EXCLUDED.last_run_at),
      runs = GREATEST(input_projects.runs, EXCLUDED.runs)
  """))
  # Rows may be there already: the app creates the tables and records runs before the migration runs. The backfill
  # counted every run: the most of both is right (record_run never counted fewer than the outputs it saw).
  print(f"input_projects: {result.rowcount} (input, project) pairs from the existing runs")

  # The Inputs tab's "only inputs with runs" filter (input_catalog.LIVE): from a project's batches, one index-only probe
  # each. outputs is big in production: built CONCURRENTLY, writes go on. If it fails, CONCURRENTLY leaves an INVALID
  # index that IF NOT EXISTS would keep: we drop it and build it again.
  with op.get_context().autocommit_block():
    is_invalid = op.get_bind().execute(sa.text(
      "SELECT 1 FROM pg_index JOIN pg_class ON pg_class.oid = pg_index.indexrelid WHERE pg_class.relname = :name AND NOT pg_index.indisvalid"
    ), {"name": LIVE_INDEX}).first()
    if is_invalid:
      op.drop_index(LIVE_INDEX, table_name='outputs', postgresql_concurrently=True, if_exists=True)
    op.create_index(LIVE_INDEX, 'outputs', ['test_input_id', 'batch_id'], postgresql_where=sa.text("deleted IS NOT TRUE"),
                    postgresql_concurrently=True, if_not_exists=True)


def downgrade():
  with op.get_context().autocommit_block():
    op.drop_index(LIVE_INDEX, table_name='outputs', postgresql_concurrently=True, if_exists=True)
  op.drop_table('collection_pins')
  op.drop_table('collection_favorites')
  op.drop_table('collection_members')
  op.drop_table('collection_versions')
  op.drop_table('collections')
  op.drop_table('input_projects')
