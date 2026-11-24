"""
Names whose module is imported when they are first called, to keep `qa --help` and shell completion fast:
qaboard.api imports requests, qaboard.runners their task queues' clients. They stay module attributes that tests can
patch (`mock.patch.object(qa, 'notify_qa_database')`). tests/test_startup.py checks what `import qaboard.qa` imports.
"""
import functools
from importlib import import_module
from typing import Any
from collections.abc import Callable


def lazy_function(module: str, name: str) -> Callable[..., Any]:
  """A function that imports `name` from `module` (e.g. ".api", relative to qaboard) when it is called."""
  def call(*args: Any, **kwargs: Any) -> Any:
    return getattr(import_module(module, __package__), name)(*args, **kwargs)
  call.__name__ = call.__qualname__ = name
  call.__doc__ = f"{module.lstrip('.')}.{name}, imported when called"
  return call


@functools.cache
def rich_traceback_installed() -> bool:
  """rich's tracebacks, as `qa` always showed them: installed when the first uncaught exception happens."""
  import click
  from rich.traceback import install
  install(show_locals=False, suppress=[click])
  return True


def install_rich_traceback_lazily() -> None:
  import sys
  if 'IPython' in sys.modules:
    # IPython doesn't use sys.excepthook: rich patches its shell
    rich_traceback_installed()
    return
  def excepthook(type_, value, traceback):
    rich_traceback_installed()
    # rich's, unless something set this hook again
    hook = sys.excepthook if sys.excepthook is not excepthook else sys.__excepthook__
    hook(type_, value, traceback)
  sys.excepthook = excepthook
