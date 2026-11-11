"""
What a project's owners set from its Admin pages in the web app (docs/rfcs/project-admin.md): today the quality
gate's project rules. Not in projects.data: every viewer reads it, and pushes to the reference branch replace parts
of it.
"""
import datetime

from sqlalchemy import Column, Integer, String, DateTime, ForeignKey
from sqlalchemy.dialects.postgresql import JSONB

from backend.models import Base


class ProjectSettings(Base):
  __tablename__ = 'project_settings'

  # the project's id: settings are per project, not inherited from parent folders like access
  project_id = Column(String(), primary_key=True)
  # {"gate": {"rules": [...], "max_failed_runs": 0, "require_bit_accuracy": false, "on_looser_rules": "warn"}}
  data = Column(JSONB(), nullable=False, default=dict, server_default='{}')
  # per section, who changed it last: {"gate": {"at": "...Z", "by": "alice", "by_id": 3}}
  updated = Column(JSONB(), nullable=False, default=dict, server_default='{}')
  updated_by_id = Column(Integer, ForeignKey('users.id', ondelete='SET NULL'), nullable=True)
  updated_at = Column(DateTime, nullable=False, default=datetime.datetime.utcnow, onupdate=datetime.datetime.utcnow)
