"""
Who looked at which project, and when: Explore lets projects nobody looks at fade (webapp/src/explore/), and it can
tell users what they viewed recently. One row per user and project, written at most once an hour (api/api.py: post_project_view).
"""
import datetime

from sqlalchemy import Column, Integer, String, DateTime, ForeignKey, UniqueConstraint, Index

from backend.models import Base


class ProjectView(Base):
  __tablename__ = 'project_views'

  id = Column(Integer, primary_key=True)
  user_id = Column(Integer, ForeignKey('users.id', ondelete='CASCADE'), nullable=False)
  project_id = Column(String(), ForeignKey('projects.id', ondelete='CASCADE'), nullable=False)
  last_viewed_at = Column(DateTime, nullable=False, default=datetime.datetime.utcnow)
  # page views, counted at most once an hour
  views = Column(Integer, nullable=False, default=1, server_default='1')

  __table_args__ = (
    UniqueConstraint('user_id', 'project_id', name='uq_project_views_user_project'),
    # /api/v1/projects counts the recent viewers of every project
    Index('ix_project_views_project_id_last_viewed_at', 'project_id', 'last_viewed_at'),
  )
