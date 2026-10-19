"""Repair databases where projects.data is json, and copy the shared milestones again

When a migration fails, migrate.sh stamps the database as migrated. In some databases bdacefe1d00c_moving_to_jsonb
was stamped instead of applied: projects.data is still json, and the migrations using jsonb functions on it failed,
then were stamped too. a4c2e8f1b7d3_milestones_table was one of them: the shared milestones were not copied.
We convert projects.data to jsonb (it's a small table), and run a4c2e8f1b7d3 again: it only creates the missing
tables, and only copies the milestones it didn't copy yet.

Revision ID: b8e1d5c3f9a2
Revises: a4c2e8f1b7d3
Create Date: 2026-10-19 12:00:00.000000

"""
import importlib.util
from pathlib import Path

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB


# revision identifiers, used by Alembic.
revision = 'b8e1d5c3f9a2'
down_revision = 'a4c2e8f1b7d3'
branch_labels = None
depends_on = None


def upgrade():
  bind = op.get_bind()
  data_type = bind.execute(sa.text(
    "SELECT data_type FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'projects' AND column_name = 'data'"
  )).scalar()
  if data_type == 'json':
    print("projects.data is json: converting it to jsonb")
    op.alter_column('projects', 'data', existing_type=sa.JSON, type_=JSONB, postgresql_using="data::jsonb")

  spec = importlib.util.spec_from_file_location('a4c2e8f1b7d3_milestones_table', Path(__file__).parent / 'a4c2e8f1b7d3_milestones_table.py')
  milestones_table = importlib.util.module_from_spec(spec)
  spec.loader.exec_module(milestones_table)
  milestones_table.upgrade()


def downgrade():
  # projects.data stays jsonb, like in the databases where bdacefe1d00c was applied
  pass
