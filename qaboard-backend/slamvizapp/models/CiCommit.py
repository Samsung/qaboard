"""
A version of the code on which we ran SLAM performance test.
"""
import re
import json
import fnmatch
from hashlib import md5
from pathlib import Path

from requests.utils import quote
from sqlalchemy import Column, Boolean, Integer, String, DateTime, JSON, ForeignKey
from sqlalchemy import or_, UniqueConstraint
from sqlalchemy.orm import relationship, reconstructor, joinedload
from sqlalchemy.orm.exc import NoResultFound, MultipleResultsFound

from slamvizapp.models import Base, Batch, Output
from slamvizapp.models.LocalMocks import LocalGitCommit
from ..utils import get_users_per_name
from ..git_utils import find_branch



class CiCommit(Base):
  """Refers to a git commit of the code
  on which we ran some SLAM performance test (likely in the CI).
  We keep some useful data in the database, but for the rest it used gitpython.
  """
  __tablename__ = 'ci_commits'
  id = Column(Integer(), primary_key=True)
  hexsha = Column(String(), index=True, nullable=False)
  project_id = Column(String(), ForeignKey('projects.id'), index=True)

  project = relationship("Project", back_populates="ci_commits")
  __table_args__ = (UniqueConstraint('project_id', 'hexsha', name='_project_hexsha'),)

  authored_datetime = Column(DateTime(timezone=True), index=True)
  branch = Column(String(), index=True) # first added as.. we ignore tags?
  committer_name = Column(String(), index=True)
  message = Column(String())
  parents = Column(JSON())
  data = Column(JSON(), default={})

  commit_dir_override = Column(String())
  commit_type = Column(String(), default='git')
  
  batches = relationship("Batch",
                         back_populates="ci_commit",
                         cascade="all, delete-orphan",
                         order_by=Batch.created_date,
                        )

  latest_output_datetime = Column(DateTime(timezone=True))
  deleted = Column(Boolean(), default=False)



  def get_or_create_batch(self, label):
    matching_batches = [b for b in self.batches if b.label == label]
    if matching_batches: return matching_batches[0]
    return Batch(ci_commit=self, label=label)

  @property
  def ci_batch(self):
    return self.get_or_create_batch('default')


  @property
  def authored_date(self):
    return self.authored_datetime.date()


  @property
  def commit_dir(self):
    """Returns the folder in all the data for this commit is stored."""
    if self.commit_dir_override is not None:
      out = Path(self.commit_dir_override)
    else:
      commit_dir_name = f'{int(self.authored_datetime.timestamp())}__{self.committer_name.replace(" ", " ")}__{self.hexsha[:8]}'
      out = self.project.ci_directory / self.project.id_git / 'commits' / commit_dir_name
    if self.project.id_relative:
      return out / self.project.id_relative
    else:
      return out

  @property
  def repo_commit_dir(self):
    if self.commit_dir_override is not None:
      return Path(self.commit_dir_override)
    else:
      commit_dir_name = f'{int(self.authored_datetime.timestamp())}__{self.committer_name}__{self.hexsha[:8]}'
      return self.project.ci_directory / self.project.id_git / 'commits' / commit_dir_name

  @property
  def commit_dir_url(self):
    """The URL at which the data about this commit is stored. It's convenient."""
    if self.commit_dir_override is not None:
      relative_path = self.commit_dir_override
      return quote(f'/s{relative_path}')
    return quote(f"/s{self.commit_dir}".replace("/home/arthurf/ci", ""))


  @property
  def repo_commit_dir_url(self):
    """The URL at which the data about this commit is stored. It's convenient."""
    if self.commit_dir_override is not None:
      relative_path = self.commit_dir_override
      return quote(f'/s{relative_path}')
    return quote(f"/s{self.repo_commit_dir}")



  def __repr__(self):
    outputs = f"ci_batch.outputs={len(self.ci_batch.outputs)}" if len(self.ci_batch.outputs) else ''
    branch = re.sub('origin/', '', self.branch)
    return f"<CiCommit project='{self.project.id}' hexsha='{self.hexsha[:8]}' branch='{branch}' {outputs}>"



  def __init__(self, commit, *, project, branch=None, commit_type='git'):
    self.project = project
    if commit_type == 'git':
      self.commit_type = 'git'
    else:
      self.commit_type = 'local'
      if not branch: branch='<NA>'
    self.hexsha = commit.hexsha
    self.message = commit.message
    self.parents = [c.hexsha for c in commit.parents]
    if branch:
      self.branch = branch
    else: # a commit belong to many branches, so this is a guess..
      self.branch = find_branch(commit.hexsha, self.project.repo)
    self.authored_datetime = commit.authored_datetime
    self.latest_output_datetime = commit.authored_datetime
    self.committer_name = commit.committer.name


  @property
  def gitcommit(self):
    if self.commit_type == 'git':
      return self.project.repo.commit(self.hexsha)
    else:
      # this mocks a real git commit
      return LocalGitCommit(self.hexsha, self.message, self.committer_name, self.authored_datetime)


  def delete(self, ignore=None, dryrun=False):
    """
    Delete the commit's artifacts, and mark it as delete.
    NOTE: We don't touch batches/outputs, you have to deal with them yourself.
          See hard_delete() in api/webhooks.py and clean.py
    """
    manifest_dir = self.commit_dir / 'manifests'
    if self.commit_dir.exists():
      if not manifest_dir.exists():
        # Old versions of qatools don't have those manifests...
        for p in self.commit_dir.iterdir():
          if not dryrun and p.name not in ['output', 'tuning']:
            remove(p)
        self.deleted = True
        return
      else:
        for manifest in manifest_dir.iterdir():
          print(f'...delete artifacts {manifest.name}')
          with manifest.open() as f:
            files = json.load(f)
          for file in files.keys():
            if ignore:
              if any([fnmatch.fnmatch(file, i) for i in ignore]):
                continue
            print(f'{self.commit_dir / file}')
            if not dryrun:
              try:
                (self.commit_dir / file).unlink()
              except:
                print(f"WARNING: Could not remove: {self.commit_dir / file}")
    self.deleted = True

  @staticmethod
  def get_or_create(session, hexsha, project_id):
    try:
      ci_commit =(session.query(CiCommit)
                         .filter(
                           CiCommit.project_id==project_id,
                           CiCommit.hexsha.startswith(hexsha),
                         )
                         .one())
    except MultipleResultsFound:
      print(f'!!!!!!!!!!!!! Multiple results for commit {hexsha} @{project_id}')
      ci_commit =(session.query(CiCommit)
                         .filter(
                           CiCommit.project_id==project_id,
                           CiCommit.hexsha.startswith(hexsha),
                         )
                         .first())
    except NoResultFound:
      try:
        from slamvizapp.models import Project
        project = Project.get_or_create(session=session, id=project_id)
        try:
          commit = project.repo.commit(hexsha)
        except Exception as e:
          error = f'[ERROR] Could not create a commit for {hexsha}. {e}'
          print(error)
          raise (ValueError, error)

        ci_commit = CiCommit(commit, project=project)
        session.add(ci_commit)
        session.commit()
      except ValueError:
        error = f'[ERROR] ValueError: could not create a commit for {hexsha}'
        print(error)
        raise (ValueError, error)
    if not ci_commit.data:
      ci_commit.data = {}
    return ci_commit

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
        committer_avatar_url = users_db[name.replace(' ', '')]['avatar_url']
      else:
        name_hash = md5(name.encode('utf8')).hexdigest()
        committer_avatar_url = f'http://gravatar.com/avatar/{name_hash}'
    out = {
        'id': self.hexsha,
        'type': self.commit_type,
        'branch': re.sub('origin/', '', self.branch),
        'parents': [p for p in self.parents] if self.parents else [],
        'message': self.message,
        'committer_name': self.committer_name,
        'committer_avatar_url': committer_avatar_url,
        'authored_datetime': self.authored_datetime.isoformat(),
        'authored_date': self.authored_date.isoformat(),
        'latest_output_datetime': self.latest_output_datetime.isoformat() if self.latest_output_datetime else None,
        'deleted': self.deleted,
        "data": self.data if with_outputs else None,
        'commit_dir_url': str(self.commit_dir_url),
        'repo_commit_dir_url': str(self.repo_commit_dir_url),
        'batches': {b.label: b.to_dict(with_outputs=with_outputs, with_aggregation=with_aggregation)
                    for b in self.batches
                    if (with_batches is None and '|iter' not in b.label) or (with_batches is not None and b.label in with_batches)},
    }
    if with_outputs:
      out["data"] = self.data
    return out




