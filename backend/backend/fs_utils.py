"""
Deal with filesystem common needs and issues

# delete a file with
# python backend/fs_utils.py 11611:10 ~/test.yaml
"""
import os
import sys
import stat
import errno
import pickle
import tempfile
import traceback
import subprocess
from pathlib import Path
from typing import List, Tuple




# Set in as_user's child processes: who we act as. They don't switch users again.
_acting_as = None


class DeleteError(PermissionError):
  """
  Nobody we can act as could delete a file. `filename` is that file, `owner` who can fix it: the owner of its folder.
  The message ends with "Could not remove: <path>" (jobs/report.py reads it).
  """
  def __init__(self, message, path, owner=None):
    super().__init__(errno.EACCES, message, str(path))
    self.message = message
    self.owner = owner

  def __str__(self):
    return self.message

  def __reduce__(self): # as_user's children pickle it
    return (type(self), (self.message, self.filename, self.owner))


def rmtree(path: Path, as_owners: bool = True) -> int:
  """
  Deletes a file or a folder, never following symlinks: we delete the link, not what it points to. Returns about how
  many entries it deleted (not what owners deleted before they failed).

  The server often can't delete users' files itself (e.g. on NFS with root_squash, root is "nobody"), so on permission
  errors it acts as their owners (as_user, it needs CAP_SETUID/CAP_SETGID). Who can do what:
  - listing a folder needs r+x on it, deleting an entry in it w+x: what users can't do in folders that aren't shared,
    e.g. 0700 folders from tempfile.mkdtemp, or the 0500 folders of some caches. We try as the entry's owner, then as
    its folder's: an owner can always chmod their folders, so they do (u+rwx).
  - in sticky folders (1777, like /tmp), only an entry's owner or the folder's can delete it.
  """
  path = Path(path)
  if _acting_as is not None: # we're already someone's process
    as_owners = False
  try:
    st = path.lstat()
  except FileNotFoundError:
    return 0
  except PermissionError: # we can't search its folder
    if as_owners:
      return _rmtree_as_owners(path)
    if not _make_ours(path.parent):
      raise
    st = path.lstat()

  nb_deleted = 0
  try:
    if stat.S_ISDIR(st.st_mode):
      try:
        children = list(path.iterdir())
      except PermissionError as e:
        if as_owners:
          raise
        if _make_ours(path):
          children = list(path.iterdir())
        else:
          # not ours: its owner may have emptied it already, then we can delete it if we can write in its folder
          try:
            _remove(path, st)
            return 1
          except OSError:
            raise e from None
      for child in children: # delete the children first
        nb_deleted += rmtree(child, as_owners)
    print("RM", path)
    try:
      _remove(path, st)
    except PermissionError:
      if as_owners or not _make_ours(path.parent):
        raise
      _remove(path, st)
    return nb_deleted + 1
  except FileNotFoundError: # someone else deleted it meanwhile
    return nb_deleted
  except DeleteError:
    raise
  except PermissionError:
    if not as_owners:
      raise
    return nb_deleted + _rmtree_as_owners(path)


def _remove(path: Path, st):
  if stat.S_ISDIR(st.st_mode):
    path.rmdir()
  else:
    path.unlink()


def _make_ours(folder: Path) -> bool:
  """In as_user's children: lets us list and change a folder we own, e.g. 0500. False if it's not ours, or already u+rwx"""
  try:
    st = folder.lstat()
    if st.st_uid != os.geteuid() or stat.S_IMODE(st.st_mode) & 0o700 == 0o700:
      return False
    folder.chmod(stat.S_IMODE(st.st_mode) | 0o700)
    return True
  except OSError:
    return False


def _rmtree_as_owners(path: Path) -> int:
  """
  rmtree as the users who may be able to delete `path`: its owner, then its folder's. What they can't delete deeper
  in it (e.g. someone else's 0700 folder), we delete as its own owners, then try again.
  """
  identities = []
  for p in (path, path.parent):
    try:
      identities.append(owner_ids(p))
    except OSError: # e.g. we can't search its folder: its owner knows
      pass
  identities = list(dict.fromkeys(identities))
  nb_deleted = 0
  errors = []
  helped = set()
  for _ in range(64):
    failed_deeper = []
    for identity in identities:
      try:
        nb_deleted += _as_user_or_sudo(identity, path)
      except Exception as e:
        errors.append((identity, e))
        filename = getattr(e, 'filename', None)
        if filename and path in Path(filename).parents and filename not in helped:
          failed_deeper.append(filename)
      if not os.path.lexists(path):
        return nb_deleted
    if not failed_deeper:
      break
    for filename in dict.fromkeys(failed_deeper):
      helped.add(filename)
      nb_deleted += rmtree(Path(filename)) # raises the DeleteError about it if nobody can
  raise _delete_error(path, errors)


