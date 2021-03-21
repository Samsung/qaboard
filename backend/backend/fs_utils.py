"""
Deal with filesystem common needs and issues

# delete a file with
# python backend/fs_utils.py 11611:10 ~/test.yaml
"""
import os
import pwd
import sys
import pickle
import shutil
import tempfile
import traceback
import subprocess
from pathlib import Path




def rmtree(path: Path) -> int:
  nb_deleted = 0
  if path.is_dir(): # delete the children first
    for p in path.iterdir():
      nb_deleted += rmtree(p)

  print("RM", path)
  try:
      if path.is_file():
        path.unlink()
      else:
        path.rmdir()
      return 1
  except:
      # Already deleted?
      if not path.exists():
          return 0

      # Permission issues?
      # we need to be able to delete files owned by any user
      # since we don't have access to the real NFS root, we need to su as the owner of each file
      stat = path.stat()
      try:
          # the user running the server needs SETUID/SETGID capabilities
          as_user(f"{stat.st_uid}:{stat.st_gid}", rmtree, path)
          return 1
          # we could also make use of sudo
          # command = ["sudo", "python", __file__, f"{stat.st_uid}:{stat.st_gid}", str(path)]
          # print(command)
          # subprocess.run(command, check=True)
      except Exception as e:
        message = f"ERROR {e}: Could not remove: {path}"
        print(message)
        raise Exception(message)




def rm_empty_parents(path: Path):
  for parent in path.parents:
    is_empty = not any(parent.iterdir())
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
    if ":" in user:
      uid, gid = user.split(':')
      uid = int(uid)
      gid = int(gid)
    else:
      pwnam = pwd.getpwnam(user)
      assert user == pwnam.pw_name
      uid = pwnam.pw_uid
      gid = pwnam.pw_gid

    # child - do the work and exit
    try:
        os.setegid(gid)
        os.seteuid(uid)
        # print(user, os.geteuid(), os.getegid())
        print("as:", user)
        # print("f:", f)
        # print("args:", args)
        # print("kargs:", kwargs)
        try:
          result = f(*args, **kwargs)
        except Exception as e:
          result = e
        # print("result:", result)
        pickle.dump(result, open(tf.name, 'wb'), pickle.HIGHEST_PROTOCOL)
        # print("from child:", tf.name, Path(tf.name).read_bytes())
    except Exception as e:
      print(f"ERROR in child process: {e}")
      traceback.print_exc(file=sys.stdout)
    finally:
        os._exit(0)
  # parent - wait for the child to do its work and keep going as root
  pid, status = os.waitpid(pid, 0)
  # print(pid, status)
  if status != 0:
    print(f"ERROR: Child ({pid}) exited with {status}")
    os._exit(1)
  # print("from parent", tf.name)
  # print(Path(tf.name).read_bytes())
  # print(pickle.load(open(tf.name, 'rb')))
  return_value = pickle.load(open(tf.name, 'rb'))
  if isinstance(return_value, Exception):
    raise return_value
  return return_value


# Before using setuid to delete files as their user, we would try more complicated things...
# This assumes all users are mapped in /etc/passwd, but it's annoying to maintain!
# from pwd import getpwnam
# def open_permissions(path):
#     owner = path.owner()
#     # FIXME: wrap the whole ssh arg with ''
#     if owner == 'sircdevops':
#         subprocess.run(f'ssh sircdevops@sircdevops-vdi chmod -R 777 "{path}"', shell=True, check=True)
#     else:
#         pwname = getpwnam(owner)
#         owner = f"{pwname.pw_uid}:{pwname.pw_uid}" # TODO: need passwd up to date..
#         subprocess.run(f'ssh arthurf-vdi drun --cpu --skip_resources -v "{path}:{path}" --no-lsf -v /home/arthurf/gosu-i386:/usr/local/bin/gosu:ro ubuntu:trusty gosu {owner} chmod -R 777 "{path}"', shell=True, check=True)


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
