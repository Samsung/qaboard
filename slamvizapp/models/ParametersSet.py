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

  # ci_commits for which this set of parameters is the default
  # as long as there is one, it will be easy to read the actual params.json
  ci_commits_for_which_default = relationship("CiCommit", back_populates="default_parameters_set")

  # heck, if we remove the commit it will be painful
  # path = Column(String(), unique=True)

  # ? Should we store all the data in text? fields? a path to the file?
  # ? We could store a diff vs default?
  # parameters = Column(String()) # JSON()?

  # maybe useful at some point if we start having multiple configuration files?
  # configuration = Column(String())


  slam_outputs = relationship("SlamOutput", back_populates="parameters_set")


  def to_dict(self):
    if not self.ci_commits_for_which_default:
      return {}
    parameters_file = self.ci_commits_for_which_default[0].commit_dir/"params.json"
    with parameters_file.open() as f:
      return json.load(f)

  def __init__(self, parameters_file):
    """Constructor with a pathlib Path to the parameters.
    Expect this to fail with FileNotFoundError!
    """
    self.path = str(parameters_file)
    with parameters_file.open() as f:
      parameters_text = f.read()
      self.id = hashlib.md5(parameters_text.encode()).hexdigest()
      # self.parameters = parameters_text

  def __repr__(self):
    # n_parameters={len(self.default_parameters)}
    return f"<ParameterSet(id='{self.id}'>"
