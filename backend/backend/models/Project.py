"""
Describes a project
"""
import os
import re
import sys
import json
import yaml
import traceback
from pathlib import Path
from functools import lru_cache

from sqlalchemy.orm import relationship
from sqlalchemy import Column
from sqlalchemy import String, DateTime
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy import or_, and_, literal, func
from sqlalchemy.orm.exc import NoResultFound
from sqlalchemy.orm.attributes import flag_modified

import qaboard
from qaboard.config import storage_roots

# "from X import Y" can cause circular import errors..
from backend.models import Base, CiCommit  
# import backend.models as models
from backend import repos
from ..git_utils import git_pull
from ..git_hosts.base import branch_from_ref
from ..config import default_outputs_root, default_artifacts_root

class Project(Base):
  __tablename__ = 'projects'
  id = Column(String(), primary_key=True)
  data = Column(JSONB(), nullable=False, default=dict, server_default='{}')
  latest_output_datetime = Column(DateTime())

  ci_commits = relationship("CiCommit", order_by=CiCommit.authored_datetime, back_populates="project")


  def storage_roots(self, default_qaboard_config=None, user_name=None):
    """
    The locations where we save outputs and artifacts for this project.
    `user_name` replaces {user} in the storage settings, by default the server's user.
    """
    qaboard_config = self.data.get('qatools_config', {})
    if not qaboard_config.get('storage'):
      qaboard_config = default_qaboard_config
    # We need it for every commit and batch we serialize, and only those keys matter
    storage_config = {k: qaboard_config[k] for k in ('storage', 'ci_root') if k in qaboard_config} if qaboard_config is not None else None
    args = (self.id, self.id_git, self.id_relative, json.dumps(storage_config, sort_keys=True), os.environ.get('QA_STORAGE'), user_name)
    # Scripts that set QABOARD_NO_CACHE_USER change the {user} of storage paths as they go (e.g. scripts/migrate.py)
    if 'QABOARD_NO_CACHE_USER' in os.environ:
      return dict(_storage_roots.__wrapped__(*args))
    return dict(_storage_roots(*args))

  @property
  def id_git(self) -> str:
    """
    QA-Board can handle sub-projects. They share a git repo, but are based at different paths.
    The `id_git` is the name of the repository.
    """
    gitlab_id_git = self.data.get('git', {}).get('path_with_namespace', None)
    if gitlab_id_git: # if the project is not linked to gitlab it will cause issues
      return gitlab_id_git
    else:
      # we assume 2 hierarchical layer max.... FIXME: it should saved as a fixed property of the project!
      try:
        match = re.search('([^/]+/[^/]+).*', self.id)
        return match.groups(0)[0]
      except:
        return self.id


  @property
  def id_relative(self) -> str:
    """
    QA-Board can handle sub-projects. They share a git repo, but are based at different paths.
    The `id_relative` is the project's directory, relative to the repository root.
    """
    # FIXME: this could really by computed when the project is updated, or cached...
    if self.id == self.id_git:
      return ''
    else:
      return self.id.replace(self.id_git, '')[1:]


  @property
  def repo(self):
    try:
      project_url = (self.data.get('qatools_config') or {}).get('project', {}).get('url')
      return repos.get(self.id_git, git=self.data.get('git'), project_url=project_url)
    except Exception as e:
      print(f"Could not get repo for <{self.id_git}>: {e}")
      pass
    return None



  @property
  def protected_refs(self):
    # git references that are explicitely protected from deletion in qaboard.yaml
    project_config = self.data.get("qatools_config", {}).get("project", {})
    reference_branch = project_config.get("reference_branch", "master")
    return [
        reference_branch,
        *project_config.get("milestones", []),
    ]

  @property
  def protected_ref_commits(self):
    """
    Commits qaboard.yaml protects: the latest on the reference branch, and its `project.milestones`
    (branches, tags or commits). The cleanup keeps all their results.
    """
    if not self.repo:
      return []
    def get_git_commit(repo, commit):
        try:
            return repo.commit(commit)
        except:
            return None
    # we will save the latest commit on the protected branches
    # FIXME: it requires git access for now, but we should query CiCommits.filter(CiCommits.branch==r)
    protected_commit_milestones = [self.repo.commit(r).hexsha for r in self.protected_refs if get_git_commit(self.repo, r)]

    protected_refs = self.protected_refs
    protected_refs = [*protected_refs, *[f'origin/{r}' for r in protected_refs]]

    # commits store as "branch" the first branch they were seen with. So they are never listed with tags.
    # we need to ask git for info on the milestones refs: what commit does it correspond to?
    # FIXME: we should store tags too somehow!
    repo_tags = {t.tag.tag for t in self.repo.tags if t.tag}
    protected_tags_commits = [self.repo.tags[m].commit.hexsha for m in protected_refs if m in repo_tags]
    return [*protected_commit_milestones, *protected_tags_commits]

  def milestones_on(self, hexsha=None):
    """The milestones of results from this project (they can be listed in another project), maybe only on a commit"""
    from .Milestone import Milestone
    query = Milestone.query.filter(or_(
      Milestone.commit_project_id == self.id,
      and_(Milestone.commit_project_id == None, Milestone.project_id == self.id),
    ))
    if hexsha:
      # milestones may use a short commit id
      # (not LIKE: "_" and "%" in a milestone's commit would be wildcards)
      query = query.filter(or_(
        Milestone.commit_hexsha == hexsha,
        and_(func.length(Milestone.commit_hexsha) >= 7, func.substr(literal(hexsha), 1, func.length(Milestone.commit_hexsha)) == Milestone.commit_hexsha),
      ))
    return query.all()

  @property
  def milestone_batches(self):
    """The batches that are milestones (a MilestoneBatches). Only their results are kept."""
    from ..milestones import MilestoneBatches
    return MilestoneBatches(self.milestones_on())

  @property
  def milestone_commits(self):
    """Commits with milestones or protected by qaboard.yaml. For cleanups that only know commits, not batches."""
    return [*self.protected_ref_commits, *self.milestone_batches.commits()]


  @staticmethod
  def get_or_create(session, **kwargs):
    try:
      project = session.query(Project).filter_by(**kwargs).one()
    except NoResultFound:
      # the id is a path in the storage, and in the grants: a/../b would be b's
      from ..access.policy import is_valid_project_id
      project_id = kwargs.get('id')
      if not is_valid_project_id(project_id, new=True):
        raise ValueError(f"Invalid project id: {project_id!r}, expected e.g. group/repo")
      project = Project(**kwargs)
    if not project.data:
      project.data = {}
    return project

  def __repr__(self):
    return f"<Project id='{self.id}' repo='{self.id_git}' subproject='{self.id_relative}'>"





