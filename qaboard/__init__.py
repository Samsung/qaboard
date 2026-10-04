# The version is only defined in pyproject.toml
try:
  from importlib.metadata import version, PackageNotFoundError
except ImportError: # python 3.7
  from importlib_metadata import version, PackageNotFoundError # type: ignore
try:
  __version__ = version('qaboard')
except PackageNotFoundError: # e.g. used from a checkout via PYTHONPATH, without being installed
  __version__ = 'unknown'


from .check_for_updates import check_for_updates
check_for_updates()

from .config import on_windows, on_linux, is_ci, config
from .utils import merge
from .conventions import slugify
from .qa import qa

from .run import RunContext as Context