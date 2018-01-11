"""
"""
import datetime
import json
import shutil
import re
import sys
import pickle

import numpy as np
from sqlalchemy.orm import relationship
from sqlalchemy import Column, ForeignKey
from sqlalchemy import String, Integer, DateTime

from slamvizapp.models import Base, ParametersSet
from ..utils import cache
from ..utils import get_users_per_name
from ..git_utils import find_branch, list_commits
from ..config import *


class CiCommit(Base):
  """Refers to a git commit of the code on which we ran some SLAM performance test (likely in the CI).
  We keep some useful data in the database, but for the rest it used gitpython.
  """
  __tablename__ = 'ci_commits'
  id = Column(String, primary_key=True) # git commit id
  authored_datetime = Column(DateTime(timezone=False))

  slam_outputs = relationship("SlamOutput", back_populates="ci_commit",
    # if we delete a cicommit, no need to save its results
    # but let's be careful for now....
    # cascade="all, delete, delete-orphan"
  )

  default_parameters_set_id = Column(Integer(), ForeignKey('parameters_sets.id'), nullable=False)
  branch = Column(String()) # first added as.. we ignore tags?
  default_parameters_set = relationship("ParametersSet", back_populates="default_for_ci_commits")



  @property
  def commit_dir(self):
    """Returns the folder in all the data for this commit is stored."""
    commit_dir_name = f'{self.gitcommit.authored_date}__git__{self.gitcommit.hexsha[:8]}'
    return ci_directory / 'commits' / commit_dir_name

  @property
  def output_dir(self):
    """Returns the folder where outputs are stored"""
    return self.commit_dir / 'output'

  @property
  def authored_date(self):
    return self.authored_datetime.date()

  @property
  def commit_dir_url(self):
    """The URL at which the data about this commit is stored. It's convenient."""
    return '/s/'/self.commit_dir.relative_to(ci_directory)


  def __repr__(self):
    return f"<CiCommit(id='{self.id}' tuning_set_id={self.default_parameters_set_id}>"


  def __init__(self, commit):
    self.gitcommit = commit
    self.id = commit.hexsha
    self.authored_datetime = commit.authored_datetime

    print('getting outputs:', self.gitcommit.hexsha)

    # FIXME - without this the CI will fail
    # this should be cached....
    self._branch = None
    self._metrics = {}

    self.default_parameters_set = ParametersSet(self.commit_dir /"params.json")
    # self._failed = False # build failure or else...
    # self.ci_run_datetime = commit.authored_datetime

    # FIXME: when there are multiple sorts it gets more complicated...
    # we find the available outputs
    slam_outputs = []
    output_dirs = [p.parent for p in self.output_dir.rglob('camera_poses_debug.csv')]
    for output_dir in output_dirs:
        rel_recording_path = str(output_dir.relative_to(self.output_dir))+'.bin'
        rel_folderpath = str(output_dir.relative_to(ci_directory))

        for platform in Platform:
          metrics_file = (ci_commit.output_dir/platform/'metrics.json')
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

        slam_output = SlamOutput(self.output_dir/'metrics.json')


        slam_outputs.append(slam_output)
        session.query.(Recording).Query(path=rel_recording_path).slam_outputs.append(slam_output)
        
        # FIXME
    self.slam_outputs = slam_outputs


  # FIXME: replace with the SQL data :_)
  # def run_parameters(self):
  #     parameter_file = self.commit_dir /"params.json"
  #     if parameter_file.exists():
  #         with parameter_file.open() as f:
  #             return json.load(f)
  #     else:
  #         return {}



  # def count_failures(self):
  def number_failures(self):
      """Returns an estimate of the number of failed runs from the LSF logs"""
      # or just get that as an ouput as well? => easier to update the counts!
      return self.outputs.filter_by(is_failed=True).count()

      # lsf_logs_file = self.commit_dir / 'lsf.log'
      # if not lsf_logs_file.exists():
      #     return '[ALL]'
      # with lsf_logs_file.open('r') as f:
      #     failures = 0
      #     for line in f:
      #         if re.search("Exited with exit code", line):
      #             failures += 1
      # return failures

  # Finding to branch to which a commit belongs is ... a guess
  # and it can be slow, so we cache the results
  def branch(self):
      self._branch = find_branch(self.gitcommit.hexsha)
      return self._branch

  # FIXME: we don't care now that we have a DB
  # Without a database, listing the recordings for which we have outputs (metrics, etc) is slow
  # def updating(self):
  #     """If there is no SLAM run currently being computed, we can safely cache the results."""
  #     return datetime.datetime.now().astimezone()-self.ci_run_datetime<datetime.timedelta(hours=1)







  def aggregated_metrics(self, filename_filter='', filename_exclude=''):
      # in this case we avoid any caching
      if filename_filter or filename_exclude:
          outputs = self.outputs(filename_filter, filename_exclude)
          return aggregated_metrics(outputs)

      if not self._metrics:
          self._metrics = aggregated_metrics(self.outputs())
      return self._metrics

  def metrics(self, metric, outputs=None):
      """Returns a list of results - for a chosen metric - over the commit's outputs.
      The optionnal `outputs` parameter makes it almost like a static method. It helps with scope issues in the templates.
      """
      if not outputs:
          outputs = self.outputs()
      return [o['metrics'][metric] for o in outputs.values() if metric in o['metrics']]



