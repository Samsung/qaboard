"""
Describes the parameters used to run the SLAM (params.json)
"""
import json
import hashlib

from sqlalchemy import Column
from sqlalchemy import String, JSON

from slamvizapp.models import Base


class Parameters(Base):
  """Represents the parameters used to run the SLAM (ie params.json)"""
  __tablename__ = 'parameters_sets'

  # we identify parameters by the md5 hash of their content
  id = Column(String(), primary_key=True)
  parameters = Column(JSON())

  def to_dict(self):
    return self.parameters

  def __init__(self, parameters):
    """Constructor with a pathlib Path to the parameters.
    Expect this to fail with FileNotFoundError!
    """
    parameters_s = json.dumps(parameters, sort_keys=True)
    self.id = hashlib.md5(parameters_s).hexdigest()

  def __repr__(self):
    return f"<Parameter(id='{self.id}'>"
