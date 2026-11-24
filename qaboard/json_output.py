"""
`--json` options: commands print one JSON document on stdout, for scripts and agents, and everything else on stderr.
The shapes are documented in website/docs/cli-json.md: add keys, don't rename or remove them.
"""
import os
import sys
import json
import contextlib
from typing import Any, Iterator, Optional, TextIO


@contextlib.contextmanager
def stdout_to_stderr() -> Iterator[None]:
  """
  What the command prints goes to stderr, also from the processes it starts (their stdout is our file descriptor 1).
  Print the JSON once it's done.
  """
  try:
    sys.stdout.flush()
  except Exception:
    pass
  saved_fd = None
  try:
    # e.g. click's CliRunner and pytest give file-like objects without a file descriptor: Python's redirection is enough
    if sys.__stdout__ is not None and sys.__stderr__ is not None:
      sys.__stdout__.flush()
      saved_fd = os.dup(1)
      os.dup2(sys.__stderr__.fileno(), 1)
  except (OSError, ValueError, AttributeError):
    saved_fd = None
  try:
    with contextlib.redirect_stdout(sys.stderr):
      yield
  finally:
    try:
      sys.stderr.flush()
    except Exception:
      pass
    if saved_fd is not None:
      os.dup2(saved_fd, 1)
      os.close(saved_fd)


def print_json(data: Any, stream: Optional[TextIO] = None) -> None:
  stream = stream or sys.stdout
  stream.write(json.dumps(data, indent=2, default=str) + "\n")
  stream.flush()
