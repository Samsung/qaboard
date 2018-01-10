"""
Describes an output from a SLAM run:
1. How we ran the SLAM
- what version of the code was used
- on what platform we ran
- what parameters were used
2. What results we got
- quality metrics: drift, RMSE, AAPE...
- what assets are available (debug movies...)
"""
import enum

from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy import Column, Integer, String, Boolean, Enum, Float, JSON
Base = declarative_base()

class Platform(enum.Enum):
	# The CI currently runs a serial
	lsf_serial = 1
	s8 = 2
	s8 = 2





class SlamOutputs(Base):
  __tablename__ = 'slam_outputs'
  id = Column(Integer, primary_key=True)

 	recordings_id = Column(Integer, ForeignKey('recordings.id'))
	recording = relationship("Recording", back_populates="slam_outputs")

  commit_id = Column(Integer, ForeignKey('commits.id'))
	commit = relationship("Commit", back_populates="slam_outputs")

  tuning_set_id = Column(Integer, ForeignKey('parameters_sets.id'))


	platform = Column(Enum(Platform))
	computation_time  = Column(Float) # 1x = realtime

	metrics(json)


class CiCommit(Base)
	"""Refers to a git commit of the code.
	We keep some useful data in the database, but for the rest it used gitpython.
	"""
  __tablename__ = 'commits'
  id = Column(String, primary_key=True) # git commit id
 	default_parameters_set_id = Column(Integer, ForeignKey('parameters_sets.id'))

  # we could do something like
  # metrics = Column(JSON)
  # but we want stuff like sorting etc..
  # and we know the metrics in advance

 	def __init__(commit):
 		"""commit is a gitpython commit"""
 		# get the Commit object from gitpython
 		# populate fields: author, authored_date ...

 		# find the ouputs
 		# return [p.relative_to(directory) for p in directory.glob('**/*.bin')]



import json
import hashlib

class ParametersSet(Base)
	"""Represents the parameters used to run the SLAM (ie params.json)"""
  __tablename__ = 'parameters_sets'

  # we identify parameters by the md5 hash of their content
  id = Column(String, primary_key=True)

  # ? Should we store all the data in text? fields? a path to the file?
  # ? We could store a diff vs default? ..and reference which params.json we started from?
  parameters = Column(JSON)

  def __init__(parameters_file):
  	with parameters_file.open() as f:
  		self.id = hashlib.md5(f.read()).hexdigest()
  	with parameters_file.open() as f:
  		self.parameters = json.load(f)
