"""
Notifications users asked for when a `qa batch` command ends, e.g. "Email me when it ends" when tuning from QA-Board.

One row per `qa batch` command (its command_id). Runs remember the command that started them in
Output.data.root_command_id: runs started by nested `qa batch` commands (e.g. the steps of pipelines) keep the
command_id of the first one. When a run ends, we look for its command's notification (a lookup by a unique key):
if there is one and none of the command's runs are pending anymore, we send it. See backend/notifications/.
"""
import datetime

from sqlalchemy import Column, Integer, String, Text, DateTime, ForeignKey
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import relationship

from backend.models import Base


class BatchNotification(Base):
  __tablename__ = 'batch_notifications'

  id = Column(Integer, primary_key=True)
  created_date = Column(DateTime, default=datetime.datetime.utcnow, nullable=False)
  # the `qa batch` command we wait for
  command_id = Column(String(), nullable=False, unique=True)
  # only "email" for now
  channel = Column(String(), nullable=False, default='email', server_default='email')
  user_name = Column(String())
  recipient = Column(String())

  ci_commit_id = Column(Integer, ForeignKey('ci_commits.id', ondelete='CASCADE'), nullable=False, index=True)
  ci_commit = relationship("CiCommit")
  # the batch the command was started in. Runs of nested commands can be in other batches of the commit.
  batch_id = Column(Integer, ForeignKey('batches.id', ondelete='SET NULL'), nullable=True)
  batch = relationship("Batch")

  # waiting: until the command's runs end. sending -> sent | failed. cancelled: e.g. the batch failed to start.
  status = Column(String(), nullable=False, default='waiting', server_default='waiting')
  finished_at = Column(DateTime)
  sent_at = Column(DateTime)
  error = Column(Text())
  # what users asked for, to describe it: source (webapp|cli), label, selected_group, platform, tuning_search...
  data = Column(JSONB(), nullable=False, default=dict, server_default='{}')

  def __repr__(self):
    return f"<BatchNotification command_id='{self.command_id}' status='{self.status}' recipient='{self.recipient}' />"
