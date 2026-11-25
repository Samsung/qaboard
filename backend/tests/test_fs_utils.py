"""backend/fs_utils.py: running as other users, and folders users write in"""
import os
import stat
import errno
import tempfile

import pytest

from backend.fs_utils import rmtree, as_user, mkdir_shared, chmod_shared, owner, owner_ids, unix_identity, UnknownAccountError


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


@pytest.fixture
def directory(tmp_path, monkeypatch):
  """Accounts the server's /etc/passwd doesn't know, e.g. from LDAP with $QABOARD_ACCOUNTS_COMMAND (backend/accounts.py)"""
  from backend import accounts
  folder = tmp_path / 'accounts'
  folder.mkdir()
  (folder / 'passwd').write_text(f"ldap-alice:x:{os.getuid()}:{os.getgid()}:Alice:/home/alice:/bin/bash\n")
  (folder / 'group').write_text(f"ldap-team:x:4242:ldap-alice\n")
  monkeypatch.setattr(accounts, "accounts_dir", folder)
  monkeypatch.setattr(accounts, "groups_command", "cat group") # its output is in the folder already
  monkeypatch.setattr(accounts, "accounts_command", "")
  monkeypatch.setattr(accounts, "_state", {"accounts": accounts.EMPTY, "mtimes": None, "checked": 0.0, "refreshing": False, "failed": None})
  return accounts


def test_as_user_knows_the_accounts_the_server_doesnt(directory, temp_dir):
  # pwd.getpwnam() used to fail: "getpwnam(): name not found"
  import pwd
  with pytest.raises(KeyError):
    pwd.getpwnam("ldap-alice")
  assert unix_identity("ldap-alice") == (os.getuid(), os.getgid(), sorted({os.getgid(), 4242}))
  assert as_user("ldap-alice", os.geteuid) == os.getuid()
  if os.geteuid() == 0:
    # the child has the user's groups, not the server's
    assert sorted(as_user("ldap-alice", os.getgroups)) == sorted({os.getgid(), 4242})
  # "uid:gid", e.g. to delete files: the file's group, and the groups of their owner
  assert unix_identity(f"{os.getuid()}:777") == (os.getuid(), 777, sorted({777, os.getgid(), 4242}))
  assert unix_identity("54321:777") == (54321, 777, [777])


def test_as_user_unknown_accounts(directory, temp_dir):
  with pytest.raises(UnknownAccountError, match="doesn't know the Unix account of nobody-we-know"):
    as_user("nobody-we-know", lambda: None)
  assert list(temp_dir.iterdir()) == []


def test_owner(directory, tmp_path):
  path = tmp_path / 'file.txt'
  path.write_text('')
  assert owner(path) == "ldap-alice"
  assert owner_ids(path) == f"{os.getuid()}:{os.getgid()}"
  if os.geteuid() == 0:
    os.chown(path, 54321, 777)
    assert owner(path) == "uid 54321" # Path.owner() raises KeyError
    assert owner_ids(path) == "54321:777"


def test_as_user_keeps_the_childs_traceback(me, temp_dir):
  """Logs and Sentry see where the child failed, not only where the parent raised it again"""
  def fails_in_the_child():
    raise ValueError("in the child")
  with pytest.raises(ValueError, match="in the child") as e:
    as_user(me, fails_in_the_child)
  notes = '\n'.join(getattr(e.value, '__notes__', []))
  assert f'Raised in a child process, as {me}' in notes and 'in fails_in_the_child' in notes
  # what the OS complained about: exports tell the runs' files from the exported ones
  with pytest.raises(FileNotFoundError) as e:
    as_user(me, open, '/missing/file')
  assert e.value.filename == '/missing/file'


# rmtree: the server can't delete users' files itself (NFS with root_squash), it acts as their owners

def test_rmtree_folders_we_cant_write_in(tmp_path, temp_dir):
  # e.g. read-only caches: as their owner, we give ourselves u+rwx
  run = tmp_path / 'run'
  (run / 'cache' / 'x').mkdir(parents=True)
  (run / 'cache' / 'x' / 'f').write_text('')
  (run / 'cache' / 'x').chmod(0o500)
  (run / 'cache').chmod(0o500)
  assert rmtree(run) == 4
  assert not run.exists()


def test_rmtree_folders_we_cant_list(tmp_path, temp_dir):
  # e.g. 0700 folders from tempfile.mkdtemp, here not even for us: it used to fail without trying as the owner
  run = tmp_path / 'run'
  (run / 'sub').mkdir(parents=True)
  (run / 'sub' / 'f').write_text('')
  (run / 'sub').chmod(0)
  rmtree(run)
  assert not run.exists()


def test_rmtree_says_who_could_delete_it(tmp_path, temp_dir, monkeypatch):
  from backend import fs_utils
  from backend.jobs.report import error_kind, failed_path
  run = tmp_path / 'run'
  (run / 'sub').mkdir(parents=True)
  (run / 'sub' / 'f').write_text('')
  def remove(path, st):
    raise PermissionError(errno.EACCES, 'Permission denied', str(path))
  monkeypatch.setattr(fs_utils, '_remove', remove)
  def as_user(identity, f, path, as_owners):
    e = PermissionError(errno.EACCES, 'Permission denied', str(run / 'sub' / 'f'))
    e.raised_as = identity
    raise e
  monkeypatch.setattr(fs_utils, 'as_user', as_user)
  monkeypatch.setattr(fs_utils, '_owner_name', lambda uid: f"user{uid}")
  with pytest.raises(fs_utils.DeleteError) as error:
    rmtree(run)
  message = str(error.value)
  assert f"{run / 'sub'} (drwx" in message and f"Tried as user{os.getuid()}: Permission denied: {run / 'sub' / 'f'}" in message
  # what jobs report: the file, and who can fix it, the owner of its folder
  assert failed_path(error.value) == str(run / 'sub' / 'f') and error_kind(error.value) == 'permission'
  assert error.value.owner == f"user{os.getuid()}"


def test_rmtree_as_owner_does_not_switch_again(tmp_path, temp_dir, monkeypatch, me):
  # as the owner, rmtree used to call as_user again, recursively, and try sudo at every level
  from backend import fs_utils
  def remove(path, st):
    raise PermissionError(errno.EACCES, 'Permission denied', str(path))
  monkeypatch.setattr(fs_utils, '_remove', remove)
  (tmp_path / 'f').write_text('')
  calls = []
  real_as_user = fs_utils.as_user
  monkeypatch.setattr(fs_utils, 'as_user', lambda *args, **kwargs: calls.append(args) or real_as_user(*args, **kwargs))
  monkeypatch.setattr(fs_utils.subprocess, 'run', lambda *args, **kwargs: pytest.fail("no sudo when we could act as them"))
  with pytest.raises(fs_utils.DeleteError):
    rmtree(tmp_path / 'f')
  # once as the file's owner, once as its folder's, if they differ
  assert len(calls) == len({owner_ids(tmp_path / 'f'), owner_ids(tmp_path)})


def test_deletes_from_the_command_line(tmp_path):
  """`python backend/fs_utils.py [uid:gid] path` deletes a folder"""
  import subprocess
  import sys
  from pathlib import Path
  import backend.fs_utils
  folder = tmp_path / 'to-delete'
  (folder / 'sub').mkdir(parents=True)
  (folder / 'sub' / 'file.txt').write_text('x')
  subprocess.run([sys.executable, str(Path(backend.fs_utils.__file__)), str(folder)], check=True, timeout=60)
  assert not folder.exists()
