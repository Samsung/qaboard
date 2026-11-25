"""
Tests for qaboard/utils.py
"""
import os
import sys
import types
import errno
import hashlib
import tempfile
import unittest
from pathlib import Path
from unittest import mock


class TestRedirectStdStreams(unittest.TestCase):
  def test_restores_the_streams(self):
    """Without file descriptors to tee (Windows, or sys.stdout isn't the process's), we swap sys.stdout and sys.stderr"""
    from qaboard import fd_tee
    from qaboard.utils import redirect_std_streams
    with tempfile.TemporaryDirectory() as tmp:
      log = Path(tmp) / 'log.txt'
      stdout, stderr = sys.stdout, sys.stderr
      # e.g. set in the CI runner's environment: the redirection would be a no-op
      environ = {k: v for k, v in os.environ.items() if k != 'QA_NO_STREAM_REDIRECT'}
      with mock.patch.dict(os.environ, environ, clear=True), mock.patch.object(fd_tee, 'supported', return_value=False), \
           redirect_std_streams(log, color=False):
        print('in the log')
        self.assertIsNot(sys.stdout, stdout)
      # the previous streams, not sys.__stdout__: e.g. those of the test runner
      self.assertIs(sys.stdout, stdout)
      self.assertIs(sys.stderr, stderr)
      print('not in the log')
      self.assertEqual(log.read_text(), 'in the log\n')



# Runs in its own process, whose stdout and stderr are what the test gives it
TEE_SCRIPT = r"""
import os, sys, time, subprocess
from qaboard.utils import redirect_std_streams
with redirect_std_streams(sys.argv[1]):
  print('python stdout')
  print('python stderr', file=sys.stderr)
  os.write(1, b'fd 1\n')
  # a subprocess writes to the file descriptors it inherits, like executables or native code
  subprocess.run([sys.executable, '-c', 'import os, sys; os.write(1, b"child stdout\\n"); os.write(2, b"child stderr\\n"); print("child isatty", sys.stdout.isatty())'])
  if len(sys.argv) > 2:
    # left running in the background, it keeps the pipe open
    subprocess.Popen(['sleep', '30'])
  start = time.time()
# after the block, sys.stdout buffers whole blocks again when it isn't a terminal
print('not in the log', flush=True)
print('exited the block in', time.time() - start, file=sys.stderr)
"""


@unittest.skipIf(os.name != 'posix', 'we tee file descriptors on POSIX only')
class TestTeeFileDescriptors(unittest.TestCase):
  """redirect_std_streams saves in the log what subprocesses and native code write, not only what Python prints (qaboard/fd_tee.py)"""
  def run_script(self, tmp, stdout, stderr, *args):
    import subprocess
    root = Path(__file__).resolve().parent.parent
    env = {k: v for k, v in os.environ.items() if k != 'QA_NO_STREAM_REDIRECT'}
    env['PYTHONPATH'] = os.pathsep.join([str(root), env.get('PYTHONPATH', '')])
    log = Path(tmp) / 'log.txt'
    subprocess.run([sys.executable, '-c', TEE_SCRIPT, str(log), *args], stdout=stdout, stderr=stderr, env=env, timeout=30, check=True)
    return log.read_text()

  expected = 'python stdout\npython stderr\nfd 1\nchild stdout\nchild stderr\n'

  def test_same_file(self):
    """When stdout and stderr go to the same file (a runner's log, a terminal), the order is kept, in it and in the log"""
    with tempfile.TemporaryDirectory() as tmp:
      with open(Path(tmp) / 'out.txt', 'w') as out:
        log = self.run_script(tmp, out, out)
      self.assertEqual(log, self.expected + 'child isatty False\n')
      output = (Path(tmp) / 'out.txt').read_text()
      self.assertTrue(output.startswith(log + 'not in the log\n'), output)

  def test_separate_files(self):
    """stdout and stderr still go where they went"""
    with tempfile.TemporaryDirectory() as tmp:
      with open(Path(tmp) / 'out.txt', 'w') as out, open(Path(tmp) / 'err.txt', 'w') as err:
        log = self.run_script(tmp, out, err)
      self.assertEqual(sorted(log.splitlines()), sorted((self.expected + 'child isatty False').splitlines()))
      self.assertEqual((Path(tmp) / 'out.txt').read_text(), 'python stdout\nfd 1\nchild stdout\nchild isatty False\nnot in the log\n')
      self.assertTrue((Path(tmp) / 'err.txt').read_text().startswith('python stderr\nchild stderr\n'))

  def test_terminal(self):
    """In a terminal, programs still write to a terminal (colors, progress bars, line buffering), the log has no \\r\\n"""
    import pty
    master, slave = pty.openpty()
    try:
      with tempfile.TemporaryDirectory() as tmp:
        log = self.run_script(tmp, slave, slave)
        self.assertEqual(log, self.expected + 'child isatty True\n')
        os.close(slave)
        slave = None
        output = b''
        while True:
          try:
            data = os.read(master, 65536)
          except OSError:
            break
          if not data:
            break
          output += data
        self.assertIn(b'child isatty True', output)
    finally:
      os.close(master)
      if slave is not None:
        os.close(slave)

  def test_background_processes_dont_block(self):
    """A process the run leaves running keeps the pipe open: we don't wait for it"""
    import subprocess
    with tempfile.TemporaryDirectory() as tmp:
      err = Path(tmp) / 'err.txt'
      with open(Path(tmp) / 'out.txt', 'w') as out, err.open('w') as err_file:
        self.run_script(tmp, out, err_file, 'background')
      duration = float(err.read_text().split('exited the block in')[-1])
      self.assertLess(duration, 5)
      subprocess.run(['pkill', '-f', '^sleep 30$'])


