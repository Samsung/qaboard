"""
Saves in a run's log.txt everything written to stdout and stderr, at the file descriptor level: what Python prints,
and also what subprocesses, C/C++ extensions or native libraries write to the terminal themselves.

Swapping `sys.stdout` (utils.RedirectStream) only sees what Python prints. Here we point the file descriptors 1 and 2
of the process to a pipe, which subprocesses inherit, and a thread copies what comes out of it both to where 1 and 2
pointed before and to the log file. Before, they could point to a terminal, the log file of a runner (log.lsf.txt with
LSF, log.dask.txt...), a pipe read by a celery worker...: we don't need to know, runners don't change.

- When 1 (or 2) was a terminal, we use a pseudo-terminal instead of a pipe: programs still see a terminal, so they
  keep their colors, progress bars and line buffering (C's stdio buffers whole blocks when writing to a pipe).
- When 1 and 2 were the same file (a terminal, or `2>&1` into a runner's log), they share one pipe:
  the order of stdout and stderr is kept, in the log and in the terminal.
- POSIX only. On Windows, subprocesses inherit the Win32 standard handles, not the C runtime's file descriptors.
"""
import os
import sys
import threading
from pathlib import Path
from typing import BinaryIO, Dict, List, Optional, Tuple


# How long we wait for the output still in the pipe when the block ends (a pipe holds 64kB at most). Background
# processes the run left running keep the pipe open: the thread keeps copying their output, until `qa` exits.
DRAIN_TIMEOUT = 1.0


def supported() -> bool:
  """Whether we can tee the file descriptors: on POSIX, when sys.stdout and sys.stderr write to them (not e.g. when test runners capture the output)."""
  if os.name != 'posix':
    return False
  try:
    if sys.stdout.fileno() != 1 or sys.stderr.fileno() != 2:
      return False
    os.fstat(1)
    os.fstat(2)
  except (AttributeError, OSError, ValueError): # io.UnsupportedOperation is both
    return False
  return True


def _same_file(fd1: int, fd2: int) -> bool:
  s1, s2 = os.fstat(fd1), os.fstat(fd2)
  return (s1.st_dev, s1.st_ino, s1.st_rdev) == (s2.st_dev, s2.st_ino, s2.st_rdev)


def _channel(original_fd: int) -> Tuple[int, int]:
  """Returns (read end, write end) of what replaces original_fd: a pseudo-terminal if it was a terminal, else a pipe."""
  if os.isatty(original_fd):
    try:
      import pty
      import fcntl
      import termios
      master, slave = pty.openpty()
      try:
        attrs = termios.tcgetattr(slave)
        attrs[1] &= ~termios.ONLCR # keep "\n" as is: the real terminal translates it, the log gets no "\r\n"
        termios.tcsetattr(slave, termios.TCSANOW, attrs)
        # the terminal's width and height, for progress bars and tables
        size = fcntl.ioctl(original_fd, termios.TIOCGWINSZ, b'\0' * 8)
        fcntl.ioctl(slave, termios.TIOCSWINSZ, size)
      except OSError:
        pass
      os.set_inheritable(master, False)
      return master, slave
    except (ImportError, OSError):
      pass
  return os.pipe()


def _write_all(fd: int, data: bytes):
  view = memoryview(data)
  while view:
    written = os.write(fd, view)
    view = view[written:]


class _Log:
  """The log file, shared by the threads: one handle and a lock, since O_APPEND writes may interleave (e.g. on NFS)."""
  def __init__(self, path: Path, users: int):
    self.lock = threading.Lock()
    self.users = users
    try:
      self.file: Optional[BinaryIO] = open(path, 'ab', buffering=0)
    except OSError: # e.g. full storage: users still see the output
      self.file = None

  def write(self, data: bytes):
    with self.lock:
      if self.file is None:
        return
      try:
        self.file.write(data)
      except (OSError, ValueError):
        self.file = None

  def release(self):
    with self.lock:
      self.users -= 1
      if self.users == 0 and self.file is not None:
        self.file.close()
        self.file = None