def _as_user_or_sudo(identity: str, path: Path) -> int:
  try:
    return as_user(identity, rmtree, path, as_owners=False)
  except Exception as e:
    if getattr(e, 'raised_as', None) is not None:
      raise # we acted as them, they couldn't
    # we couldn't act as them: the server needs CAP_SETUID/CAP_SETGID, or else it can try sudo
    command = ["sudo", "-n", sys.executable, __file__, identity, str(path)]
    print(command)
    try:
      subprocess.run(command, check=True, capture_output=True, timeout=600)
    except Exception as sudo_error:
      raise Exception(f"{e} (and sudo: {sudo_error})") from e
    return 1


def _describe(path) -> str:
  try:
    st = os.lstat(path)
  except OSError as e:
    return f"{path} ({e.strerror})"
  return f"{path} ({stat.filemode(st.st_mode)} {_owner_name(st.st_uid)}:{st.st_gid})"


def _owner_name(uid) -> str:
  accounts = _accounts()
  return accounts.owner_name(uid) if accounts else f"uid {uid}"


def _delete_error(path: Path, errors) -> DeleteError:
  """What an admin needs to know: which file, its folder's permissions, who we tried as, and what failed"""
  # as the owners, the first file that failed is often deeper than `path`
  failed = Path(next((e.filename for _, e in errors if isinstance(e, OSError) and e.filename), path))
  # the folder that has it, unless the problem was listing the folder itself
  folder = failed if failed.is_dir() and failed != path else failed.parent
  try:
    owner_uid = os.lstat(folder).st_uid
    owner = _owner_name(owner_uid)
  except OSError:
    owner_uid, owner = None, None
  tried = "; ".join(f"as {_owner_name(i.split(':')[0])}: {_short(e)}" for i, e in errors) or "no owner to act as"
  if owner_uid == 0:
    hint = ("It's owned by root, often from a Docker container running as root: on NFS with root_squash, only an admin "
            "of the file server can delete it.")
  else:
    hint = (f"Its owner{f' ({owner})' if owner else ''} or an admin of the file server can delete it. If the permissions "
            f"look right, an ACL may refuse it, e.g. on files written from Windows (SMB): check with getfacl or nfs4_getfacl.")
  message = (
    f"Permission denied. Deleting a file needs write permission on its folder, listing a folder read permission: "
    f"{_describe(folder)}, {_describe(failed) if failed != folder else 'the folder itself'}. Tried {tried}. "
    f"{hint} Could not remove: {failed}"
  )
  print(f"ERROR {message}")
  return DeleteError(message, failed, owner=owner)


def _short(error) -> str:
  if isinstance(error, DeleteError):
    return "permission denied"
  if isinstance(error, OSError) and error.strerror:
    return f"{error.strerror}: {error.filename}" if error.filename else error.strerror
  return str(error).splitlines()[0][:300]




def rm_empty_parents(path: Path):
  from .storage import is_storage_path
  for parent in path.parents:
    # never go up to the storage roots, or outside of them
    if not is_storage_path(parent):
      break
    try:
      is_empty = not any(parent.iterdir())
    except FileNotFoundError:
      is_empty = True
    if is_empty:
      rmtree(parent)
    else:
      break


class UnknownAccountError(ValueError):
  pass


def _accounts():
  try:
    from . import accounts
  except ImportError: # we run as a script, with sudo (see rmtree)
    return None
  return accounts


def unix_identity(user) -> Tuple[int, int, List[int]]:
  """
  (uid, gid, groups) to act as `user`: an account name, or "uid:gid".
  Names and groups come from backend/accounts.py ($QABOARD_ACCOUNTS_COMMAND...): the server's own /etc/passwd
  often doesn't know the users, e.g. in containers, or with LDAP/SSSD.
  """
  accounts = _accounts()
  if ":" in str(user):
    uid, gid = (int(n) for n in str(user).split(':'))
    name = accounts.user_name(uid) if accounts else None
    account = accounts.account(name) if name else None
    # the file's group, e.g. for rmtree, and the groups of its owner if we know them
    groups = {gid, *(accounts.group_ids(name, account.gid) if account else ())}
    return uid, gid, sorted(groups)
  account = accounts.account(user) if accounts else None
  if not account:
    raise UnknownAccountError(
      f"QA-Board doesn't know the Unix account of {user}, it can't act as them. "
      "Admins: the accounts come from $QABOARD_ACCOUNTS_COMMAND, else the server's /etc/passwd"
    )
  return account.uid, account.gid, sorted(accounts.group_ids(account.name, account.gid))


def owner(path) -> str:
  """
  Who owns a file: their account's name, or "uid 2041" if unknown (backend/accounts.py).
  Unlike Path.owner(), it works when the server's /etc/passwd doesn't know the users.
  """
  from . import accounts
  return accounts.owner_name(os.lstat(path).st_uid)


def owner_ids(path) -> str:
  """"uid:gid" of a file, to act as its owner with as_user(), even if we don't know their name"""
  stat = os.lstat(path)
  return f"{stat.st_uid}:{stat.st_gid}"


