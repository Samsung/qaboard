"""backend/fs_utils.py: running as other users, and folders users write in"""
import os
import stat
import tempfile

import pytest

from backend.fs_utils import as_user, mkdir_shared, chmod_shared


@pytest.fixture
def me():
  return f"{os.getuid()}:{os.getgid()}"


@pytest.fixture
def temp_dir(tmp_path, monkeypatch):
  """as_user's temporary files go there"""
  folder = tmp_path / 'tmp'
  folder.mkdir()
  monkeypatch.setattr(tempfile, 'tempdir', str(folder))
  return folder


def test_as_user_returns_and_raises(me, temp_dir):
  assert as_user(me, lambda a, b=0: a + b, 1, b=2) == 3
  def fails():
    raise ValueError("nope")
  with pytest.raises(ValueError, match="nope"):
    as_user(me, fails)
  # no temporary file left behind
  assert list(temp_dir.iterdir()) == []


def test_as_user_raises_when_the_child_dies(me, temp_dir):
  # it used to os._exit() the parent: a server worker in the middle of a request
  with pytest.raises(Exception, match="exited"):
    as_user(me, lambda: os._exit(3))
  assert list(temp_dir.iterdir()) == []


@pytest.fixture
def umask():
  previous = os.umask(0o022)
  yield 0o022
  os.umask(previous)


def mode(path):
  return stat.S_IMODE(path.stat().st_mode)


def test_mkdir_shared(tmp_path, umask):
  existing = tmp_path / 'existing'
  existing.mkdir()
  mkdir_shared(existing / 'a' / 'b')
  assert mode(existing / 'a') == mode(existing / 'a' / 'b') == 0o777
  # what was there keeps its permissions
  assert mode(existing) == 0o755
  # no process-wide change: other threads create files meanwhile
  assert os.umask(umask) == umask
  mkdir_shared(existing / 'a' / 'b')


def test_chmod_shared(tmp_path, umask):
  path = tmp_path / 'manifest.json'
  path.write_text('{}')
  chmod_shared(path)
  assert mode(path) == 0o666
  # e.g. files of other users: we can't, it's fine
  chmod_shared(tmp_path / 'missing.json')
