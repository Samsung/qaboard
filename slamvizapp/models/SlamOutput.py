"""
Describes an output from a SLAM run:
1. How we ran the SLAM
- what version of the code was used
- on what platform we ran
- what parameters were used
2. What results we got
- quality metrics: drift, RMSE, AAPE...
- what assets are available (debug movies...)
"""

from sqlalchemy import Column, ForeignKey
from sqlalchemy.orm import relationship
from sqlalchemy import Integer, String, Float, Boolean #, Enum

from slamvizapp.models import Base#, Platform



class SlamOutput(Base):
  __tablename__ = 'slam_outputs'
  id = Column(Integer, primary_key=True)

  # We could do something like
  #   metrics = Column(JSON)
  # But we want stuff like sorting etc.. and we know the metrics in advance

  # What we ran
  recording_id = Column(Integer(), ForeignKey('recordings.id'))
  recording = relationship("Recording", back_populates="slam_outputs")
  trajectory_length  = Column(Float()) # it's not normalized to store it here but..

  ci_commit_id = Column(String(), ForeignKey('ci_commits.id'))
  ci_commit = relationship("CiCommit", back_populates="slam_outputs")

  # How we ran
  configuration = Column(String()) # mono/stereo/whatever
  parameters_set_id = Column(String(), ForeignKey('parameters_sets.id'))
  parameters_set = relationship("ParametersSet", back_populates="slam_outputs")

  platform = Column(String())

  # How good we ran
  is_failed  = Column(Boolean(), default=False)
  latency  = Column(Float(), default=None) # 1x = realtime
  computation_time  = Column(Float(), default=None) # 1x = realtime
  duration = Column(Float(), default=None) # [seconds] Redundant, but...
  cpu_utilization = Column(Float())
  time_offset_to_groundtruth = Column(Float(), default=None)

  # Tracking quality
  translation_rmse = Column(Float(), default=None)
  translation_aape = Column(Float(), default=None)
  translation_drift = Column(Float(), default=None)
  translation_rmse_pc = Column(Float(), default=None)
  translation_aape_pc = Column(Float(), default=None)
  translation_drift_pc = Column(Float(), default=None)

  rotation_rmse = Column(Float(), default=None)
  rotation_mean = Column(Float(), default=None)
  rotation_drift = Column(Float(), default=None)
  # ...idem computed only when the tracking is good
  translation_aape_during_tracking = Column(Float(), default=None)

  # Loss of tracking
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

  # ...

  # User experience
  # jitter_sum_mabs = Column(Float(), default=None)
  # jitter_sum_mad = Column(Float(), default=None)
  # jitter_sum_std = Column(Float(), default=None)


  def __init__(self, **kwargs):
    # We remove attributes our model doesn't know.
    # There should be a better way to do this...
    columns = set(c.name for c in Base.metadata.tables['slam_outputs'].columns)
    relationships = set(['recording', 'ci_commit', 'parameters_set'])
    columns = columns | relationships

    # We change the name of a few metrics
    remapped_names = {
      'aape':'translation_aape',
      'final_drift': 'final_drift',
      'final_drift_pc':'translation_drift_pc',
    }
    for old, new in remapped_names.items():
      if old in kwargs:
        kwargs[new] = kwargs[old]
    kwargs = {k:v for k,v in kwargs.items() if k in columns}
    super(SlamOutput, self).__init__(**kwargs)


  @property
  def output_dir_url(self):
    return self.ci_commit.commit_dir_url / 'output' / self.recording.output_folder


  def __repr__(self):
    # parameter_set_id={self.parameter_set_id}
    return f"<SlamOutput(ci_commit_id='{self.ci_commit_id}' path={self.recording.path}"
