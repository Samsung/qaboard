"""
Describes a project
"""
import sys
import json
import yaml
import traceback
from pathlib import Path
from functools import lru_cache

from sqlalchemy.orm import relationship
from sqlalchemy import Column, ForeignKey
from sqlalchemy import String, DateTime, JSON
from sqlalchemy import cast, type_coerce
from sqlalchemy.orm.exc import NoResultFound
from sqlalchemy.orm.attributes import flag_modified

import qaboard

# "from X import Y" can cause circular import errors..
from backend.models import Base, CiCommit  
# import backend.models as models
from backend import repos
from ..git_utils import git_pull
from ..config import default_ci_directory

class Project(Base):
  __tablename__ = 'projects'
  id = Column(String(), primary_key=True)
  data = Column(JSON(), default={})
  latest_output_datetime = Column(DateTime())

  ci_commits = relationship("CiCommit", order_by=CiCommit.authored_datetime, back_populates="project")

  @property
  def database(self):
    try:
      return Path(self.data['qatools_config']['inputs']['database']['linux'])
    except:
      return Path('/net/f2/algo_archive/')

  @property
  def ci_directory(self):
    """
    The root CI directory where we save artifacts and outputs for this project.
    From there you can You should append the git repository's namespaced name (eg dvs/psp_swip) to get where results are saved.
    """
    try:
      return Path(self.data['qatools_config']['ci_root']['linux'])
    except:
      return default_ci_directory

  @property
  def id_git(self):
    """
    qatools can handle sub-projects. They share a git repo, but are based at different paths.
    The `id_git` is the name of the repository in gitlab.
    """
    return self.data.get('git', {}).get('path_with_namespace', self.id)

  @property
  def id_relative(self):
    """
    qatools can handle sub-projects. They share a git repo, but are based at different paths.
    The `id_relative` is where, relatie to the git repository's root.
    """
    # FIXME: this could really by computed when the project is updated, or cached...
    if self.id == self.id_git:
      return ''
    else:
      return self.id.replace(self.id_git, '')[1:]


  @property
  def repo(self):
    try:
      return repos[self.id_git]
    except:
      print(f"Could not get repo for <{self.id_git}>")
      pass
    return None



  @staticmethod
  def get_or_create(session, **kwargs):
    try:
      project = session.query(Project).filter_by(**kwargs).one()
    except NoResultFound:
      project = Project(**kwargs)
      # session.add(project)
      # session.commit()
    if not project.data:
      project.data = {}
    return project

  def __repr__(self):
    return f"<Project id='{self.id}' repo='{self.id_git}' subproject='{self.id_relative}'>"





def is_relative_to(path : Path, path_maybe_parent : Path) -> bool:
  try:
    relative_path = path.relative_to(path_maybe_parent)
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
  # TODO: refactor, call the logic in Commit.get_or_create
  branch = data['ref'][11:] # data['ref'] => 'refs/heads/feature/Imu_preintegration'
  commit_id = data['checkout_sha']
  if not commit_id:
    return

  # Update the root project - all subprojects depend on it
  root_project_id = data['project']['path_with_namespace'] # eg => dvs/psp_swip
  root_project = Project.get_or_create(session=db_session, id=root_project_id)
  update_project_data(root_project, data, db_session)

  try:
    repo = repos[root_project_id]
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
    except Exception as e:
      exc_type, exc_value, exc_traceback = sys.exc_info()
      info = ''.join(traceback.format_exception(exc_type, exc_value, exc_traceback))
      print(info, file=sys.stderr)
      return None


  # List all the files named "qaboard.yaml" in this commit
  repo_files = repo.git.ls_tree('--name-only', '-r', commit_id).splitlines()
  projects_config_paths = [Path(f) for f in repo_files if f.endswith('qaboard.yaml') or f.endswith('qatools.yaml') ]
  for subproject_config_path in projects_config_paths:
    project_id = str(root_project_id / subproject_config_path.parent)
    # Make sure the it exists in the database, with up-to-date metadata
    project = Project.get_or_create(session=db_session, id=project_id)
    update_project_data(project, data, db_session)
    try:
      ci_commit = CiCommit.get_or_create(
        session=db_session,
        hexsha=commit_id,
        project_id=project_id,
      )
    except Exception as e:
      exc_type, exc_value, exc_traceback = sys.exc_info()
      info = ''.join(traceback.format_exception(exc_type, exc_value, exc_traceback))
      print(info, file=sys.stderr)
      return f"404 ERROR: with commit id {commit_id} in project {project_id}: {info}", 404

    # To update the (sub)project configuration stored in the database,
    # we first need to read relevant qaboard.yaml files from this commit.
    config_paths = [p for p in projects_config_paths if is_relative_to(subproject_config_path.parent, p.parent)]
    config_paths.sort(key=lambda p: len(str(p)))

    qatools_config = {}
    for config_path in config_paths:
      config = parsed_content(commit_id, config_path)
      qatools_config = qaboard.merge(config, qatools_config)
    qatools_config['project']['name'] = project_id

    # We store qatools's configuration twice: at the project level and at the commit level
    # - Commit-level info is important to let users easily tweak the outputs and metrics
    #   they want to see when working on their branches 
    ci_commit.data.update({'qatools_config': qatools_config})
    # - Project-level information is used as a default or when showing in the UI list of commits
    #   It is only updated when there are changes on the "reference branch" (eg master, develop...)
    #   This said, we also update project-level data when it's the first time we get a qatools config for a project
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
        ci_commit.data.update({'qatools_metrics': metrics})
        flag_modified(ci_commit, "data")
        if is_initialization or is_reference:
          project.data.update({'qatools_metrics': metrics})
          flag_modified(project, "data")

    # print('project.data :', project.data)
    db_session.add(ci_commit)
    db_session.add(project)
    db_session.commit()
