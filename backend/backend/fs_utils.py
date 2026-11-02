"""
Deal with filesystem common needs and issues

# delete a file with
# python backend/fs_utils.py 11611:10 ~/test.yaml
"""
import os
import pwd
import sys
import pickle
import tempfile
import traceback
import subprocess
from pathlib import Path




def rmtree(path: Path) -> int:
  nb_deleted = 0
  # We never follow symlinks: we delete the link, not what it points to
  if path.is_dir() and not path.is_symlink(): # delete the children first
    for p in path.iterdir():
      nb_deleted += rmtree(p)

  print("RM", path)
  try:
      if path.is_file() or path.is_symlink():
        path.unlink()
      else:
        path.rmdir()
      return 1
  except:
      # Already deleted?
      if not os.path.lexists(path):
          return 0

      # Permission issues?
      # we need to be able to delete files owned by any user
      # since we don't have access to the real NFS root, we need to su as the owner of each file
      stat = path.lstat()
      try:
          try: # the user running the server needs SETUID/SETGID capabilities
            as_user(f"{stat.st_uid}:{stat.st_gid}", rmtree, path)
            return 1
          except: # as a fallback, we can try to use sudo...
            command = ["sudo", "-tt", "python", __file__, f"{stat.st_uid}:{stat.st_gid}", str(path)]
            print(command)
            subprocess.run(command, check=True)
            return 1
      except Exception as e:
        message = f"ERROR {e}: Could not remove: {path}"
        print(message)
        raise Exception(message)




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


def as_user(user, f, *args, **kwargs):
  """
  Call a function as a given user, assuming the current user can setuid/setgid (~root).
  Returns what it returns, raises what it raises, or an Exception if the child process fails.
  """
  # the child sends its result in this file. It runs as the user: they must be able to write it
  fd, result_path = tempfile.mkstemp(prefix='qaboard-as-user-')
  os.close(fd)
  try:
    Path(result_path).chmod(0o666)
    pid = os.fork()
    if pid == 0:
      # child - do the work and exit
      try:
        if ":" in user:
          uid, gid = user.split(':')
          uid = int(uid)
          gid = int(gid)
        else:
          pwnam = pwd.getpwnam(user)
          if user != pwnam.pw_name:
            raise ValueError(f"Unknown user {user}")
          uid = pwnam.pw_uid
          gid = pwnam.pw_gid

        os.setegid(gid)
        os.seteuid(uid)
        print("as:", user)
        try:
          result = f(*args, **kwargs)
        except Exception as e:
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