def _pump(read_fd: int, original_fd: Optional[int], log: _Log, whole_lines: bool):
  """
  Copies what comes out of read_fd to original_fd and the log, until every writer closed it. Owns and closes its file descriptors.
  `whole_lines`: when stdout and stderr have their own pipes, we write whole lines to the log (ending with \\n, or \\r for progress bars), else they could be mixed up.
  """
  pending = b''
  try:
    while True:
      try:
        data = os.read(read_fd, 65536)
      except InterruptedError:
        continue
      except OSError: # EIO: on linux, a pseudo-terminal nobody writes to anymore
        break
      if not data:
        break
      if original_fd is not None:
        try:
          _write_all(original_fd, data)
        except OSError: # e.g. `qa run | head` stopped reading: we still save the log
          os.close(original_fd)
          original_fd = None
      if whole_lines:
        data = pending + data
        end = max(data.rfind(b'\n'), data.rfind(b'\r')) + 1
        if end == 0 and len(data) < 65536:
          pending = data
          continue
        if end == 0:
          end = len(data)
        data, pending = data[:end], data[end:]
      log.write(data)
  finally:
    if pending:
      log.write(pending)
    log.release()
    for fd in (read_fd, original_fd):
      if fd is not None:
        try:
          os.close(fd)
        except OSError:
          pass


class FdTee:
  """Tees the file descriptors 1 and 2 to a log file, from start() to stop(). Used by utils.redirect_std_streams."""
  def __init__(self, log_path: Path):
    self.log_path = Path(log_path)
    self.saved: Dict[int, int] = {}
    self.threads: List[threading.Thread] = []
    self.line_buffering: Dict[str, bool] = {}

  def start(self):
    self._flush()
    try:
      self.saved = {fd: os.dup(fd) for fd in (1, 2)}
      groups = [(1, 2)] if _same_file(1, 2) else [(1,), (2,)]
      log = _Log(self.log_path, users=len(groups))
      for fds in groups:
        read_fd, write_fd = _channel(self.saved[fds[0]])
        try:
          # the thread gets its own copy: it may outlive the block, while we close self.saved
          original_fd = os.dup(self.saved[fds[0]])
        except OSError:
          os.close(read_fd)
          os.close(write_fd)
          raise
        try:
          thread = threading.Thread(target=_pump, args=(read_fd, original_fd, log, len(groups) > 1), name=f'qa-log-{fds[0]}', daemon=True)
          thread.start()
          self.threads.append(thread)
          for fd in fds:
            os.dup2(write_fd, fd) # inheritable: subprocesses write to it
        finally:
          os.close(write_fd) # else the thread would never see the end of the pipe
    except OSError:
      self.stop()
      raise
    # Like a terminal would, we flush what Python prints at each line, so that the log is live
    for name in ('stdout', 'stderr'):
      stream = getattr(sys, name)
      if getattr(stream, 'line_buffering', True) is False and hasattr(stream, 'reconfigure'):
        try:
          stream.reconfigure(line_buffering=True)
          self.line_buffering[name] = False
        except (ValueError, OSError):
          pass
    self._faulthandler_to(self.saved.get(2))

  def stop(self):
    self._flush()
    self._faulthandler_to(None)
    for fd, saved in self.saved.items():
      try:
        os.dup2(saved, fd)
      except OSError:
        pass
      os.close(saved)
    self.saved = {}
    for name, line_buffering in self.line_buffering.items():
      try:
        getattr(sys, name).reconfigure(line_buffering=line_buffering)
      except (AttributeError, ValueError, OSError):
        pass
    self.line_buffering = {}
    # Now only subprocesses still running can write to the pipes
    for thread in self.threads:
      thread.join(DRAIN_TIMEOUT)
    self.threads = []

  @staticmethod
  def _flush():
    for stream in (sys.stdout, sys.stderr):
      try:
        stream.flush()
      except (AttributeError, OSError, ValueError):
        pass

  @staticmethod
  def _faulthandler_to(fd: Optional[int]):
    """If enabled, faulthandler writes Python's tracebacks when the process crashes: no thread would copy them then, so they go straight where stderr did."""
    import faulthandler
    if not faulthandler.is_enabled():
      return
    try:
      faulthandler.enable(file=fd if fd is not None else sys.stderr)
    except (AttributeError, OSError, ValueError, RuntimeError):
      pass