def as_user(user, f, *args, **kwargs):
  """
  Call a function as a given user, assuming the current user can setuid/setgid (~root).
  Returns what it returns, raises what it raises, or an Exception if the child process fails.
  """
  # in the parent: the child's errors are less clear, and the accounts may refresh in a background thread
  uid, gid, groups = unix_identity(user)
  # the child sends its result in this file. It runs as the user: they must be able to write it
  fd, result_path = tempfile.mkstemp(prefix='qaboard-as-user-')
  os.close(fd)
  try:
    Path(result_path).chmod(0o666)
    pid = os.fork()
    if pid == 0:
      # child - do the work and exit
      try:
        # else the child keeps the server's groups, e.g. root's
        try:
          os.setgroups(groups)
        except PermissionError: # e.g. tests, as the same user without CAP_SETGID
          if uid != os.geteuid():
            raise
        os.setegid(gid)
        os.seteuid(uid)
        print("as:", user)
        global _acting_as
        _acting_as = user
        try:
          result = f(*args, **kwargs)
        except Exception as e:
          # the parent raises it again: without this, logs and Sentry only see where the parent raised it
          e.add_note(f"Raised in a child process, as {user}:\n{traceback.format_exc().rstrip()}")
          e.raised_as = user # we did act as them
          result = e
        with open(result_path, 'wb') as file:
          pickle.dump(result, file, pickle.HIGHEST_PROTOCOL)
      except Exception as e:
        print(f"ERROR in child process: {e}")
        traceback.print_exc(file=sys.stdout)
        try:
          with open(result_path, 'wb') as file:
            pickle.dump(e, file, pickle.HIGHEST_PROTOCOL)
        except Exception:
          pass
      finally:
        os._exit(0)
    # parent - wait for the child to do its work and keep going as root
    pid, status = os.waitpid(pid, 0)
    if status != 0:
      # we are a server worker in the middle of a request: we fail the request, not the worker
      raise Exception(f"Could not run {getattr(f, '__name__', f)} as {user}: the child process ({pid}) exited with {status}")
    try:
      with open(result_path, 'rb') as file:
        return_value = pickle.load(file)
    except Exception as e:
      raise Exception(f"Could not run {getattr(f, '__name__', f)} as {user}: no result ({e})")
  finally:
    try:
      os.unlink(result_path)
    except OSError:
      pass
  if isinstance(return_value, Exception):
    raise return_value
  return return_value


def mkdir_shared(path: Path, mode=0o777):
  """
  `mkdir -p` where the folders we create get `mode`, e.g. so that users' runs, under their own accounts, write in them.
  Unlike changing the umask, it doesn't change the permissions of what other threads create meanwhile.
  """
  path = Path(path)
  missing = []
  parent = path
  while not os.path.lexists(parent) and parent != parent.parent:
    missing.append(parent)
    parent = parent.parent
  path.mkdir(parents=True, exist_ok=True)
  for folder in reversed(missing):
    try:
      folder.chmod(mode)
    except OSError: # e.g. created by someone else meanwhile
      pass


def chmod_shared(path: Path, mode=0o666):
  """Gives a file we created `mode`. Files that others created keep theirs: only their owner (or root) can change it."""
  try:
    Path(path).chmod(mode)
  except OSError:
    pass


if __name__ == "__main__":
  if len(sys.argv) > 3 or len(sys.argv) == 1:
    raise ValueError("Usage: [uid:gid] path-to-delete")
  if len(sys.argv) == 2:
    path = Path(sys.argv[1])
    rmtree(path)
  else:
    uid_gid = sys.argv[1]
    path = Path(sys.argv[2])
    as_user(uid_gid, rmtree, path)


def measure(path: Path, seen_inodes: set = None) -> dict:
  """
  What's in a folder (or a file): {bytes, files, linked_bytes, owners: {uid: bytes}, newest_mtime}, without following
  symlinks. Files with several hard links count once per `seen_inodes` (pass the same set to measure several folders);
  `linked_bytes` is their share: deleting this folder doesn't free them while their other links exist.
  Unreadable folders are skipped: `errors` counts them.
  """
  totals = {"bytes": 0, "files": 0, "linked_bytes": 0, "owners": {}, "newest_mtime": 0, "errors": 0}
  seen = seen_inodes if seen_inodes is not None else set()
  def add(stat):
    if stat.st_nlink > 1:
      key = (stat.st_dev, stat.st_ino)
      if key in seen:
        return
      seen.add(key)
      totals["linked_bytes"] += stat.st_size
    totals["bytes"] += stat.st_size
    totals["files"] += 1
    totals["owners"][stat.st_uid] = totals["owners"].get(stat.st_uid, 0) + stat.st_size
    totals["newest_mtime"] = max(totals["newest_mtime"], stat.st_mtime)
  try:
    stat = os.lstat(path)
  except OSError:
    return totals
  import stat as stat_module
  if not stat_module.S_ISDIR(stat.st_mode):
    add(stat)
    return totals
  stack = [str(path)]
  while stack:
    folder = stack.pop()
    try:
      with os.scandir(folder) as entries:
        for entry in entries:
          try:
            if entry.is_dir(follow_symlinks=False):
              stack.append(entry.path)
            else:
              add(entry.stat(follow_symlinks=False))
          except OSError:
            totals["errors"] += 1
    except OSError:
      totals["errors"] += 1
  return totals
