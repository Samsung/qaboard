"""Who viewed which project (project_views)

Explore lets projects nobody looks at fade (api/api.py get_projects). Also declared in the models, for databases
created by the app. project_views is new and small: one row per user and project. Its sparklines use the index of
batches by when they last got a run, from e9b1c3d5f7a2.

Revision ID: f1d3b5a7c9e2
Revises: e9b1c3d5f7a2
Create Date: 2026-10-24 18:00:00.000000

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'f1d3b5a7c9e2'
down_revision = 'e9b1c3d5f7a2'
branch_labels = None
depends_on = None



def upgrade():
  # The app creates missing tables when it starts (Base.metadata.create_all)
  if not sa.inspect(op.get_bind()).has_table('project_views'):
    # its foreign keys briefly lock users and projects: we give up rather than wait behind long queries (and block
    # every write queued behind us). Run the migration again if it times out.
    op.execute("SET LOCAL lock_timeout = '5s'")
    op.create_table(
      'project_views',
      sa.Column('id', sa.Integer(), primary_key=True),
      sa.Column('user_id', sa.Integer(), sa.ForeignKey('users.id', ondelete='CASCADE'), nullable=False),
      sa.Column('project_id', sa.String(), sa.ForeignKey('projects.id', ondelete='CASCADE'), nullable=False),
      sa.Column('last_viewed_at', sa.DateTime(), nullable=False),
      sa.Column('views', sa.Integer(), nullable=False, server_default='1'),
      sa.UniqueConstraint('user_id', 'project_id', name='uq_project_views_user_project'),
    )
    op.create_index('ix_project_views_project_id_last_viewed_at', 'project_views', ['project_id', 'last_viewed_at'])


def downgrade():
  op.drop_table('project_views')
