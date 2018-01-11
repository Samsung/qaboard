"""
Describes the parameters used to run the SLAM (params.json)
"""
import json
import hashlib

from sqlalchemy.orm import relationship
from sqlalchemy import Column, ForeignKey
from sqlalchemy import String, Integer #, JSON

from slamvizapp.models import Base


class ParametersSet(Base):
  """Represents the parameters used to run the SLAM (ie params.json)"""
  __tablename__ = 'parameters_sets'

  # we identify parameters by the md5 hash of their content
  id = Column(String(), primary_key=True)

  # ? Should we store all the data in text? fields? a path to the file?
  # ? We could store a diff vs default? ..and reference which params.json we started from?
  parameters = Column(String()) # JSON()?

  # ci_commits for which this set of parameters is the default
  default_for_ci_commits = relationship("CiCommit", back_populates="default_parameters_set")


  def __init__(self, parameters_file):
    """Constructor with a pathlib Path to the parameters."""
    with parameters_file.open() as f:
      parameters_text = f.read()
      self.id = hashlib.md5(parameters_text.encode()).hexdigest()
      self.parameters = parameters_text

  def __repr__(self):
    return f"<ParameterSet(id='{self.id}' n_parameters={len(self.default_parameters)}>"