# this is so ugly
def aggregated_metrics(outputs):
    metrics = [o['metrics'] for o in outputs.values()]
    compute_time = [m['compute_time']/m['duration'] for m in metrics if 'compute_time ' in m]

    translation_rmse = [m['translation_rmse'] for m in metrics if 'translation_rmse' in m]
    rotation_rmse = [m['rotation_rmse'] for m in metrics if 'rotation_rmse' in m]
    rotation_mean = [m['rotation_mean'] for m in metrics if 'rotation_mean' in m]
    final_drift_pc = [m['final_drift_pc'] for m in metrics if 'final_drift_pc' in m]
    aape = [m['aape'] for m in metrics if 'aape' in m]

    translation_rmse_is_bad = [m['translation_rmse']>0.01 for m in metrics if 'translation_rmse' in m]
    rotation_rmse_is_bad = [m['rotation_rmse']>1.5 for m in metrics if 'rotation_rmse' in m]
    rotation_mean_is_bad = [m['rotation_mean']>1.5 for m in metrics if 'rotation_mean' in m]
    final_drift_pc_is_bad = [m['final_drift_pc']>0.01 for m in metrics if 'final_drift_pc' in m]
    aape_is_bad = [m['aape']>0.01 for m in metrics if 'aape' in m]

    return {
        'compute_time_median': 1000*np.median(compute_time),
        'pc_where_lost_at_least_once': np.mean([m['nb_lost']>0 for m in metrics]),
        'total_time_lost_pc_mean': np.mean([m['total_time_lost_pc'] for m in metrics]),

        'translation_rmse_median': np.median(translation_rmse),
        'translation_rmse_average': np.mean(translation_rmse),
        'translation_rmse_pc_bad': np.mean(translation_rmse_is_bad),

        'rotation_rmse_median': np.median(rotation_rmse),
        'rotation_rmse_average': np.mean(rotation_rmse),
        'rotation_rmse_pc_bad': np.mean(rotation_rmse_is_bad),


        'rotation_mean_median': np.median(rotation_mean),
        'rotation_mean_average': np.mean(rotation_mean),
        'rotation_mean_pc_bad': np.mean(rotation_mean_is_bad),

        'aape_median': np.median(aape),
        'aape_pc_bad': np.mean(aape_is_bad),

        'final_drift_pc_median': np.median(final_drift_pc),
        'final_drift_pc_bad': np.mean(final_drift_pc_is_bad),
    }


def latest_successful_commit(branch='origin/develop'):
  """Returns the latest commit on a given branch where we got outputs."""
  # one of those should be successful
  page = 0
  while page<10:
    ci_commits = [CiCommit(c) for c in list_commits(branch, page=page, max_count=20)]
    # likely we fetched the outputs before so it should be fast
    ci_commits = [c for c in ci_commits if len(c.outputs())>10]
    if ci_commits:
      return ci_commits[0]  
    page = page + 1

def parent_successful_commit(ci_commit):
  """Returns a commit's latest successful parent."""
  # we don't handle merges that well
  parent = CiCommit(commit.gitcommit.parents[0])
  while not parent.outputs():
    parent = CiCommit(parent.gitcommit.parents[0])
  return parent

