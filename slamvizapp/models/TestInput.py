"""
Describes the recordings from the DVS:
- how we recorded: sensor, optics...
- what we recorded: motion, light...
"""
from pathlib import Path
import re
import enum

from sqlalchemy import Column, Integer, String, Boolean, Enum, JSON
from sqlalchemy import UniqueConstraint
from sqlalchemy.orm import relationship
from sqlalchemy.orm.exc import NoResultFound

from slamvizapp.models import Base



class TestInput(Base):
  __tablename__ = 'test_inputs'
  id = Column(Integer(), primary_key=True)

  # Relative to the root of the database folder
  path = Column(String(), index=True, nullable=False)
  database = Column(String(), index=True, nullable=False)
  __table_args__ = (UniqueConstraint('database', 'path', name='_database_path'),)

  outputs = relationship("Output", back_populates="test_input",
                              # If we delete a recording, the corresponding outputs are kept,
                              # and their recording_id is set to NULL.
                              # To change this behaviour, uncomment
                              # cascade="all, delete, delete-orphan"
  )

  @property
  def output_folder(self):
    """returns test path without any extension"""
    return Path(self.path).with_suffix('')

  @property
  def filename(self):
    """The path without .bin"""
    return self.path.split('/')[-1]

  # misc data
  data = Column(JSON(), default={})


  def __init__(self, database, path):
    self.path = str(path)
    self.database = str(database)

  def __repr__(self):
    return f"<Input id='{self.id}' path='{self.path}'/>"


  @staticmethod
  def get_or_create(session, database, path):
    try:
      test_input = (session
                    .query(TestInput)
                    .filter_by(database=str(database), path=str(path))
                    .one()
      )
    except NoResultFound:
      test_input = TestInput(database=str(database), path=str(path))
      # session.add(test_input)
      # session.commit()
    if not test_input.data:
      test_input.data = {}
    return test_input
