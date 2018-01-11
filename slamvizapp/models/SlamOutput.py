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
import enum

from sqlalchemy import Column, ForeignKey
from sqlalchemy.orm import relationship
from sqlalchemy import Integer, String, Enum, Float, Boolean

from slamvizapp.models import Base



class Platform(enum.Enum):
  # The CI currently runs a serial version of our SLAM
  lsf_serial = 1
  # Only the runs on a galaxy s8 are important!
  s8 = 2



class SlamOutput(Base):
  __tablename__ = 'slam_outputs'
  id = Column(Integer, primary_key=True)

  # We could do something like
  #   metrics = Column(JSON)
  # But we want stuff like sorting etc.. and we know the metrics in advance

  # What we ran
  recording_id = Column(Integer(), ForeignKey('recordings.id'), nullable=False)
  recording = relationship("Recording", back_populates="slam_outputs")

  ci_commit_id = Column(String(), ForeignKey('ci_commits.id'), nullable=False)
  ci_commit = relationship("CiCommit", back_populates="slam_outputs")

  # How we ran
  tuning_set_id = Column(Integer(), ForeignKey('parameters_sets.id'))
  platform = Column(Enum(Platform))

  # How good we ran
  is_failed  = Column(Boolean(), default=False)
  latency  = Column(Float(), default=None) # 1x = realtime
  computation_time  = Column(Float(), default=None) # 1x = realtime
  duration = Column(Float(), default=None) # [seconds] Redundant, but...
  cpu_utilization = Column(Float())
  # ...

  # Tracking quality
  translation_rmse = Column(Float(), default=None)
  translation_aape = Column(Float(), default=None)
  translation_drift = Column(Float(), default=None)
  rotation_rmse = Column(Float(), default=None)
  rotation_aape = Column(Float(), default=None)
  rotation_drift = Column(Float(), default=None)
  # ...idem computed only when the tracking is good

  # Loss of tracking
  total_time_lost_pc = Column(Float(), default=None)
  total_time_lost = Column(Float(), default=None)
  nb_lost = Column(Integer(), default=None)
  median_lost_duration = Column(Float(), default=None)
  # ...

  # User experience
  # jitter_sum_mabs = Column(Float(), default=None)
  # jitter_sum_mad = Column(Float(), default=None)
  # jitter_sum_std = Column(Float(), default=None)

  def __repr__(self):
    return f"<SlamOutput(commit_id= '{self.commit_id}' path={self.recording.path} tuning_set_id={self.tuning_set_id}>"


  def __init__(self, folder, ci_commit, recording):
      """ Gather the available results for this commit."""
      print('getting outputs:', self.gitcommit.hexsha)
      # fixme: with better scoping?
      self.ci_commit = ci_commit
      self.recording = recording

      # FIXME: for a specific plateform, so no play with metrics_s8..
      # FIXME: we should save results at $ROOT/$REL_PATH/$PLATEFORM/* instead

      metrics_file = (ci_commit.output_dir/'metrics.json')
      if not metrics_file.exists():
         self.is_failed =True
         return

      with metrics_file.open() as f:
        try:
          metrics = json.load(f)
          # FIXME: check???
          for k, v in metrics:
            self.k = v
        except:
          self.is_failed =True
          return

      # FIXME: replace with sql magic what uses:
      # self._outputs[str(rel_recording_path)] = {
      #     'output_dir': output_dir,
      #     'output_dir_url': f'/s/{rel_folderpath}/', # URL at which the outputs are accessible
      #     'rel_filepath': str(rel_recording_path),
      #     'metrics': metrics,
      # }
