"""Index audit events by project, for projects' audit logs

Revision ID: a7c9e1b3d5f6
Revises: f4b6d8a0c2e4
Create Date: 2026-11-21 22:00:00.000000

"""
from alembic import op


# revision identifiers, used by Alembic.
revision = 'a7c9e1b3d5f6'
down_revision = 'f4b6d8a0c2e4'
branch_labels = None
depends_on = None


def upgrade():
  # project_id = 'a/b' and project_id LIKE 'a/b/%' (its subprojects), newest first.
  # The table grows with every sign-in: CONCURRENTLY doesn't block writes while the index builds, outside a transaction
  with op.get_context().autocommit_block():
    op.create_index('ix_audit_events_project', 'audit_events', ['project_id', 'id'],
                    postgresql_ops={'project_id': 'text_pattern_ops'}, postgresql_concurrently=True, if_not_exists=True)


def downgrade():
  with op.get_context().autocommit_block():
    op.drop_index('ix_audit_events_project', table_name='audit_events', postgresql_concurrently=True, if_exists=True)
