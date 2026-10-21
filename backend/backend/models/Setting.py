"""
Settings changed from the admin panel. The environment overrides them, see backend/settings.py.
"""
import datetime

from sqlalchemy import Column, Integer, String, DateTime, ForeignKey
from sqlalchemy.dialects.postgresql import JSONB

from backend.models import Base


class Setting(Base):
  __tablename__ = 'settings'

  key = Column(String(), primary_key=True)
  # {"value": ...}: JSONB columns can't hold a bare `null` distinctly from SQL NULL
  value = Column(JSONB(), nullable=False)
  updated_by_id = Column(Integer, ForeignKey('users.id', ondelete='SET NULL'), nullable=True)
  updated_at = Column(DateTime, nullable=False, default=datetime.datetime.utcnow, onupdate=datetime.datetime.utcnow)
