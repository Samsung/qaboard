"""
Describes the recordings from the DVS:
- how we recorded: sensor, optics...
- what we recorded: motion, light...
"""
import re
import enum

from sqlalchemy.orm import relationship
from sqlalchemy import Column, Integer, String, Boolean, Enum
from sqlalchemy.orm.exc import NoResultFound

from slamvizapp.models import Base


class Axis(enum.Enum):
  mixed = 0
  x = 1
  y = 2
  z = 3


class Recording(Base):
  __tablename__ = 'recordings'
  id = Column(Integer(), primary_key=True)

  # Relative to the root of the database folder
  path = Column(String(), index=True, unique=True)

  slam_outputs = relationship("SlamOutput", back_populates="recording",
                              # If we delete a recording, the corresponding outputs are kept,
                              # and their recording_id is set to NULL.
                              # To change this behaviour, uncomment
                              # cascade="all, delete, delete-orphan"
  )


  @property
  def output_folder(self):
    """The path without .bin"""
    return self.path[:-4]

  @property
  def filename(self):
    """The path without .bin"""
    return self.path.split('/')[-1]



  ### HOW we recorded #########
   # we could store the sensorID...
  # sensor_generation(Integer(), default=3)
  stereo_baseline = Column(Integer(), default=None) # cm
  is_wide_angle = Column(Boolean(), default=True)
  # has_imu(Boolean(), default=True)
  # has_ground_truth(Boolean())
  # the calibration will be found in the parent directories

  ### WHAT we recorded ########
  duration = Column(Integer(), default=None) # seconds?

  # what the camera sees
  is_dynamic = Column(Boolean(), default=False)
  is_static = Column(Boolean(), default=False)
  # scene_name = Column(String(), default=None) # desk, checkerboard...
  is_calibration = Column(Boolean(), default=False)

  is_low_light = Column(Boolean(), default=False)
  is_flickering = Column(Boolean(), default=False)
  # illumination = Column(Integer()) # lux?
  is_hdr = Column(Boolean(), default=False)
  # is_hdr = Column(Integer()) # log-constrast?
  # light_type = Column(String()) # outdoor, neon, light temperature...

  # how the camera moves
  motion_is_translation = Column(Boolean(), default=False)
  motion_is_rotation = Column(Boolean(), default=False)
  motion_axis = Column(Enum(Axis), default=Axis.mixed)
  # motion_axis = Column(Integer(), default=Axis.mixed)
  motion_speed = Column(Integer(), default=None) # of the camera, for the robot in deg/s?



  def __init__(self, path):
    self.path = path

    self.is_wide_angle = True if re.match(r"[wW]ide", path) else False

    if 'Tx' in path or 'Ty' in path or 'Tz' in path:
      self.motion_is_translation = True
    if 'Rx' in path or 'Ry' in path or 'Rz' in path:
      self.motion_is_rotation = True

    # we don't handle multiple axis of motion....
    if 'Tx' in path or 'Rx' in path:
      self.motion_axis = Axis.x
    if 'Ty' in path or 'Ry' in path:
      self.motion_axis = Axis.y
    if 'Tz' in path or 'Rz' in path:
      self.motion_axis = Axis.z

    if 'slow' in path:
      self.motion_speed = 30
    if 'med' in path:
      self.motion_speed = 60
    if 'fast' in path:
      self.motion_speed = 90

    m = re.match(r"(?P<speed>\d+)", path)
    if m: self.speed = m.group('speed')

    m = re.match(r"(?P<stereo_baseline>\d+)cm", path)
    if m: self.stereo_baseline = m.group('stereo_baseline')

    self.is_calibration = True if '[cC]alibration' in path else False
    self.is_low_light = True if 'LL' in path else False
    self.is_hdr = True if 'HDR' in path else False
    self.is_dynamic = True if '[dD]ynamic' in path else False
    self.is_static = True if '[sS]tatic' in path else False
    self.is_flickering = True if '[fF]licker' in path else False


  def __repr__(self):
    return f"<Recording(id='{self.id}' path='{self.path}' speed={self.motion_speed}>"


  @staticmethod
  def get_or_create(session, **kwargs):
    try:
      recording = session.query(Recording).filter_by(**kwargs).one()
    except NoResultFound:
      recording = Recording(**kwargs)
      session.add(recording)
      session.commit()
    return recording
