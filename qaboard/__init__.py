# need to be update setup.py as well
__version__ = '0.8.13'
from .check_for_updates import check_for_updates
check_for_updates()

from .config import on_windows, on_linux, on_lsf, on_vdi, is_ci, config
from .utils import merge
from .conventions import slugify
from .qa import qa
