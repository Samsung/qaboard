"""turning the many metrics columns into a single JSON column and adding is_running

Revision ID: f6a4bc0b55f8
Revises: b0785fa8ab5a
Create Date: 2018-04-12 13:47:57.252278

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'f6a4bc0b55f8'
down_revision = 'b0785fa8ab5a'
branch_labels = None
depends_on = None


# https://stackoverflow.com/questions/24612395/how-do-i-execute-inserts-and-updates-in-an-alembic-upgrade-script
from sqlalchemy import Column, Float, Integer, Boolean, JSON
from sqlalchemy.orm import sessionmaker, Session as BaseSession
from sqlalchemy.ext.declarative import declarative_base

Base = declarative_base()
Session = sessionmaker()

class SlamOutput(Base):
  __tablename__ = 'slam_outputs'
  id = Column(Integer, primary_key=True)

  is_running = Column(Boolean(), default=False)

  metrics = Column(JSON(), default=None)

  latency = Column(Float(), default=None)
  computation_time = Column(Float(), default=None)
  duration = Column(Float(), default=None)
  cpu_utilization = Column(Float())
  time_offset_to_groundtruth = Column(Float(), default=None)
  translation_rmse = Column(Float(), default=None)
  translation_aape = Column(Float(), default=None)
  translation_drift = Column(Float(), default=None)
  translation_rmse_pc = Column(Float(), default=None)
  translation_aape_pc = Column(Float(), default=None)
  translation_drift_pc = Column(Float(), default=None)
  rotation_rmse = Column(Float(), default=None)
  rotation_mean = Column(Float(), default=None)
  rotation_drift = Column(Float(), default=None)
  translation_aape_during_tracking = Column(Float(), default=None)
  frac_tracking_state_good = Column(Float(), default=None)
  frac_tracking_state_lost = Column(Float(), default=None)
  frac_tracking_state_imu3 = Column(Float(), default=None)
  frac_tracking_state_imu6 = Column(Float(), default=None)
  total_time_lost_pc = Column(Float(), default=None)
  total_time_lost = Column(Float(), default=None)
  nb_lost = Column(Integer(), default=None)
  median_lost_duration = Column(Float(), default=None)
  translation_aape_when_good = Column(Float(), default=None)
  rotation_mean_when_good = Column(Float(), default=None)
  time_before_first_lost = Column(Float(), default=None)
  time_pc_before_first_lost = Column(Float(), default=None)

metrics = [
  'latency',
  'computation_time',
  'duration',
  'cpu_utilization',
  'time_offset_to_groundtruth',
  'translation_rmse',
  'translation_aape',
  'translation_drift',
  'translation_rmse_pc',
  'translation_aape_pc',
  'translation_drift_pc',
  'rotation_rmse',
  'rotation_mean',
  'rotation_drift',
  'translation_aape_during_tracking',
  'frac_tracking_state_good',
  'frac_tracking_state_lost',
  'frac_tracking_state_imu3',
  'frac_tracking_state_imu6',
  'total_time_lost_pc',
  'total_time_lost',
  'nb_lost',
  'median_lost_duration',
  'translation_aape_when_good',
  'rotation_mean_when_good',
  'time_before_first_lost',
  'time_pc_before_first_lost',
]


def upgrade():
  op.add_column('slam_outputs', sa.Column('metrics', sa.JSON))
  op.add_column('slam_outputs', sa.Column('is_running', sa.Boolean))
  op.drop_column('slam_outputs', 'trajectory_length')
  # populate the new column
  bind = op.get_bind()
  session = Session(bind=bind)

  for o in session.query(SlamOutput):
    new_metrics = {}
    for m in metrics:
      # avoid NaN values
      if getattr(o, m) != getattr(o, m): continue
      new_metrics[m] = getattr(o, m)
    setattr(o, 'metrics', new_metrics) 
    session.add(o)
  session.commit()

  # remove the old columns
  for metric in metrics:
    op.drop_column('slam_outputs', metric)


def downgrade():
  op.add_column('slam_outputs', sa.Column('trajectory_length', sa.Float))
  for metric in metrics:
    op.add_column('slam_outputs', sa.Column(metric, sa.Float))

  # populate the metrics columns
  bind = op.get_bind()
  session = Session(bind=bind)


  for o in session.query(SlamOutput):
    for m in metrics:
      if m in getattr(o, 'metrics'):
        value = getattr(o, 'metrics')[m]
        setattr(o, m, value)
    session.add(o)
  session.commit()

  op.drop_column('slam_outputs', 'metrics')
  op.drop_column('slam_outputs', 'is_running')
