"""
A version of the code on which we ran SLAM performance test.
"""
import datetime

import numpy as np
from sqlalchemy.orm import relationship, reconstructor
from sqlalchemy.orm.exc import NoResultFound
from sqlalchemy import Column, ForeignKey
from sqlalchemy import String, Integer, DateTime

from slamvizapp import repo
from slamvizapp.models import Base, Batch
# from ..utils import get_users_per_name
from ..git_utils import find_branch
from ..config import *


class CiCommit(Base):
  """Refers to a git commit of the code on which we ran some SLAM performance test (likely in the CI).
  We keep some useful data in the database, but for the rest it used gitpython.
  """
  __tablename__ = 'ci_commits'
  id = Column(String, primary_key=True) # git commit id

  project = Column(String(), default='dvs/psp_swip')
  branch = Column(String()) # first added as.. we ignore tags?
  committer_name = Column(String())
  authored_datetime = Column(DateTime(timezone=True))


  batches = relationship("Batch", order_by=Batch.created_date, back_populates="ci_commit")
  # what we care about for quality summaries
  # ci_batch_id = Column(Integer(), ForeignKey('batches.id'))
  # ci_batch = relationship("Batch", foreign_keys=[ci_batch_id])
  # we hope it's the first built :)
  @property
  def ci_batch(self):
    if self.batches: return self.batches[0]
    return Batch(ci_commit=self, label='default')

  # this helps us understand if we expect pending SLAM results
  time_of_last_batch = Column(DateTime(timezone=True))

  latest_gitlab_pipeline = Column(String())
  # failed = Column(Boolean) # build failure or else...


  @property
  def commit_dir(self):
    """Returns the folder in all the data for this commit is stored."""
    commit_dir_name = f'{self.gitcommit.authored_date}__git__{self.gitcommit.hexsha[:8]}'
    return ci_directory / 'commits' / commit_dir_name

  @property
  def authored_date(self):
    return self.authored_datetime.date()

  @property
  def commit_dir_url(self):
    """The URL at which the data about this commit is stored. It's convenient."""
    return '/s/'/self.commit_dir.relative_to(ci_directory)

  def __repr__(self):
    return f"<CiCommit(id='{self.id}' ci_batch.slam_outputs={len(self.ci_batch.slam_outputs)}>"



  def __init__(self, commit, session, branch=None):
    self.gitcommit = commit
    self.id = commit.hexsha
    if branch:
      self.branch = branch
    else: # this is a wild guess..
      self.branch = find_branch(self.gitcommit.hexsha)
    self.authored_datetime = commit.authored_datetime
    self.time_of_last_batch = commit.authored_datetime
    self.committer_name = commit.committer.name


  @reconstructor
  def init_on_load(self):
    self.gitcommit = repo.commit(self.id)


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
        ci_commit = CiCommit(commit, session=session)
        session.add(ci_commit)
        session.commit()
        return ci_commit
      except ValueError:
        raise (ValueError, f'ERROR: could not create a commit for {commit.hexsha}')
      if ci_commit is None: 
        raise (ValueError, f'ERROR: something is wrong, maybe an error opening param.json for {commit.hexsha}')


  def to_dict(self, with_details=False, users_db=None):
    committer_avatar_url = ''
    if users_db:
      name = self.gitcommit.committer.name
      if name in users_db:
        committer_avatar_url= users_db[name]['avatar_url']
      elif name.replace('.','') in users_db:
        committer_avatar_url= users_db[name.replace('.','')]['avatar_url']        
    if with_details:
      details = {
        'slam_outputs': {o.id: o.to_dict() for o in self.ci_batch.slam_outputs}
      }
    else:
      details = {}
    return {
      'id': self.id,
      'branch': self.branch,
      'type': 'git',
      'message': self.gitcommit.message,
      'parents': [p.hexsha for p in self.gitcommit.parents],
      'committer_name': self.gitcommit.committer.name,
      'committer_avatar_url': committer_avatar_url,
      'authored_datetime': self.authored_datetime.isoformat(),
      'authored_date': self.authored_date.isoformat(),
      'commit_dir_url': str(self.commit_dir_url),
      'batches': [{'id': :b.id} for b in self.batches],
      'time_of_last_batch': self.time_of_last_batch.isoformat(),

      'aggregated_metrics': {k:v for k,v in self.ci_batch.aggregated_metrics().items() if v==v}, # => is not NaN
      'valid_slam_outputs': [o.recording.path for o in self.ci_batch.valid_slam_outputs],
      'pending_slam_outputs': [o.recording.path for o in self.ci_batch.pending_slam_outputs],
      'failed_slam_outputs': [o.recording.path for o in self.ci_batch.failed_slam_outputs],
      **details,
    }





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
    ci_commits = [c for c in ci_commits if len(c.ci_batch.slam_outputs)>10]
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
    if parent_ci_commit.ci_batch.slam_outputs>10:
      return parent_ci_commit


