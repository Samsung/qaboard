"""
Describes a project
"""
from pathlib import Path

from sqlalchemy.orm import relationship
from sqlalchemy import Column, ForeignKey
from sqlalchemy import String, DateTime, JSON
from sqlalchemy import cast, type_coerce
from sqlalchemy.orm.exc import NoResultFound

# "from X import Y" can cause circular import errors..
from slamvizapp.models import Base, CiCommit  
# import slamvizapp.models as models
from slamvizapp import repos
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