def latest_successful_commit(session, project_id, branch, batch_label=None, within_last=20):
  """
  Returns the latest commit on a given branch where we got outputs.
  Only the latest within_last commits are checked...
  """
  ci_commits = (session
                .query(CiCommit)
                .options(joinedload(CiCommit.batches))
                .filter(
                  CiCommit.project_id==project_id,
                  # we try to be accomodating with the usual remote branch name
                  or_(CiCommit.branch==branch, CiCommit.branch==f'origin/{branch}')
                )
                .order_by(CiCommit.authored_datetime.desc())
                .limit(within_last)
               )
  valid_outputs = lambda b: [o for o in b.outputs if not (o.is_failed or o.is_pending)]
  for ci_commit in ci_commits:
    if not batch_label:
      if any([valid_outputs(b) for b in ci_commit.batches]):
        return ci_commit        
    if batch_label:
      if valid_outputs(ci_commit.get_or_create_batch(batch_label)):
        return ci_commit


def parent_successful_commit(ci_commit, batch_label=None):
  """Returns a commit's latest successful parent."""
  # if we don't have a git repo,
  # we try to find the previous commit on the same "branch"...
  if not ci_commit.project.repo:
    try:
      query = CiCommit.query\
                      .filter(
                        CiCommit.authored_datetime < self.authored_datetime,
                        CiCommit.branch == self.branch,
                      )
      for ci_commit in query:
        if len(ci_commit.ci_batch.outputs) or (batch_label and len(ci_commit.get_or_create_batch(batch_label).outputs)):
          return ci_commit
    except:
      return None

  parent_ci_commit = None
  # we arbitrarly pick the first git parent
  parent_hexsha = ci_commit.gitcommit.parents[0]
  while True:
    try:
      parent_ci_commit = CiCommit.query\
                                 .filter(CiCommit.hexsha == parent_hexsha)\
                                 .order_by(CiCommit.authored_datetime.desc())\
                                 .one()
    except:
      return None
    if len(ci_commit.ci_batch.outputs) or (batch_label and len(ci_commit.get_or_create_batch(batch_label).outputs)):
      return parent_ci_commit
    parent_hexsha = parent_ci_commit.gitcommit.parents[0]




def remove(path):
  if not path.exists():
    raise ValueError(f"ERROR: {path} doesn't exist")
  if path.is_file():
    print(str(path))
    try:
      path.unlink()
    except:
      print(f"WARNING: Could not remove: {path}")
    return
  for p in path.iterdir():
    remove(p)
  print(str(path))
  try:
    p.unlink()
  except:
    print(f"WARNING: Could not remove: {p}")
