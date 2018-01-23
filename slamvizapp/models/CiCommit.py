"""
A version of the code on which we ran SLAM performance test.
"""
import datetime
import shutil
import re
import sys
import pickle

import numpy as np
from sqlalchemy.orm import relationship, reconstructor
from sqlalchemy.orm.exc import NoResultFound
from sqlalchemy import Column, ForeignKey
from sqlalchemy import String, Integer, DateTime

from slamvizapp import repo
from slamvizapp.models import Base, Recording, ParametersSet, SlamOutput
from ..utils import filter_slam_outputs, get_users_per_name
from ..git_utils import find_branch
from ..config import *


class CiCommit(Base):
  """Refers to a git commit of the code on which we ran some SLAM performance test (likely in the CI).
  We keep some useful data in the database, but for the rest it used gitpython.
  """
  __tablename__ = 'ci_commits'
  id = Column(String, primary_key=True) # git commit id
  authored_datetime = Column(DateTime(timezone=True))
  # this helps us understand if we expect pending SLAM results
  time_of_last_slam_job = Column(DateTime(timezone=True))
  slam_outputs = relationship("SlamOutput", back_populates="ci_commit",
    # if we delete a cicommit, no need to save its results
    # but let's be careful for now....
    # cascade="all, delete, delete-orphan"
  )

  branch = Column(String()) # first added as.. we ignore tags?
  project = Column(String()) # dvs/psp_swip

  default_parameters_set_id = Column(String(), ForeignKey('parameters_sets.id'), nullable=False)
  default_parameters_set = relationship("ParametersSet", back_populates="ci_commits_for_which_default")

  # failed = Column(Boolean) # build failure or else...


  @property
  def commit_dir(self):
    """Returns the folder in all the data for this commit is stored."""
    commit_dir_name = f'{self.gitcommit.authored_date}__git__{self.gitcommit.hexsha[:8]}'
    return ci_directory / 'commits' / commit_dir_name

  # for a fake CiCommit, we must
  # - change commit_dir to a hardcoded value
  # - add all the self.properties
  # - add .gitcommit.authored_date, etc

  @property
  def   output_dir(self):
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
    return f"<CiCommit(id='{self.id}' slam_outputs={len(self.slam_outputs)} default_parameters_set_id={self.default_parameters_set_id}>"



  def __init__(self, commit, project, session, branch=None):
    self.gitcommit = commit
    self.id = commit.hexsha
    self.project = project
    if branch:
      self.branch = branch
    else: # this is a wild guess..
      self.branch = find_branch(self.gitcommit.hexsha) # this is a wild guess..
    self.authored_datetime = commit.authored_datetime
    self.time_of_last_slam_job = commit.authored_datetime

    # to access easily the id of this set of parameters, we create a dummy object
    # we'll re-use it if it doesn't exist already in the database
    try:
      file_contents = repo.git.show('{}:{}'.format(commit.hexsha, 'swip_slam/UnitTests/RunningTime/params.json'))
      print(file_contents)
      self.default_parameters_set = ParametersSet(parameters_text=file_contents)
      # self.default_parameters_set = ParametersSet(parameters_file=self.commit_dir /"params.json")
    except FileNotFoundError:
      raise ValueError

    try:
      self.default_parameters_set = session.query(ParametersSet).filter_by(id=parameter_set.id).one()
    except NoResultFound:
        self.default_parameters_set = parameter_set


  @reconstructor
  def init_on_load(self):
    self.gitcommit = repo.commit(self.id)


  def discover_slam_outputs(self, session):
    """Find outputs saved on the disk to initialize the database"""
    # FIXME: enable discovering outputs from the s8 or other plateforms...
    #        and different modes...
    slam_outputs = []

    # FIXME: we should also look for unsuccessful runs
    #   we could look into lsf.log and parse it for recoring names
    #   then check whether we have them of not...
    # we look for successful runs
    output_dirs = [p.parent for p in self.output_dir.rglob('metrics.json')]
    for output_dir in output_dirs:
      rel_recording_path = str(output_dir.relative_to(self.output_dir))+'.bin'
      recording = Recording.get_or_create(session, path=rel_recording_path)
      if not recording:
        continue

      slam_output = SlamOutput.get_or_create(session,
        recording=recording,
        platform='lsf',
        configuration='serial-stereo',
        default_parameters_set=self.default_parameters_set,
        ci_commit=self,
      )

      # we find the metrics,
      slam_output.update_metrics_from_file(output_dir/'metrics.json')


  @property
  def valid_slam_outputs(self):
    return [o for o in self.slam_outputs if not o.is_failed]

  @property
  def pending_slam_outputs(self):
    return [o for o in self.slam_outputs if o.is_pending]

  def failures_count(self):
      """Returns an estimate of the number of failed runs"""
      return len([o for o in self.slam_outputs if o.is_failed])

  def aggregated_metrics(self, filename_filter='', filename_exclude=''):
      return aggregated_metrics(filter_slam_outputs(self.valid_slam_outputs, filename_filter, filename_exclude))

  def metrics(self, metric, outputs=None):
      """Returns a list of results - for a chosen metric - over the commit's outputs.
      The optionnal `outputs` parameter makes it almost like a static method. It helps with scope issues in the templates.
      """
      if not outputs:
        outputs = self.slam_outputs
      return [getattr(o, metric) for o in outputs if hasattr(o, metric)]

  @staticmethod
  def get_or_create(session, hexsha, **kwargs):
    try:
      commit = repo.commit(hexsha)
    except:
      raise (ValueError, f'ERROR: could not create a commit for {commit.hexsha}')      
    try:
      return session.query(CiCommit).filter_by(id=commit.hexsha).one()
    except NoResultFound:
      try:
        ci_commit = CiCommit(commit, project='dvs/psp_swip', session=session)
        session.add(ci_commit)
        session.commit()
        return ci_commit
      except ValueError:
        raise (ValueError, f'ERROR: could not create a commit for {commit.hexsha}')
      if ci_commit is None: 
        raise (ValueError, f'ERROR: something is wrong, maybe an error opening param.json for {commit.hexsha}')

  # @property
  # def compute_time_vs_realtime(self):
  #   """Returns the computation time as multile of real-time (1x = real-time)"""
  #   if not m.computation_time or not m.duration:
  #     return None
  #   return 1000*m.computation_time/m.duration



