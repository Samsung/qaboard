"""
Exports: folders where users exported runs' files ("Export to a shared folder" in the web app), or that a storage scan
found. They can be big, and QA-Board's runs don't account for them: users see and delete theirs in "Storage usage".
"""
import datetime

from sqlalchemy import Column, Integer, BigInteger, String, Text, DateTime, Index
from sqlalchemy.dialects.postgresql import JSONB

from backend.models import Base


class Export(Base):
  __tablename__ = 'exports'

  id = Column(Integer, primary_key=True)
  # several exports can go to the same folder: one row per folder
  path = Column(Text(), nullable=False, unique=True)
  project_id = Column(String(), nullable=True)
  hexsha = Column(String(), nullable=True)
  batch_label = Column(String(), nullable=True)
  # who exported (QA-Board user), and who owns the files (quotas count owners). Found by scans: no creator.
  created_by = Column(String(), nullable=True)
  owner = Column(String(), nullable=True)
  # web, scan
  source = Column(String(), nullable=False, default='web', server_default='web')
  created_at = Column(DateTime, nullable=False, default=datetime.datetime.utcnow)
  # the latest export into the folder
  updated_at = Column(DateTime, nullable=False, default=datetime.datetime.utcnow)
  # measured on disk. Hard links share their space with the runs' files: deleting the export doesn't free them.
  bytes = Column(BigInteger, nullable=True)
  linked_bytes = Column(BigInteger, nullable=True)
  files = Column(Integer, nullable=True)
  measured_at = Column(DateTime, nullable=True)
  deleted_at = Column(DateTime, nullable=True)
  deleted_by = Column(String(), nullable=True)
  # e.g. {"exports": [{"at", "by", "filter", "type"}]}, the latest ones
  data = Column(JSONB(), nullable=False, default=dict, server_default='{}')

  __table_args__ = (
    Index('ix_exports_owner', 'owner'),
    Index('ix_exports_created_by', 'created_by'),
    Index('ix_exports_path', 'path', postgresql_ops={'path': 'text_pattern_ops'}),
  )
