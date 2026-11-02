"""
Milestones: results (a commit's batch, maybe filtered) saved to compare with later.

They belong to a project and to the user who saved them. Personal milestones are listed only for their owner,
shared milestones for everyone on the project. Anyone who can see the project can open a milestone from its link.
Users can add any milestone they see to their favorites.
"""
import datetime

from sqlalchemy import Column, Integer, String, Text, Boolean, DateTime, ForeignKey, Index
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import relationship

from backend.models import Base


class Milestone(Base):
  __tablename__ = 'milestones'

  id = Column(Integer, primary_key=True)
  # where the milestone is listed
  project_id = Column(String(), ForeignKey('projects.id', ondelete='CASCADE'), nullable=False, index=True)
  # who saved it. Milestones imported from older versions may have no owner: any logged-in user can edit them.
  user_id = Column(Integer, ForeignKey('users.id', ondelete='SET NULL'), nullable=True, index=True)
  shared = Column(Boolean, nullable=False, default=False, server_default='false')

  label = Column(String(), nullable=False, default='', server_default='')
  # Milestones are listed by group, e.g. "tuning/denoiser": "/" nests groups
  group = Column(String(), nullable=False, default='', server_default='')
  notes = Column(Text(), nullable=False, default='', server_default='')

  # The results: a commit's batch, maybe with a filter.
  # They can be from another project than project_id (e.g. another subproject of a monorepo)
  commit_hexsha = Column(String(), nullable=False)
  commit_project_id = Column(String(), nullable=True)
  batch = Column(String(), nullable=False, default='default', server_default='default')
  filter = Column(String(), nullable=False, default='', server_default='')

  # What we knew about the commit when the milestone was saved, to describe it without loading it:
  # branch, committer_name, message. Also legacy_key/legacy_owners for imported milestones.
  data = Column(JSONB(), nullable=False, default=dict, server_default='{}')

  created_at = Column(DateTime, nullable=False, default=datetime.datetime.utcnow)
  updated_at = Column(DateTime, nullable=False, default=datetime.datetime.utcnow, onupdate=datetime.datetime.utcnow)

  user = relationship("User", lazy='joined')
  favorites = relationship("MilestoneFavorite", back_populates="milestone", cascade="all, delete-orphan", passive_deletes=True)

  __table_args__ = (
    # the cleanup of old results looks for the batches of milestones
    Index('ix_milestones_commit_hexsha', 'commit_hexsha'),
  )

  @property
  def results_project_id(self) -> str:
    return self.commit_project_id or self.project_id

  def __repr__(self):
    return f"<Milestone id={self.id} project='{self.project_id}' label='{self.label}' commit='{self.commit_hexsha[:8]}' batch='{self.batch}'>"


class MilestoneFavorite(Base):
  __tablename__ = 'milestone_favorites'

  user_id = Column(Integer, ForeignKey('users.id', ondelete='CASCADE'), primary_key=True)
  milestone_id = Column(Integer, ForeignKey('milestones.id', ondelete='CASCADE'), primary_key=True, index=True)
  created_at = Column(DateTime, nullable=False, default=datetime.datetime.utcnow)

  milestone = relationship("Milestone", back_populates="favorites")


class MilestoneGroupFavorite(Base):
  """A group of milestones in the user's favorites: its milestones, even those saved later, are listed first"""
  __tablename__ = 'milestone_group_favorites'

  user_id = Column(Integer, ForeignKey('users.id', ondelete='CASCADE'), primary_key=True)
  project_id = Column(String(), ForeignKey('projects.id', ondelete='CASCADE'), primary_key=True)
  # the groups of "My milestones" and of the milestones shared with the project are different groups
  section = Column(String(), primary_key=True)  # mine | shared
  group = Column(String(), primary_key=True)
  created_at = Column(DateTime, nullable=False, default=datetime.datetime.utcnow)