class TestFileInfo(unittest.TestCase):
  def test_windows_line_endings(self):
    """Text files are hashed with unix line endings on every platform (normalization is always on), via a temporary file we must delete"""
    from qaboard import utils
    on_windows = types.SimpleNamespace(**{**vars(os), 'name': 'nt'})
    with tempfile.TemporaryDirectory() as tmp, tempfile.TemporaryDirectory() as tempdir:
      path = Path(tmp) / 'out.txt'
      path.write_bytes(b'a\r\nb\r\n')
      with mock.patch.object(utils, 'os', on_windows), mock.patch.object(tempfile, 'tempdir', tempdir):
        info = utils.file_info(path)
      self.assertEqual(info['md5'], hashlib.md5(b'a\nb\n').hexdigest())
      self.assertEqual(os.listdir(tempdir), [])


class TestEolNormalizedCopy(unittest.TestCase):
  def test_cleanup_on_write_failure(self):
    """When writing the temp copy fails (e.g. no space left), the helper leaves nothing behind in the temp directory"""
    import builtins
    from qaboard import utils
    real_open = builtins.open

    def open_with_failing_write(*args, **kwargs):
      f = real_open(*args, **kwargs)
      if len(args) >= 2 and args[1] == 'wb': # only the temp copy's write pass
        def no_space_left(*a, **k):
          raise OSError(28, 'No space left on device')
        f.write = no_space_left
      return f

    with tempfile.TemporaryDirectory() as tmp, tempfile.TemporaryDirectory() as tempdir:
      path = Path(tmp) / 'out.txt'
      path.write_bytes(b'a\r\nb\r\n')
      with mock.patch.object(tempfile, 'tempdir', tempdir), mock.patch('builtins.open', open_with_failing_write):
        with self.assertRaises(OSError) as ctx:
          utils.eol_normalized_copy(path)
      self.assertEqual(ctx.exception.errno, errno.ENOSPC)
      self.assertEqual(os.listdir(tempdir), [])

  def test_cleanup_on_close_failure(self):
    """When closing the temp copy fails after a successful write, the helper still leaves nothing behind"""
    import builtins
    from qaboard import utils
    real_open = builtins.open

    def open_with_failing_close(*args, **kwargs):
      f = real_open(*args, **kwargs)
      if len(args) >= 2 and args[1] == 'wb': # only the temp copy's writer
        def no_space_left(*a, **k):
          raise OSError(errno.ENOSPC, 'No space left on device')
        f.flush = no_space_left # close() flushes first, so this is the close/flush-failure path
      return f

    with tempfile.TemporaryDirectory() as tmp, tempfile.TemporaryDirectory() as tempdir:
      path = Path(tmp) / 'out.txt'
      path.write_bytes(b'a\r\nb\r\n')
      with mock.patch.object(tempfile, 'tempdir', tempdir), mock.patch('builtins.open', open_with_failing_close):
        with self.assertRaises(OSError) as ctx:
          utils.eol_normalized_copy(path)
      self.assertEqual(ctx.exception.errno, errno.ENOSPC)
      self.assertEqual(os.listdir(tempdir), [])


if __name__ == '__main__':
  unittest.main()
