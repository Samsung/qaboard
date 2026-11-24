"""
Inputs and collections (docs/design/inputs-and-collections.md).

- input_projects: which projects used which input. The Inputs tab reads only this table; it is upserted when runs
  are created (api/outputs.py, backend/input_catalog.py:record_run).
- collections: named lists of inputs of a project, versioned. Versions never change once written. Collections are
  archived, never deleted. Subprojects see their ancestors' collections.

The API reads and writes them with SQL (backend/input_catalog.py). The migration b8d0f2a4c6e1 creates them: keep both
the same, since new databases get the tables from these models (Base.metadata.create_all).
"""
import datetime

from sqlalchemy import Column, Integer, String, Text, Boolean, DateTime, ForeignKey, Index, UniqueConstraint, text
from sqlalchemy.dialects.postgresql import JSONB

from backend.models import Base


class InputProject(Base):
  __tablename__ = 'input_projects'

  test_input_id = Column(Integer, ForeignKey('test_inputs.id', ondelete='CASCADE'), primary_key=True)
  project_id = Column(String(), ForeignKey('projects.id', ondelete='CASCADE'), primary_key=True)
  first_run_at = Column(DateTime, nullable=False, default=datetime.datetime.utcnow)
  last_run_at = Column(DateTime, nullable=False, default=datetime.datetime.utcnow)
  # how many outputs were created on the input: not decremented when they are deleted
  runs = Column(Integer, nullable=False, default=0, server_default='0')

  __table_args__ = (
    Index('ix_input_projects_project_id_last_run_at', 'project_id', last_run_at.desc()),
  )


class Collection(Base):
  __tablename__ = 'collections'

  id = Column(Integer, primary_key=True)
  project_id = Column(String(), ForeignKey('projects.id', ondelete='CASCADE'), nullable=False)
  # "night/hard-cases": "/" nests groups
  name = Column(String(), nullable=False)
  description = Column(Text(), nullable=False, default='', server_default='')
  created_by = Column(Integer, ForeignKey('users.id', ondelete='SET NULL'), nullable=True)
  created_at = Column(DateTime, nullable=False, default=datetime.datetime.utcnow)
  updated_at = Column(DateTime, nullable=False, default=datetime.datetime.utcnow)
  # archived: hidden from lists by default, still resolved
  archived_at = Column(DateTime, nullable=True)
  latest_version = Column(Integer, nullable=False, default=1, server_default='1')
  # false: personal, seen only by its creator (created_by), like personal milestones. Names stay unique per project.
  shared = Column(Boolean, nullable=False, default=True, server_default=text('true'))

  __table_args__ = (
    UniqueConstraint('project_id', 'name', name='uq_collections_project_id_name'),
  )


class CollectionVersion(Base):
  """Immutable once written: saving a collection writes a new version, with all its inputs"""
  __tablename__ = 'collection_versions'

  id = Column(Integer, primary_key=True)
  collection_id = Column(Integer, ForeignKey('collections.id', ondelete='CASCADE'), nullable=False)
  version = Column(Integer, nullable=False)
  created_by = Column(Integer, ForeignKey('users.id', ondelete='SET NULL'), nullable=True)
  created_at = Column(DateTime, nullable=False, default=datetime.datetime.utcnow)
  notes = Column(Text(), nullable=False, default='', server_default='')
  size = Column(Integer, nullable=False, default=0, server_default='0')

  __table_args__ = (
    UniqueConstraint('collection_id', 'version', name='uq_collection_versions_collection_id_version'),
  )


class CollectionMember(Base):
  __tablename__ = 'collection_members'

  version_id = Column(Integer, ForeignKey('collection_versions.id', ondelete='CASCADE'), primary_key=True)
  position = Column(Integer, primary_key=True, autoincrement=False)
  # inputs of collections are never removed
  test_input_id = Column(Integer, ForeignKey('test_inputs.id', ondelete='RESTRICT'), nullable=False)
  # reserved for annotations (rollout 2): always null now
  region = Column(JSONB(), nullable=True)

  __table_args__ = (
    # the collections that have an input, and deleting inputs (the foreign key's check)
    Index('ix_collection_members_test_input_id', 'test_input_id'),
  )


class CollectionFavorite(Base):
  __tablename__ = 'collection_favorites'

  user_id = Column(Integer, ForeignKey('users.id', ondelete='CASCADE'), primary_key=True)
  collection_id = Column(Integer, ForeignKey('collections.id', ondelete='CASCADE'), primary_key=True, index=True)
  created_at = Column(DateTime, nullable=False, default=datetime.datetime.utcnow)


class CollectionPin(Base):
  """A collection pinned for a group, or for everyone on the project (group_id null)"""
  __tablename__ = 'collection_pins'

  id = Column(Integer, primary_key=True)
  collection_id = Column(Integer, ForeignKey('collections.id', ondelete='CASCADE'), nullable=False)
  group_id = Column(Integer, ForeignKey('groups.id', ondelete='CASCADE'), nullable=True)
  pinned_by = Column(Integer, ForeignKey('users.id', ondelete='SET NULL'), nullable=True)
  created_at = Column(DateTime, nullable=False, default=datetime.datetime.utcnow)

  __table_args__ = (
    UniqueConstraint('collection_id', 'group_id', name='uq_collection_pins_collection_id_group_id'),
    # NULLs are distinct in unique constraints (until PostgreSQL 15's NULLS NOT DISTINCT): one pin for everyone
    Index('uq_collection_pins_everyone', 'collection_id', unique=True, postgresql_where=text('group_id IS NULL')),
  )
