from sqlalchemy.ext.declarative import declarative_base
Base = declarative_base() # prints (no name)

from .Recording import *
from .ParametersSet import *
from .SlamOutput import *
from .CiCommit import *