# this is so ugly, it should be refactored into sql
def aggregated_metrics(slam_outputs):
    aggregated = {
        'pc_where_lost_at_least_once': np.mean([m.nb_lost>0 for m in slam_outputs if m.nb_lost]),
        'total_time_lost_pc_mean': np.mean([m.total_time_lost_pc for m in slam_outputs if m.total_time_lost_pc]),
    }
    # metric_name, threshold_good 
    metrics_to_aggregate = [
      ('translation_rmse', 0.01),
      ('translation_aape', 0.01),
      ('translation_drift_pc', 0.01),
      ('rotation_mean', 1.5),
      ('rotation_mean_when_good', 1.5),
      ('translation_aape_when_good', 0.01),
      ('frac_tracking_state_good', .99),
      # ('compute_time_vs_realtime', 1), # FIXME: it's not an attribute so the call will fail
    ]
    for metric, treshold in metrics_to_aggregate:
      values = np.array([getattr(o, metric) for o in slam_outputs if getattr(o, metric)])
      aggregated[f'{metric}_median'] = np.median(values)
      aggregated[f'{metric}_average']= np.average(values)
      aggregated[f'{metric}_pc_bad'] = np.mean(values<treshold)
    return aggregated



def latest_successful_commit(branch='origin/develop'):
  """Returns the latest commit on a given branch where we got outputs."""
  # one of those should be successful
  page = 0
  while page<10:
    commits = repo.iter_commits(branch, max_count=20, skip=20*page)
    commit_ids = [c.hexsha for c in commits]
    ci_commits = CiCommit.query.filter(CiCommit.id.in_(commit_ids)).order_by(CiCommit.authored_datetime.desc())
    # ci_commits = CiCommit.query.order_by(CiCommit.authored_datetime.desc()).limit(20).offset(page*20)
    # likely we fetched the outputs before so it should be fast
    ci_commits = [c for c in ci_commits if len(c.slam_outputs)>10]
    if ci_commits:
      return ci_commits[0]  
    page = page + 1



def parent_successful_commit(ci_commit):
  """Returns a commit's latest successful parent."""
  # we arbitrarly pick the first parent
  parent_ci_commit = None
  parent_id = ci_commit.gitcommit.parents[0]
  while True:
    try:
      parent_ci_commit = CiCommit.query.filter(CiCommit.id==parent_id).one()
    except:
      continue
    if parent_ci_commit.slam_outputs>10:
      return parent_ci_commit


