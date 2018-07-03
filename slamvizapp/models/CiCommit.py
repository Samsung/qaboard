"""
A version of the code on which we ran SLAM performance test.
"""
from pathlib import Path
from hashlib import md5

from sqlalchemy.orm import relationship, reconstructor, joinedload
from sqlalchemy.orm.exc import NoResultFound
from sqlalchemy import Column, ForeignKey
from sqlalchemy import String, DateTime, JSON

from slamvizapp import repos
from slamvizapp.models import Base, Batch, Output
from slamvizapp.models.LocalMocks import LocalGitCommit
from ..utils import get_users_per_name
from ..git_utils import find_branch
from ..config import ci_directory

class CiCommit(Base):
  """Refers to a git commit of the code
  on which we ran some SLAM performance test (likely in the CI).
  We keep some useful data in the database, but for the rest it used gitpython.
  """
  __tablename__ = 'ci_commits'
  id = Column(String, primary_key=True) # git commit id

  project_id = Column(String(), ForeignKey('projects.id'), index=True)
  project = relationship("Project", back_populates="ci_commits")

  authored_datetime = Column(DateTime(timezone=True), index=True)
  branch = Column(String(), index=True) # first added as.. we ignore tags?
  committer_name = Column(String(), index=True)
  message = Column(String())
  parents = Column(JSON())

  commit_dir_override = Column(String())
  commit_type = Column(String(), default='git')
  
  batches = relationship("Batch",
                         back_populates="ci_commit",
                         cascade="all, delete-orphan",
                         order_by=Batch.created_date,
                        )

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
      return Path(self.commit_dir_override)
    commit_dir_name = f'{int(self.authored_datetime.timestamp())}__git__{self.id[:8]}'
    return ci_directory / self.project.id / 'commits' / commit_dir_name

  @property
  def authored_date(self):
    return self.authored_datetime.date()

  @property
  def commit_dir_url(self):
    """The URL at which the data about this commit is stored. It's convenient."""
    if self.commit_dir_override is not None:
      if '/net/f2/algo_archive' in self.commit_dir_override:
        return '/s/'/self.commit_dir.relative_to('/net/f2/algo_archive')
      elif '/stage/algo_data' in self.commit_dir_override:
        return '/s/'/self.commit_dir.relative_to('/stage/algo_data')
      else:
        raise NotImplementedError
    return '/s/' / self.commit_dir.relative_to(ci_directory)

  def __repr__(self):
    return f"<CiCommit project='{self.project.id}' id='{self.id}' type='{self.commit_type}' ci_batch.outputs={len(self.ci_batch.outputs)}>"



  def __init__(self, commit, *, project, branch=None, commit_type='git'):
    self.project = project
    if commit_type == 'git':
      self.commit_type = 'git'
    else:
      self.commit_type = 'local'
      if not branch: branch='<NA>'
    self.id = commit.hexsha
    self.message = commit.message
    if branch:
      self.branch = branch
    else: # a commit belong to many branches, so this is a guess..
      self.branch = find_branch(commit.hexsha, self.repo)
    self.authored_datetime = commit.authored_datetime
    self.time_of_last_batch = commit.authored_datetime
    self.committer_name = commit.committer.name


  @property
  def repo(self):
    if self.commit_type == 'git':
      return repos[self.project.id]
    else:
      return None    

  @property
  def gitcommit(self):
    if self.commit_type == 'git':
      return self.repo.commit(self.id)
    else:
      return LocalGitCommit(self.id, self.message, self.committer_name, self.authored_datetime)




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
        # session.add(ci_commit)
        # session.commit()
        return ci_commit
      except ValueError:
        raise (ValueError, f'[ERROR] could not create a commit for {commit.hexsha}')
      if ci_commit is None:
        raise (ValueError, f'[ERROR] something is wrong,\
                             maybe an error opening param.json for {commit.hexsha}')


  def to_dict(self, with_aggregation=None, with_batches=None, with_outputs=False):
    users_db = get_users_per_name("")
    committer_avatar_url = ''
    if users_db:
      name = self.committer_name.lower()
      if name in users_db:
        committer_avatar_url = users_db[name]['avatar_url']
      elif name.replace('.', '') in users_db:
        committer_avatar_url = users_db[name.replace('.', '')]['avatar_url']
      elif name.replace(' ', '') in users_db:
        committer_avatar_url = users_db[name.replace('.', '')]['avatar_url']
      else:
        name_hash = md5(name.encode('utf8')).hexdigest()
        committer_avatar_url = f'http://gravatar.com/avatar/{name_hash}'
    return {
        'id': self.id,
        'type': self.commit_type,
        'branch': self.branch,
        'parents': [p for p in self.parents] if self.parents else [],
        'message': self.message,
        'committer_name': self.committer_name,
        'committer_avatar_url': committer_avatar_url,
        'authored_datetime': self.authored_datetime.isoformat(),
        'authored_date': self.authored_date.isoformat(),
        'commit_dir_url': str(self.commit_dir_url),
        'batches': {b.label: b.to_dict(with_outputs=with_outputs, with_aggregation=with_aggregation)
                    for b in self.batches
                    if with_batches is None or b.label in with_batches},
        'time_of_last_batch': self.time_of_last_batch.isoformat(),
    }





def latest_successful_commit(session, project_id, branch, within_last=5):
  """
  Returns the latest commit on a given branch where we got outputs.
  Only the latest within_last commits are checked...
  """
  # if project_id != 'dvs/psp_swip':
  ci_commits = (session
                .query(CiCommit)
                .options(joinedload(CiCommit.batches))
                .filter(
                  CiCommit.project_id==project_id,
                  CiCommit.branch==branch
                )
                .order_by(CiCommit.authored_datetime.desc())
                .limit(within_last)
               )
  for ci_commit in ci_commits:
    valid_outputs = [o for o in ci_commit.ci_batch.outputs
                     if not o.is_failed and not o.is_pending]
    if valid_outputs:
      return ci_commit

  # else:
  #   repo = repos[project_id]
  #   page = 0
  #   while page < 10:
  #     commits = repo.iter_commits(branch, max_count=20, skip=20*page)
  #     commit_ids = [c.hexsha for c in commits]
  #     ci_commits = (CiCommit
  #                   .query
  #                   .filter(CiCommit.id.in_(commit_ids))
  #                   .order_by(
  #                     CiCommit.authored_datetime.desc()
  #                   )
  #                  )
  #     ci_commits_successful = [c for c in ci_commits if len(c.ci_batch.outputs) > 10]
  #     if ci_commits_successful: return ci_commits_successful[0]
  #     page = page + 1



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
