"""Drop ix_ci_commits_project_id: ix_ci_commits_project_id_authored_datetime (e7f3b2a91c40) starts with project_id,
PostgreSQL uses it for the same queries (and for the foreign key). One index less to update on every new commit.
Also removed from the model, for databases created by the app.

ci_commits is big in production: the index is dropped CONCURRENTLY, without blocking reads or writes.
Older versions of QA-Board work without it (after a rollback), the downgrade builds it again.

Revision ID: fdaa945682a8
Revises: d2f4a6b8c0e1
Create Date: 2026-10-22 20:00:00.000000

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'fdaa945682a8'
down_revision = 'd2f4a6b8c0e1'
branch_labels = None
depends_on = None


name = 'ix_ci_commits_project_id'
replacement = 'ix_ci_commits_project_id_authored_datetime'


def is_valid(index_name):
  return op.get_bind().execute(sa.text(
    "SELECT pg_index.indisvalid FROM pg_index JOIN pg_class ON pg_class.oid = pg_index.indexrelid WHERE pg_class.relname = :name"
  ), {"name": index_name}).scalar()


def upgrade():
  with op.get_context().autocommit_block():
    # only if the index that replaces it is there (its CONCURRENTLY build may have failed)
    if not is_valid(replacement):
      print(f"WARNING: {replacement} is missing or invalid: we keep {name}. Run e7f3b2a91c40 again.")
      return
    op.drop_index(name, table_name='ci_commits', postgresql_concurrently=True, if_exists=True)


def downgrade():
  with op.get_context().autocommit_block():
    # CONCURRENTLY can't run in a transaction. If it fails, it leaves an INVALID index, that IF NOT EXISTS would keep
    if is_valid(name) is False:
      op.drop_index(name, table_name='ci_commits', postgresql_concurrently=True, if_exists=True)
    op.create_index(name, 'ci_commits', ['project_id'], postgresql_concurrently=True, if_not_exists=True)
