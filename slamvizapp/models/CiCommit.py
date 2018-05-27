"""
A version of the code on which we ran SLAM performance test.
"""
from pathlib import Path
from sqlalchemy.orm import relationship, reconstructor
from sqlalchemy.orm.exc import NoResultFound
from sqlalchemy import Column
from sqlalchemy import String, DateTime

from slamvizapp import repos
from slamvizapp.models import Base, Batch
from slamvizapp.models.LocalMocks import LocalGitCommit
from ..git_utils import find_branch
from ..config import ci_directory

class CiCommit(Base):
  """Refers to a git commit of the code
  on which we ran some SLAM performance test (likely in the CI).
  We keep some useful data in the database, but for the rest it used gitpython.
  """
  __tablename__ = 'ci_commits'
  id = Column(String, primary_key=True) # git commit id

  project = Column(String())
  branch = Column(String()) # first added as.. we ignore tags?
  message = Column(String())
  committer_name = Column(String())
  authored_datetime = Column(DateTime(timezone=True))

  commit_dir_override = Column(String())
  commit_type = Column(String(), default='git')
  
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
    if self.commit_dir_override is not None:
      return Path(commit_dir_override)
    commit_dir_name = f'{self.gitcommit.authored_date}__git__{self.gitcommit.hexsha[:8]}'
    return ci_directory / self.project / 'commits' / commit_dir_name

  @property
  def authored_date(self):
    return self.authored_datetime.date()

  @property
  def commit_dir_url(self):
    """The URL at which the data about this commit is stored. It's convenient."""
    if self.commit_dir_override is not None:
      if '/net/f2/algo_archive' in self.commit_dir_override:
        return '/s/'/self.output_dir.relative_to('/net/f2/algo_archive')
      elif '/stage/algo_data' in self.commit_dir_override:
        return '/s/'/self.output_dir.relative_to('/stage/algo_data')
      else:
        raise NotImplementedError
    return '/s/'/self.commit_dir.relative_to(ci_directory)

  def __repr__(self):
    return f"<CiCommit id='{self.id}' type='{self.commit_type}' ci_batch.outputs={len(self.ci_batch.outputs)}>"



  def __init__(self, commit, *, project, branch=None, commit_type='git'):
    self.project = project
    if commit_type == 'git':
      self.commit_type = 'git'
      self.repo = repos[project]
    else:
      self.commit_type = 'local'
      if not branch: branch='<NA>'
      self.repo = ''
    self.gitcommit = commit
    self.id = commit.hexsha
    self.message = commit.message
    if branch:
      self.branch = branch
    else: # a commit belong to many branches, so this is a guess..
      self.branch = find_branch(self.gitcommit.hexsha, self.repo)
    self.authored_datetime = commit.authored_datetime
    self.time_of_last_batch = commit.authored_datetime
    self.committer_name = commit.committer.name


  @reconstructor
  def init_on_load(self):
    if self.commit_type == 'git':
      self.repo = repos[self.project]
      self.gitcommit = self.repo.commit(self.id)
    else:
      self.repo = None
      self.gitcommit = LocalGitCommit(self.id, self.message, self.committer_name, self.authored_datetime)



  @staticmethod
  def get_or_create(session, hexsha, repo):
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
      name = self.committer_name
      if name in users_db:
        committer_avatar_url = users_db[name]['avatar_url']
      elif name.replace('.', '') in users_db:
        committer_avatar_url = users_db[name.replace('.', '')]['avatar_url']
    return {
        'id': self.id,
        'type': self.commit_type,
        'branch': self.branch,
        'parents': [p.hexsha for p in self.gitcommit.parents],
        'message': self.message,
        'committer_name': self.committer_name,
        'committer_avatar_url': committer_avatar_url,
        'authored_datetime': self.authored_datetime.isoformat(),
        'authored_date': self.authored_date.isoformat(),
        'commit_dir_url': str(self.commit_dir_url),
        'batches': {b.label: b.to_dict(with_details=with_details) for b in self.batches},
        'time_of_last_batch': self.time_of_last_batch.isoformat(),
    }





def latest_successful_commit(repo=None, branch='origin/develop'):
  """Returns the latest commit on a given branch where we got outputs."""
  # one of those should be successful
  if not repo: return None
  page = 0
  while page < 10:
    commits = repo.iter_commits(branch, max_count=20, skip=20*page)
    commit_ids = [c.hexsha for c in commits]
    ci_commits = CiCommit.query\
      .filter(CiCommit.id.in_(commit_ids))\
      .order_by(CiCommit.authored_datetime.desc())
    ci_commits_successful = [c for c in ci_commits if len(c.ci_batch.outputs) > 10]
    if ci_commits_successful: return ci_commits_successful[0]
    page = page + 1



def parent_successful_commit(ci_commit):
  """Returns a commit's latest successful parent."""
  # if we don't have a git repo,
  # we try to find the previous commit on the same "branch"...
  if not ci_commit.repo:
    try:
      query = CiCommit.query\
                      .filter(
                        CiCommit.authored_datetime < self.authored_datetime,
                        CiCommit.branch == self.branch,
                      )
      for ci_commit in query:
        if len(ci_commit.ci_batch.outputs) > 10:
          return ci_commit
    except:
      return None

  parent_ci_commit = None
  # we arbitrarly pick the first git parent
  parent_id = ci_commit.gitcommit.parents[0]
  while True:
    try:
      parent_ci_commit = CiCommit.query\
                                 .filter(CiCommit.id == parent_id)\
                                 .order_by(CiCommit.authored_datetime.desc())\
                                 .one()
    except:
      return None
    if len(parent_ci_commit.ci_batch.outputs) > 10:
      return parent_ci_commit
    parent_id = parent_ci_commit.gitcommit.parents[0]
