"""
Storages the server can reach besides $QABOARD_STORAGE_ROOTS, added while it runs: a bucket mounted on the server,
another disk. Each run stores its full location (outputs.output_dir_override, e.g. "s3://team-a/qaboard/..."): a row
here only says how the server reaches the locations under its `url`, so editing a row never strands runs.
See backend/locations.py.
"""
import datetime

from sqlalchemy import Column, Integer, String, DateTime
from sqlalchemy.dialects.postgresql import JSONB

from backend.models import Base


class StorageLocation(Base):
  __tablename__ = 'storage_locations'

  id = Column(Integer, primary_key=True)
  # what runs' locations start with, ending with "/": "s3://team-a/qaboard/", "file:///mnt/disk2/"
  url = Column(String(), nullable=False, unique=True)
  # where the server reads and writes it, e.g. where the bucket is mounted: "/mnt/team-a/qaboard/"
  path = Column(String(), nullable=False)
  # the projects whose uploaded runs go here: ids, a group's id for all its projects, or "*"
  projects = Column(JSONB(), nullable=False, default=list, server_default='[]')
  # for what comes later (credentials, native access): {}
  options = Column(JSONB(), nullable=False, default=dict, server_default='{}')
  created_at = Column(DateTime, nullable=False, default=datetime.datetime.utcnow)
  updated_at = Column(DateTime, nullable=False, default=datetime.datetime.utcnow, onupdate=datetime.datetime.utcnow)
