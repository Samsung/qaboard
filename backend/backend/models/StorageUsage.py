"""
How much storage runs use, per batch and per user: what users see in "Storage usage", without adding up millions of
runs at each page load. Kept up to date by the jobs worker, see backend/storage_usage.py.
Live runs count with their size; deleted runs with what's left of their files.
"""
import datetime

from sqlalchemy import Column, BigInteger, Integer, String, Text, DateTime, ForeignKey, Index, text

from backend.models import Base


class StorageUsage(Base):
  __tablename__ = 'storage_usage'

  batch_id = Column(Integer, ForeignKey('batches.id', ondelete='CASCADE'), primary_key=True)
  # who ran them (Output.data.user), '' if unknown
  user_name = Column(String(), primary_key=True)
  # copied from the batch and its commit, to filter and sort without joins
  project_id = Column(String(), nullable=False)
  ci_commit_id = Column(Integer, nullable=False)
  hexsha = Column(String(), nullable=False)
  branch = Column(String(), nullable=True)
  batch_label = Column(String(), nullable=False)
  nb_runs = Column(Integer, nullable=False)
  bytes = Column(BigInteger, nullable=False)
  # the folder that contains all these runs: where users find them on disk, and what quota alerts mention
  folder = Column(Text(), nullable=True)
  # Runs deleted from QA-Board: soft deletes leave some files (manifests, files the manifests don't list...).
  # What's left is measured when they're deleted (Output.data.storage_left), older ones aren't measured yet.
  deleted_runs = Column(Integer, nullable=False, default=0, server_default='0')
  deleted_bytes = Column(BigInteger, nullable=False, default=0, server_default='0')
  deleted_unmeasured = Column(Integer, nullable=False, default=0, server_default='0')
  last_run_at = Column(DateTime, nullable=True)
  updated_at = Column(DateTime, nullable=False, default=datetime.datetime.utcnow)

  __table_args__ = (
    Index('ix_storage_usage_user_bytes', 'user_name', text('bytes DESC')),
    Index('ix_storage_usage_project_bytes', 'project_id', text('bytes DESC')),
    Index('ix_storage_usage_ci_commit_id', 'ci_commit_id'),
    # folder LIKE '/algo/x/%', whatever the database's collation
    Index('ix_storage_usage_folder', 'folder', postgresql_ops={'folder': 'text_pattern_ops'}),
  )
