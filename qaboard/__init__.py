# need to be update setup.py as well
__version__ = '1.0.3'


from .check_for_updates import check_for_updates
check_for_updates()

from .config import on_windows, on_linux, is_ci, config
from .utils import merge
from .conventions import slugify
from .qa import qa

from .run import RunContext as Context