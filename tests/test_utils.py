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
    from qaboard.utils import redirect_std_streams
    with tempfile.TemporaryDirectory() as tmp:
      log = Path(tmp) / 'log.txt'
      stdout, stderr = sys.stdout, sys.stderr
      # e.g. set in the CI runner's environment: the redirection would be a no-op
      environ = {k: v for k, v in os.environ.items() if k != 'QA_NO_STREAM_REDIRECT'}
      with mock.patch.dict(os.environ, environ, clear=True), redirect_std_streams(log, color=False):
        print('in the log')
        self.assertIsNot(sys.stdout, stdout)
      # the previous streams, not sys.__stdout__: e.g. those of the test runner
      self.assertIs(sys.stdout, stdout)
      self.assertIs(sys.stderr, stderr)
      print('not in the log')
      self.assertEqual(log.read_text(), 'in the log\n')


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
      if len(args) >= 2 and args[1] == 'w': # only the temp copy's write pass
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
      if len(args) >= 2 and args[1] == 'w': # only the temp copy's writer
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
