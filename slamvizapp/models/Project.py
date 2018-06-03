"""
Describes a project
"""
from sqlalchemy.orm import relationship
from sqlalchemy import Column, ForeignKey
from sqlalchemy import String, DateTime, JSON
from sqlalchemy import cast, type_coerce
from sqlalchemy.orm.exc import NoResultFound

from slamvizapp.models import Base, CiCommit


class Project(Base):
  __tablename__ = 'projects'
  id = Column(String(), primary_key=True)
  ci_commits = relationship("CiCommit", order_by=CiCommit.authored_datetime, back_populates="project")

  # How to get the code, things like whether its uses git or SVN?
  # The gitlab full namespaced path, or the SVN path
  # Various conventions
  information = Column(JSON())


  @staticmethod
  def get_or_create(session, **kwargs):
    try:
      project = session.query(Project).filter_by(**kwargs).one()
    except NoResultFound:
      project = Project(**kwargs)
      # session.add(project)
      # session.commit()
    return project
