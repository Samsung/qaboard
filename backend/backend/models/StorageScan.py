"""
Storage scans: what's on disk in the projects' storage, folder by folder, with who owns it, and what QA-Board knows
about it (runs, batches, artifacts, exports) or not. Admins explore them (Admin > Storage > Scans) to find and delete
untracked files, users see the untracked files they own. See backend/jobs/scan.py.
"""
import datetime

from sqlalchemy import Column, Integer, BigInteger, String, Text, DateTime, Boolean, ForeignKey, Index, text
from sqlalchemy.dialects.postgresql import JSONB

from backend.models import Base


class StorageScan(Base):
  __tablename__ = 'storage_scans'

  id = Column(Integer, primary_key=True)
  job_id = Column(BigInteger, nullable=True)
  # the folders scanned
  roots = Column(JSONB(), nullable=False, default=list, server_default='[]')
  # running, done, failed, cancelled
  status = Column(String(), nullable=False, default='running', server_default='running')
  created_at = Column(DateTime, nullable=False, default=datetime.datetime.utcnow)
  finished_at = Column(DateTime, nullable=True)
  # {"by_kind": {kind: {bytes, files, entries}}, "by_owner": {owner: {kind: bytes}}, "bytes", "files", "dirs", "errors"}
  totals = Column(JSONB(), nullable=False, default=dict, server_default='{}')
  # entries smaller than this are summed up in their parent
  min_bytes = Column(BigInteger, nullable=False, default=0, server_default='0')


class StorageScanEntry(Base):
  """A folder (or a big file) and everything in it"""
  __tablename__ = 'storage_scan_entries'

  scan_id = Column(Integer, ForeignKey('storage_scans.id', ondelete='CASCADE'), primary_key=True)
  path = Column(Text(), primary_key=True)
  parent = Column(Text(), nullable=True)
  name = Column(Text(), nullable=False)
  depth = Column(Integer, nullable=False)
  is_dir = Column(Boolean, nullable=False, default=True)
  # run, deleted_run, untracked_run, batch, artifacts, deleted_artifacts, export, untracked_export, folder, file
  kind = Column(String(), nullable=False)
  bytes = Column(BigInteger, nullable=False, default=0)
  files = Column(Integer, nullable=False, default=0)
  # the newest modification inside: what's old is a good candidate for deletion
  newest_mtime = Column(DateTime, nullable=True)
  # who owns the files inside: {"alice": 1234, ...}, the biggest first, and the folder's own owner
  owners = Column(JSONB(), nullable=False, default=dict, server_default='{}')
  owner = Column(String(), nullable=True)
  # how much of it is of each kind: {"run": 123, "untracked_run": 456...}
  kinds = Column(JSONB(), nullable=False, default=dict, server_default='{}')
  # what QA-Board knows: {"output_id"}, {"batch_id"}, {"commit_id"}, {"export_id"}, {"project_id"}...
  ref = Column(JSONB(), nullable=False, default=dict, server_default='{}')
  # what was summed up here instead of their own entries: {"bytes", "files", "entries"}
  small = Column(JSONB(), nullable=False, default=dict, server_default='{}')
  # deleted (or tracked as an export...) from the scan's page, after the scan
  action = Column(String(), nullable=True)

  __table_args__ = (
    Index('ix_storage_scan_entries_parent', 'scan_id', 'parent', text('bytes DESC')),
    Index('ix_storage_scan_entries_kind', 'scan_id', 'kind', text('bytes DESC')),
    Index('ix_storage_scan_entries_owner', 'scan_id', 'owner'),
  )
