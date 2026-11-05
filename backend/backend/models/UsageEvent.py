"""
Usage events: what people do in the web app and with the `qa` CLI, sent by those clients (backend/usage.py).
Never written by the server on its own: server-side, people and automation look alike. Kept forever: it's small.
"""
import datetime

from sqlalchemy import Column, BigInteger, Integer, String, Boolean, DateTime, Index
from sqlalchemy.dialects.postgresql import JSONB

from backend.models import Base


class UsageEvent(Base):
  __tablename__ = 'usage_events'

  id = Column(BigInteger, primary_key=True)
  # when it happened, as the client says, clamped close to when we received it
  created_at = Column(DateTime, nullable=False, default=datetime.datetime.utcnow)
  received_at = Column(DateTime, nullable=False, default=datetime.datetime.utcnow)
  # webapp, cli
  source = Column(String(), nullable=False)
  # snake_case, e.g. page_view, cli_command: see docs/design/usage-analytics.md
  event = Column(String(), nullable=False)
  # no foreign key: events outlive accounts
  user_id = Column(Integer, nullable=True)
  # as known at the time, or what the CLI says it runs as when it sends no token
  user_name = Column(String(), nullable=True)
  # false when the CLI said who it was without a token
  verified = Column(Boolean, nullable=False, default=True, server_default='true')
  # the browser's or machine's random id, to count distinct anonymous clients
  client_id = Column(String(), nullable=True)
  # repo/subproject, when the event is about a project
  project_id = Column(String(), nullable=True)
  properties = Column(JSONB(), nullable=False, default=dict, server_default='{}')

  __table_args__ = (
    Index('ix_usage_events_created_at', 'created_at'),
    Index('ix_usage_events_user_created', 'user_id', 'created_at'),
    Index('ix_usage_events_user_name_created', 'user_name', 'created_at'),
    Index('ix_usage_events_project_created', 'project_id', 'created_at'),
    Index('ix_usage_events_event_created', 'event', 'created_at'),
  )
