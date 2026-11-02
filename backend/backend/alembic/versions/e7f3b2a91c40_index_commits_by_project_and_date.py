"""Index commits by project and date, and by project, branch and date

They make lists of commits fast (the project page, branch pages, searches) and the list of a project's branches.
Also declared in CiCommit.__table_args__, for databases created by the app.

Revision ID: e7f3b2a91c40
Revises: d1a6c0f9e2b3
Create Date: 2026-10-06 09:00:00.000000

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'e7f3b2a91c40'
down_revision = 'd1a6c0f9e2b3'
branch_labels = None
depends_on = None


indexes = {
  'ix_ci_commits_project_id_authored_datetime': ['project_id', sa.text('authored_datetime DESC')],
  'ix_ci_commits_project_id_branch_authored_datetime': ['project_id', 'branch', sa.text('authored_datetime DESC')],
}


def upgrade():
  # ci_commits is big in production: we don't lock writes while we build the indexes.
  # CONCURRENTLY can't run in a transaction. If it fails, it leaves an INVALID index,
  # that IF NOT EXISTS would keep: we drop it, and build it again.
  with op.get_context().autocommit_block():
    for name, columns in indexes.items():
      is_invalid = op.get_bind().execute(sa.text(
        "SELECT 1 FROM pg_index JOIN pg_class ON pg_class.oid = pg_index.indexrelid WHERE pg_class.relname = :name AND NOT pg_index.indisvalid"
      ), {"name": name}).first()
      if is_invalid:
        op.drop_index(name, table_name='ci_commits', postgresql_concurrently=True, if_exists=True)
      op.create_index(name, 'ci_commits', columns, postgresql_concurrently=True, if_not_exists=True)


def downgrade():
  with op.get_context().autocommit_block():
    for name in indexes:
      op.drop_index(name, table_name='ci_commits', postgresql_concurrently=True, if_exists=True)
