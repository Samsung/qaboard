"""
QA-Board's Python package: the `qa` CLI, and what your code imports from it.

`import qaboard` has no side effects: names are imported on first access (PEP 562). Importing `qaboard.config`
reads the current directory's qaboard.yaml and git, so scripts that only use `qaboard.runs(url)` must not pay for
it, nor fail on an unrelated broken qaboard.yaml. The `qa` CLI checks for updates when it starts (qa.py's main).
"""
import sys
from importlib import import_module
from types import ModuleType
from typing import Any

# The version is only defined in pyproject.toml
def _version() -> str:
  # Imported from a checkout (tests, PYTHONPATH, an editable install): its pyproject.toml is the truth.
  # The installed metadata can be another qaboard's (e.g. the deployed CLI in CI) or stale (editable installs).
  import re
  from pathlib import Path
  pyproject = Path(__file__).resolve().parent.parent / 'pyproject.toml'
  try:
    text = pyproject.read_text(encoding='utf-8')
  except OSError:
    text = ''
  if re.search(r'^name = "qaboard"$', text, re.MULTILINE):
    match = re.search(r'^version = "([^"]+)"$', text, re.MULTILINE)
    if match:
      return match.group(1)
  from importlib.metadata import version, PackageNotFoundError
  try:
    return version('qaboard')
  except PackageNotFoundError:
    return 'unknown'
__version__ = _version()

# What qaboard logs (diagnostics, qaboard/log_setup.py) shows only where your logging configuration says, not on stderr
import logging as _logging
_logging.getLogger(__name__).addHandler(_logging.NullHandler())


# name: (module, attribute)
_LAZY = {
  # Results from Python (experimental): the runs a web app page shows
  'runs': ('.results', 'runs'),
  'Run': ('.results', 'Run'),
  'Runs': ('.results', 'Runs'),
  # Runs created from your code, without `qa run`: training loops, notebooks (experimental)
  'start_run': ('.active_run', 'start_run'),
  'current_run': ('.active_run', 'current_run'),
  'ActiveRun': ('.active_run', 'ActiveRun'),
  # what wrapped code imports
  'qa': ('.qa', 'qa'),
  'Context': ('.run', 'RunContext'),
  'Metric': ('.metrics', 'Metric'),
  # media that runs log at a step: run.log({"samples": [qaboard.Image(x)]}, step=step)
  **{name: ('.media', name) for name in ('Image', 'Audio', 'Video', 'Table', 'Histogram', 'Text', 'Html', 'Plotly', 'File')},
  'define_metric': ('.metrics', 'define_metric'),
  'config': ('.config', 'config'),
  'is_ci': ('.config', 'is_ci'),
  'on_windows': ('.config', 'on_windows'),
  'on_linux': ('.config', 'on_linux'),
  'merge': ('.utils', 'merge'),
  'slugify': ('.conventions', 'slugify'),
  'check_for_updates': ('.check_for_updates', 'check_for_updates'),
}
# submodules that `import qaboard` gives on first access, by their public name: `qaboard.collections.get(...)` and
# `from qaboard import collections`, `qaboard.inputs.add(...)`. The collections' module is input_collections.py: a qaboard/collections.py would shadow the
# standard library's `collections` for scripts run from the qaboard/ folder. Not in __all__: `from qaboard import *`
# must not replace `collections`.
_LAZY_MODULES = {'collections': '.input_collections', 'inputs': '.inputs'}
__all__ = ['__version__', *_LAZY]


def __getattr__(name: str) -> Any:
  # not cached: tests reload qaboard.config and qaboard.qa, and get their new objects
  if name in _LAZY:
    module, attribute = _LAZY[name]
    return getattr(import_module(module, __name__), attribute)
  if name in _LAZY_MODULES:
    return import_module(_LAZY_MODULES[name], __name__)
  raise AttributeError(f"module {__name__!r} has no attribute {name!r}")


def __dir__():
  return sorted({*globals(), *_LAZY, *_LAZY_MODULES})


class _Package(ModuleType):
  """
  `qaboard.qa`, `qaboard.config` and `qaboard.check_for_updates` are the click command, the configuration and the
  function, as they always were, not the submodules of the same name: importing a submodule sets it on its package,
  which would hide them from __getattr__. The submodules stay in sys.modules (`from qaboard.config import ...`).
  """
  def __setattr__(self, name: str, value: Any) -> None:
    if name in _LAZY and isinstance(value, ModuleType):
      return
    super().__setattr__(name, value)


sys.modules[__name__].__class__ = _Package
