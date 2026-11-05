"""Usage events: what people do in the web app and with the qa CLI (backend/usage.py)

The table, its indexes, and two views for SQL users and dashboards (e.g. Metabase):
- usage_events_v: the events with the user's current name and full name, and the product (the first element of the project id)
- usage_daily_v: how many events per day, user, product, project, source and event

Revision ID: c7e1a9d3b5f2
Revises: b6d8f0a2c4e6
Create Date: 2026-11-03 10:00:00.000000

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision = 'c7e1a9d3b5f2'
down_revision = 'b6d8f0a2c4e6'
branch_labels = None
depends_on = None


def has_table(table):
  return sa.inspect(op.get_bind()).has_table(table)


EVENTS_VIEW = """
CREATE OR REPLACE VIEW usage_events_v AS
  SELECT e.id, e.created_at, e.received_at, e.source, e.event, e.user_id,
         coalesce(u.user_name, e.user_name) AS user_name, u.full_name, e.verified, e.client_id, e.project_id,
         split_part(e.project_id, '/', 1) AS product, e.properties
  FROM usage_events e
  LEFT JOIN users u ON u.id = e.user_id
"""

DAILY_VIEW = """
CREATE OR REPLACE VIEW usage_daily_v AS
  SELECT created_at::date AS day, user_name, product, project_id, source, event, count(*) AS count
  FROM usage_events_v
  GROUP BY 1, 2, 3, 4, 5, 6
"""


def upgrade():
  if not has_table('usage_events'):
    op.create_table(
      'usage_events',
      sa.Column('id', sa.BigInteger(), primary_key=True),
      sa.Column('created_at', sa.DateTime(), nullable=False),
      sa.Column('received_at', sa.DateTime(), nullable=False, server_default=sa.text('now()')),
      sa.Column('source', sa.String(), nullable=False),
      sa.Column('event', sa.String(), nullable=False),
      sa.Column('user_id', sa.Integer(), nullable=True),
      sa.Column('user_name', sa.String(), nullable=True),
      sa.Column('verified', sa.Boolean(), nullable=False, server_default='true'),
      sa.Column('client_id', sa.String(), nullable=True),
      sa.Column('project_id', sa.String(), nullable=True),
      sa.Column('properties', postgresql.JSONB(), nullable=False, server_default='{}'),
    )
    op.create_index('ix_usage_events_created_at', 'usage_events', ['created_at'])
    op.create_index('ix_usage_events_user_created', 'usage_events', ['user_id', 'created_at'])
    op.create_index('ix_usage_events_user_name_created', 'usage_events', ['user_name', 'created_at'])
    op.create_index('ix_usage_events_project_created', 'usage_events', ['project_id', 'created_at'])
    op.create_index('ix_usage_events_event_created', 'usage_events', ['event', 'created_at'])
  op.execute(EVENTS_VIEW)
  op.execute(DAILY_VIEW)


def downgrade():
  op.execute("DROP VIEW IF EXISTS usage_daily_v")
  op.execute("DROP VIEW IF EXISTS usage_events_v")
  op.drop_table('usage_events')