@lru_cache(maxsize=1024)
def _storage_roots(project_id, id_git, id_relative, storage_config_json, qa_storage, user_name=None):
  # qa_storage: $QA_STORAGE overrides the storage config, it's part of the cache key
  try:
    outputs_root, artifacts_root, subproject_for_artifacts = storage_roots(json.loads(storage_config_json), Path(project_id), Path(id_relative), user_name=user_name)
  except Exception as e:
    print(e)
    outputs_root = default_outputs_root
    artifacts_root = default_artifacts_root
    subproject_for_artifacts = Path()
  # immutable, since we cache it
  return (
    ("outputs", outputs_root / id_git),
    ("artifacts", artifacts_root / id_git),
    ("subproject", subproject_for_artifacts),
  )


def is_relative_to(path : Path, path_maybe_parent : Path) -> bool:
  try:
    path.relative_to(path_maybe_parent)
    return True
  except:
    return False


def update_project_data(project, data, db_session):
  project.data.update({'git': data['project']})
  db_session.add(project)
  # https://stackoverflow.com/questions/30088089/sqlalchemy-json-typedecorator-not-saving-correctly-issues-with-session-commit
  flag_modified(project, "data")
  db_session.commit()




def update_project(data, db_session):
  """
  Called on push webhooks.
  data: {ref, checkout_sha, project}, see `GitHost.parse_push` in git_hosts/base.py
        data['project'] is the repository's data (see git_hosts/__init__.py), stored as Project.data['git']
  """
  # TODO: refactor, call the logic in Commit.get_or_create
  branch = branch_from_ref(data['ref']) # data['ref'] => 'refs/heads/feature/Imu_preintegration'
  commit_id = data['checkout_sha']
  if not commit_id:
    return

  # Update the root project - all subprojects depend on it
  root_project_id = data['project']['path_with_namespace'] # eg => dvs/psp_swip
  root_project = Project.get_or_create(session=db_session, id=root_project_id)
  update_project_data(root_project, data, db_session)

  try:
    repo = repos.get(root_project_id, git=data['project'])
    git_pull(repo)
  except:
    print(f"Could not fetch the git info for {root_project_id}")
    return

  @lru_cache(maxsize=128)
  def parsed_content(commit_id, path):
    """Read and parse a file in the git repository"""
    try:
      content = repo.git.show(f'{commit_id}:{path}')
      if not content:
        return None
      if str(path).endswith('yaml'):
          return yaml.load(content, Loader=yaml.SafeLoader)        
      elif str(path).endswith('json'):
        return json.loads(content)
      return yaml.load(content, Loader=yaml.SafeLoader)
    except Exception:
      exc_type, exc_value, exc_traceback = sys.exc_info()
      info = ''.join(traceback.format_exception(exc_type, exc_value, exc_traceback))
      print(info, file=sys.stderr)
      return None


  # List all the files named "qaboard.yaml" (or the legacy "qatools.yaml") in this commit
  repo_files = repo.git.ls_tree('--name-only', '-r', commit_id).splitlines()
  projects_config_paths = [Path(f) for f in repo_files if re.search(r'(/|^)qa(board|tools)\.yaml$', f)]
  for subproject_config_path in projects_config_paths:
    project_id = str(root_project_id / subproject_config_path.parent)
    # Make sure the it exists in the database, with up-to-date metadata
    project = Project.get_or_create(session=db_session, id=project_id)
    update_project_data(project, data, db_session)
    # we don't want to create commits ahead of time anymore
    # it started to cause issues with a huge monorepo with 100s of projects
    # and doesn't bring much value to users
    # try:
    #   ci_commit = CiCommit.get_or_create(
    #     session=db_session,
    #     hexsha=commit_id,
    #     project_id=project_id,
    #     data={"commit_branch": branch},
    #   )
    # except Exception as e:
    #   exc_type, exc_value, exc_traceback = sys.exc_info()
    #   info = ''.join(traceback.format_exception(exc_type, exc_value, exc_traceback))
    #   print(info, file=sys.stderr)
    #   return f"404 ERROR: with commit id {commit_id} in project {project_id}: {info}", 404

    # To update the (sub)project configuration stored in the database,
    # we first need to read relevant qaboard.yaml files from this commit.
    config_paths = [p for p in projects_config_paths if is_relative_to(subproject_config_path.parent, p.parent)]
    config_paths.sort(key=lambda p: len(str(p)))

    qatools_config = {}
    for config_path in config_paths:
      config = parsed_content(commit_id, config_path)
      if config is not None and not isinstance(config, dict):
        print(f"Ignoring {config_path} in {root_project_id}@{commit_id}: not a YAML mapping", file=sys.stderr)
        continue
      qatools_config = qaboard.merge(config, qatools_config)
    if "project" not in  qatools_config:
      qatools_config["project"] = {}
    qatools_config['project']['name'] = project_id

    # # We store the QA-Board configuration twice: at the project level and at the commit level
    # # - Commit-level info is important to let users easily tweak the outputs and metrics
    # #   they want to see when working on their branches 
    # ci_commit.data.update({'qatools_config': qatools_config})
    # - Project-level information is used as a default or when showing in the UI list of commits
    #   It is only updated when there are changes on the "reference branch" (eg master, develop...)
    #   This said, we also update project-level data when it's the first time we get a QA-Board config for a project
    is_initialization = 'qatools_config' not in project.data
    reference_branch = qatools_config['project'].get('reference_branch', 'master')
    is_reference = branch == reference_branch
    if is_initialization or is_reference:
      project.data.update({'qatools_config': qatools_config,})
      flag_modified(project, "data")

    metrics_path = qatools_config.get('outputs', {}).get('metrics')
    if metrics_path:
      metrics = parsed_content(commit_id, metrics_path)
      if metrics:
        # ci_commit.data.update({'qatools_metrics': metrics})
        # flag_modified(ci_commit, "data")
        if is_initialization or is_reference:
          project.data.update({'qatools_metrics': metrics})
          flag_modified(project, "data")

    # print('project.data :', project.data)
    # db_session.add(ci_commit)
    db_session.add(project)
    db_session.commit()
