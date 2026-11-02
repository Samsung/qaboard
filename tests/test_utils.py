"""
Tests for qaboard/utils.py
"""
import os
import sys
import types
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
    """On Windows, text files are compared with unix line endings, via a temporary file we must delete"""
    from qaboard import utils
    on_windows = types.SimpleNamespace(**{**vars(os), 'name': 'nt'})
    with tempfile.TemporaryDirectory() as tmp, tempfile.TemporaryDirectory() as tempdir:
      path = Path(tmp) / 'out.txt'
      path.write_bytes(b'a\r\nb\r\n')
      with mock.patch.object(utils, 'os', on_windows), mock.patch.object(tempfile, 'tempdir', tempdir):
        info = utils.file_info(path)
      self.assertEqual(info['md5'], hashlib.md5(b'a\nb\n').hexdigest())
      self.assertEqual(os.listdir(tempdir), [])


if __name__ == '__main__':
  unittest.main()
