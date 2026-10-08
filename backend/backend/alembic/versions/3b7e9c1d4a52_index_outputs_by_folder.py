"""Index outputs by folder, for the file browser's run actions

Revision ID: 3b7e9c1d4a52
Revises: cda62d01ead8
Create Date: 2026-10-08 15:00:00.000000

"""
from alembic import op


# revision identifiers, used by Alembic.
revision = '3b7e9c1d4a52'
down_revision = 'cda62d01ead8'
branch_labels = None
depends_on = None


def upgrade():
  # The outputs table is big: CONCURRENTLY doesn't block writes while the index builds,
  # but it can't run in a transaction
  with op.get_context().autocommit_block():
    op.create_index('idx_outputs_output_dir_override', 'outputs', ['output_dir_override'],
                    postgresql_concurrently=True, if_not_exists=True)


def downgrade():
  with op.get_context().autocommit_block():
    op.drop_index('idx_outputs_output_dir_override', table_name='outputs',
                  postgresql_concurrently=True, if_exists=True)
