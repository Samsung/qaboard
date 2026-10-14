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
  """Call a function as a given user, assuming the current user can setuid/setgid (~root)"""
  tf = tempfile.NamedTemporaryFile(delete=False)
  Path(tf.name).chmod(0o777)
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
        assert user == pwnam.pw_name
        uid = pwnam.pw_uid
        gid = pwnam.pw_gid

      os.setegid(gid)
      os.seteuid(uid)
      print("as:", user)
      try:
        result = f(*args, **kwargs)
      except Exception as e:
        result = e
      pickle.dump(result, open(tf.name, 'wb'), pickle.HIGHEST_PROTOCOL)
    except Exception as e:
      print(f"ERROR in child process: {e}")
      pickle.dump(e, open(tf.name, 'wb'), pickle.HIGHEST_PROTOCOL)
      traceback.print_exc(file=sys.stdout)
    finally:
      os._exit(0)
  # parent - wait for the child to do its work and keep going as root
  pid, status = os.waitpid(pid, 0)
  if status != 0:
    print(f"ERROR: Child ({pid}) exited with {status}")
    os._exit(1)
  return_value = pickle.load(open(tf.name, 'rb'))
  if isinstance(return_value, Exception):
    raise return_value
  return return_value


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
