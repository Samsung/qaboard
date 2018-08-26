"""
Describes a project
"""
from pathlib import Path

from sqlalchemy.orm import relationship
from sqlalchemy import Column, ForeignKey
from sqlalchemy import String, DateTime, JSON
from sqlalchemy import cast, type_coerce
from sqlalchemy.orm.exc import NoResultFound

from slamvizapp.models import Base, CiCommit
from ..config import ci_directory

class Project(Base):
  __tablename__ = 'projects'
  id = Column(String(), primary_key=True)
  ci_commits = relationship("CiCommit", order_by=CiCommit.authored_datetime, back_populates="project")

  # How to get the code, things like whether its uses git or SVN?
  # The gitlab full namespaced path, or the SVN path
  # Various conventions
  information = Column(JSON())


  # deprecated
  _legacy_database_directory = {
    'dvs/psp_swip': Path('/net/f2/algo_archive/DVS_SLAM_Database/'),
    'tof/swip_tof': Path('/net/f2/algo_archive/ToF_SW_Database/'),
  }

  @property
  def database(self):
    try:
      return Path(self.information['qatools_config']['inputs']['database']['linux'])
    except:
      try:
        return self._legacy_database_directory[self.id]
      except:
        return self._legacy_database_directory['dvs/psp_swip'] 


  @property
  def ci_directory(self):
    try:
      return Path(self.information['qatools_config']['inputs']['database']['linux'])
    except:
      return ci_directory
  

  @staticmethod
  def get_or_create(session, **kwargs):
    try:
      project = session.query(Project).filter_by(**kwargs).one()
    except NoResultFound:
      project = Project(**kwargs)
      # session.add(project)
      # session.commit()
    return project
