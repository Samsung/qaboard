"""
A version of the code on which we ran SLAM performance test.
"""
from sqlalchemy.orm import relationship, reconstructor
from sqlalchemy.orm.exc import NoResultFound
from sqlalchemy import Column
from sqlalchemy import String, DateTime

from slamvizapp import repo
from slamvizapp.models import Base, Batch
# from ..utils import get_users_per_name
from ..git_utils import find_branch
from ..config import ci_directory

class CiCommit(Base):
  """Refers to a git commit of the code
  on which we ran some SLAM performance test (likely in the CI).
  We keep some useful data in the database, but for the rest it used gitpython.
  """
  __tablename__ = 'ci_commits'
  id = Column(String, primary_key=True) # git commit id

  project = Column(String(), default='dvs/psp_swip')
  branch = Column(String()) # first added as.. we ignore tags?
  committer_name = Column(String())
  authored_datetime = Column(DateTime(timezone=True))

  batches = relationship("Batch", order_by=Batch.created_date, back_populates="ci_commit")

  def get_or_create_batch(self, label):
    matching_batches = [b for b in self.batches if b.label == label]
    if matching_batches: return matching_batches[0]
    return Batch(ci_commit=self, label=label)

  @property
  def ci_batch(self):
    return self.get_or_create_batch('default')

  # this helps us understand if we expect pending SLAM results
  time_of_last_batch = Column(DateTime(timezone=True))

  latest_gitlab_pipeline = Column(String())
  # pipeline_failed = Column(Boolean)


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



  def __init__(self, commit, project='dvs/psp_swip', branch=None):
    self.gitcommit = commit
    self.id = commit.hexsha
    if branch:
      self.branch = branch
    else: # a commit belong to many branches, so this is a guess..
      self.branch = find_branch(self.gitcommit.hexsha)
    self.authored_datetime = commit.authored_datetime
    self.time_of_last_batch = commit.authored_datetime
    self.committer_name = commit.committer.name


  @reconstructor
  def init_on_load(self):
    self.gitcommit = repo.commit(self.id)


  @staticmethod
  def get_or_create(session, hexsha):
    try:
      commit = repo.commit(hexsha)
    except:
      raise (ValueError, f'[ERROR] could not create a commit for {commit.hexsha}')
    try:
      return session.query(CiCommit).filter_by(id=commit.hexsha).one()
    except NoResultFound:
      try:
        ci_commit = CiCommit(commit)
        session.add(ci_commit)
        session.commit()
        return ci_commit
      except ValueError:
        raise (ValueError, f'[ERROR] could not create a commit for {commit.hexsha}')
      if ci_commit is None:
        raise (ValueError, f'[ERROR] something is wrong,\
                             maybe an error opening param.json for {commit.hexsha}')


  def to_dict(self, with_details=False, users_db=None):
    committer_avatar_url = ''
    if users_db:
      name = self.gitcommit.committer.name
      if name in users_db:
        committer_avatar_url = users_db[name]['avatar_url']
      elif name.replace('.', '') in users_db:
        committer_avatar_url = users_db[name.replace('.', '')]['avatar_url']
    return {
        'id': self.id,
        'type': 'git',
        'branch': self.branch,
        'parents': [p.hexsha for p in self.gitcommit.parents],
        'message': self.gitcommit.message,
        'committer_name': self.gitcommit.committer.name,
        'committer_avatar_url': committer_avatar_url,
        'authored_datetime': self.authored_datetime.isoformat(),
        'authored_date': self.authored_date.isoformat(),
        'commit_dir_url': str(self.commit_dir_url),
        'batches': {b.label: b.to_dict(with_details=with_details) for b in self.batches},
        'time_of_last_batch': self.time_of_last_batch.isoformat(),
    }





def latest_successful_commit(branch='origin/develop'):
  """Returns the latest commit on a given branch where we got outputs."""
  # one of those should be successful
  page = 0
  while page < 10:
    commits = repo.iter_commits(branch, max_count=20, skip=20*page)
    commit_ids = [c.hexsha for c in commits]
    ci_commits = CiCommit.query\
      .filter(CiCommit.id.in_(commit_ids))\
      .order_by(CiCommit.authored_datetime.desc())
    ci_commits_successful = [c for c in ci_commits if len(c.ci_batch.slam_outputs) > 10]
    if ci_commits_successful: return ci_commits_successful[0]
    page = page + 1



def parent_successful_commit(ci_commit):
  """Returns a commit's latest successful parent."""
  # we arbitrarly pick the first parent
  parent_ci_commit = None
  parent_id = ci_commit.gitcommit.parents[0]
  while True:
    try:
      parent_ci_commit = CiCommit.query.filter(CiCommit.id == parent_id).one()
    except:
      continue
    if parent_ci_commit.ci_batch.slam_outputs > 10:
      return parent_ci_commit
