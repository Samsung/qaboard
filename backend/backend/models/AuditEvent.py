"""
Security events: sign-ins, tokens, admin changes... Written with backend/audit.py, in the same transaction as the change.
They never contain secrets.
"""
import datetime

from sqlalchemy import Column, BigInteger, Integer, String, DateTime, Index
from sqlalchemy.dialects.postgresql import JSONB

from backend.models import Base


class AuditEvent(Base):
  __tablename__ = 'audit_events'

  id = Column(BigInteger, primary_key=True)
  created_at = Column(DateTime, nullable=False, default=datetime.datetime.utcnow, index=True)
  # user, token, system (e.g. the qaboard-admin CLI), anonymous
  actor_kind = Column(String(), nullable=False)
  # no foreign keys: events outlive the users and tokens they mention
  actor_user_id = Column(Integer, nullable=True)
  actor_token_id = Column(Integer, nullable=True)
  actor_label = Column(String(), nullable=True)
  ip = Column(String(), nullable=True)
  user_agent = Column(String(), nullable=True)
  # e.g. auth.login, token.create, user.update
  action = Column(String(), nullable=False)
  target_type = Column(String(), nullable=True)
  target_id = Column(String(), nullable=True)
  target_label = Column(String(), nullable=True)
  project_id = Column(String(), nullable=True)
  # {field: {"from": ..., "to": ...}}
  changes = Column(JSONB(), nullable=False, default=dict, server_default='{}')
  meta = Column(JSONB(), nullable=False, default=dict, server_default='{}')

  __table_args__ = (
    Index('ix_audit_events_actor_user_id', 'actor_user_id'),
    Index('ix_audit_events_target', 'target_type', 'target_id'),
    Index('ix_audit_events_action', 'action'),
  )
