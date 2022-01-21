"""
A version of the code on which we ran SLAM performance test.
"""
import re
import json
import fnmatch
import subprocess
from hashlib import md5
from pathlib import Path

from requests.utils import quote
from sqlalchemy import Column, Boolean, Integer, String, DateTime, JSON, ForeignKey
from sqlalchemy import or_, UniqueConstraint, orm
from sqlalchemy.orm import relationship, reconstructor, joinedload
from sqlalchemy.orm.exc import NoResultFound, MultipleResultsFound
from sqlalchemy.orm.attributes import flag_modified

from qaboard.conventions import get_commit_dirs
from qaboard.api import dir_to_url

from backend.models import Base, Batch, Output
from ..utils import get_users_per_name
from ..fs_utils import rm_empty_parents, rmtree
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

  data = Column(JSON(), nullable=False, default=dict, server_default='{}')

  authored_datetime = Column(DateTime(timezone=True), index=True)
  committer_name = Column(String(), index=True)
  message = Column(String())
  # We use as branch the first branch that the commit was seen on, or the project's reference branch if it was used.
  # TODO: we should also store the tags we witnessed the commit used with.
  branch = Column(String(), index=True) # first added as.. we ignore tags?
  # In the end there having a commit's parents is not all that useful for QA-Board:
  # not all commits are used for runs: e.g. CI runs only on pushed commits, so
  # that info is not enough to reconstruct the commit graph.
  # Right now we don't display parents in the web application, so we also remove it from the API. 
  # Instead of  JSON, we could use an Array of String instead, so that we can search for descendents. But do we really need it? 
  parents = Column(JSON())

  commit_dir_override = Column(String())
  # Right now we don't really use this field, it's always "git".
  # The client uses "local" in case there is no git info, but
  # even then it doesn't send the information!
  commit_type = Column(String(), default='git')
  
  batches = relationship("Batch",
                         back_populates="ci_commit",
                         cascade="all, delete-orphan",
                         order_by=Batch.created_date,
                        )

  latest_output_datetime = Column(DateTime(timezone=True))
  deleted = Column(Boolean(), default=False)


  @orm.reconstructor
  def init_on_load(self):
    if not self.data:
      self.data = {}

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
  def artifacts_dir(self) -> Path:
    """Returns the folder in all the artifacts for this commit are stored."""
    if self.project.id_relative:
      return self.repo_artifacts_dir / self.project.id_relative
    else:
      return self.repo_artifacts_dir

  @property
  def repo_artifacts_dir(self) -> Path:
    if self.commit_dir_override:
      if self.project.id_relative:
        repo_artifacts_dir = re.sub(f'{self.project.id_relative}$', '', self.commit_dir_override)
        return Path(repo_artifacts_dir)
      else:
        return Path(self.commit_dir_override)
    return self.project.storage_roots['artifacts'] / get_commit_dirs(self)

  @property
  def artifacts_url(self) -> str:
    return dir_to_url(self.artifacts_dir)

  @property
  def repo_artifacts_url(self) -> str:
    return dir_to_url(self.repo_artifacts_dir)


  @property
  def repo_outputs_dir(self):
    return self.project.storage_roots['outputs'] / get_commit_dirs(self)

  @property
  def outputs_url(self) -> str:
    return dir_to_url(self.outputs_dir)

  @property
  def outputs_dir(self):
    # output dirs are now always saved, so we only call this to get output locations with usual conventions
    # e.g. when starting new tuning runs
    if self.project.id_relative:
      return self.repo_outputs_dir / self.project.id_relative
    else:
      return self.repo_outputs_dir


  def __repr__(self):
    branch = re.sub('origin/', '', self.branch) if self.branch else 'None'
    return f"<CiCommit project='{self.project.id}' hexsha='{self.hexsha[:8]}' branch='{branch}' batches={len(self.batches)}>"



  def __init__(self, hexsha, *, project, branch=None, message=None, parents=None, authored_datetime=None, committer_name=None, commit_type='git'):
    self.hexsha = hexsha
    self.project = project
    self.branch = branch
    self.message = message if message else '<NA>'
    self.parents = parents
    self.authored_datetime = authored_datetime
    self.committer_name = committer_name if committer_name else 'unknown'
    self.commit_type = commit_type
    self.latest_output_datetime = authored_datetime
    self.data = {}


  def save_artifacts(self):
    # Restores the artifacts that are defined in the source code 
    # It won't restore binaries, users are expected to redo their CI on their own
    import tempfile
    import git
    from ..git_utils import git_pull

    with tempfile.TemporaryDirectory() as tmp_dir:
      tmp_dir_path = Path(tmp_dir)
      # if it fails in dev, chmod -R 777 /var/qaboard/git/CDE-Users/HW_ALG/.git
      git_pull(self.project.repo)
      self.project.repo.git.worktree("add", tmp_dir_path, self.hexsha)
      # tmp_repo = git.Repo(tmp_dir_path)
      command = ['qa', 'save-artifacts', '--out', str(self.repo_artifacts_dir)]
      print(command)
      print(tmp_dir_path / self.project.id_relative)
      subprocess.run(command, cwd=tmp_dir_path / self.project.id_relative, check=True)

  def delete(self, ignore=None, keep=None, dryrun=False):
    """
    Delete the commit's artifacts, and mark it as delete.
    NOTE: We don't touch batches/outputs, you have to deal with them yourself.
          See hard_delete() in api/webhooks.py and clean.py
    """
    # print(self.artifacts_dir)
    manifest_dir = self.artifacts_dir / 'manifests'
    delete_errors = False
    nb_manifests = 0
    nb_deleted = 0
    if manifest_dir.exists():
      for manifest in manifest_dir.iterdir():
        nb_manifests += 1
        if keep and manifest in keep:
          continue
        print(f'  ...deleting artifacts: {manifest.name}')
        has_error = False 
        try:
          with manifest.open() as f:
            files = json.load(f)
        except:
          delete_errors = True
          continue
        for file in files.keys():
          if keep and file in keep:
            continue
          if ignore:
            if any([fnmatch.fnmatch(file, i) for i in ignore]):
              continue
          file_to_delete = self.repo_artifacts_dir / file
          print(str(file_to_delete))
          # raise ValueError
          if not dryrun:
            try:
              if file_to_delete.exists():
                rmtree(file_to_delete)
                rm_empty_parents(file_to_delete)
                nb_deleted += 1
            except:
              has_error = True
              print(f"WARNING: Could not remove: {file_to_delete}")
              # raise ValueError
        if not has_error:
          try: # FIXME: umask 0 when writing the manifest file!
            rmtree(manifest)
          except:
            pass
        delete_errors = delete_errors or has_error
    if not nb_manifests:
      print(f"[{self.authored_datetime}] No artifact manifests found. Deleting everything in {self.artifacts_dir}")
      nb_deleted = rmtree(self.artifacts_dir)
      rm_empty_parents(self.artifacts_dir)

    if not delete_errors and nb_deleted:
      self.deleted = True

  @staticmethod
  def get_or_create(session, hexsha, project_id, data=None):
    try:
      ci_commit =(session.query(CiCommit)
                         .filter(
                           CiCommit.project_id==project_id,
                           CiCommit.hexsha.startswith(hexsha),
                         )
                         .one())
    except NoResultFound:
     # FIXME: if we have a short-hash, we should fail
      try:
        from backend.models import Project
        project = Project.get_or_create(session=session, id=project_id)
        if data and data.get('qaboard_config'):
          is_initialization = not project.data or 'qatools_config' not in data 
          reference_branch = data["qaboard_config"]['project'].get('reference_branch', 'master')
          is_reference = data.get("commit_branch") == reference_branch
          if is_initialization or is_reference:
            # FIXME: We put in Project.data.git the content of
            #       https://docs.gitlab.com/ee/user/project/integrations/webhooks.html#push-events
            # FIXME: We should really have Project.data.gitlab/github/...
            if "git" not in project.data:
              project.data["git"] = {}
            if "path_with_namespace" not in project.data["git"] and "name" in data["qaboard_config"].get("project", {}): # FIXME: it really should be Project.root
              # FIXME: Doesn't support updates for now... again should have .id: int, name: str, root: str...
              project.data["git"]["path_with_namespace"] = data["qaboard_config"]["project"]["name"]
            project.data.update({'qatools_config': data['qaboard_config']})
            if "qaboard_metrics" in data:
              project.data.update({'qatools_metrics': data["qaboard_metrics"]})
            flag_modified(project, "data")
        else:
          # For backward-compatibility we fallback to reading the data from the commit itself
          # But in regular use QA-Board doesn't require read rights on repositories
          try:
            git_commit = project.repo.commit(hexsha)
          except Exception as e:
            error = f'[ERROR] Could not find information on commit {hexsha}. {e}'
            print(error)
            raise ValueError(error)

        ci_commit = CiCommit(
          hexsha,
          project=project,
          commit_type='git', # we don't use anything else
          parents=data["commit_parents"] if (data and "commit_parents" in data) else [c.hexsha for c in git_commit.parents],
          message=data["commit_message"] if (data and "commit_message" in data) else git_commit.message,
          committer_name=data["commit_committer_name"] if (data and "commit_committer_name" in data) else git_commit.committer.name,
          authored_datetime=data["commit_authored_datetime"] if (data and "commit_authored_datetime" in data) else git_commit.authored_datetime,
          # commits belong to many branches, so this is a guess
          branch=data["commit_branch"] if (data and "commit_branch" in data) else find_branch(hexsha, project.repo),
        )
        if data and data.get('project_root'):
          if not ci_commit.data:
            ci_commit.data = {}
          if not ci_commit.data.get('git'):
            ci_commit.data['git'] = {}
          ci_commit.data['git'].update({"path_with_namespace": data['project_root']})
          flag_modified(ci_commit, "data")

        if data:
          if 'qaboard_config' in data:
            ci_commit.data.update({'qatools_config': data['qaboard_config']})
          if "qaboard_metrics" in data:
            ci_commit.data.update({'qatools_metrics': data['qaboard_metrics']})
          flag_modified(ci_commit, "data")
        session.add(ci_commit)
        session.commit()
      except ValueError:
        error = f'[ERROR] ValueError: could not create a commit for {hexsha}'
        print(error)
        raise ValueError(error)
    if not ci_commit.data:
      ci_commit.data = {}
    return ci_commit

  def to_dict(self, with_aggregation=None, with_batches=None, with_outputs=False):
    users_db = get_users_per_name("")
    committer_avatar_url = ''
    if users_db and self.committer_name:
      name = self.committer_name.lower()
      user = None
      if name in users_db:
        user = users_db[name]
      elif name.replace('.', '') in users_db:
        user = users_db[name.replace('.', '')]
      elif name.replace(' ', '') in users_db:
        user = users_db[name.replace(' ', '')]
      elif name.replace(' ', '.') in users_db:
        user = users_db[name.replace(' ', '.')]
      if not user:
        name_hash = md5(name.encode('utf8')).hexdigest()
        committer_avatar_url = f'http://gravatar.com/avatar/{name_hash}'
      else:
        committer_avatar_url = user['avatar_url']
    out = {
        'id': self.hexsha,
        # 'type': self.commit_type,
        'branch': re.sub('origin/', '', self.branch),
        # Not used anywhere in the web application, and it's not all that useful (see earlier comment)
        # 'parents': [p for p in self.parents] if self.parents else [],
        'message': self.message,
        'committer_name': self.committer_name,
        'committer_avatar_url': committer_avatar_url,
        'authored_datetime': self.authored_datetime.isoformat(),
        'authored_date': self.authored_date.isoformat(),
        'latest_output_datetime': self.latest_output_datetime.isoformat() if self.latest_output_datetime else None,
        'deleted': self.deleted,
        "data": self.data,
        'outputs_url': dir_to_url(self.outputs_dir),
        'artifacts_url': self.artifacts_url,
        'repo_artifacts_url': self.repo_artifacts_url,
        'batches': {
          b.label: b.to_dict(with_outputs=with_outputs, with_aggregation=with_aggregation)
          for b in self.batches
          if not with_batches or b.label in with_batches
        },
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

