"""
Deprecation warnings, backward compatibility, Windows compatibility
"""
import os
import sys
import click
from pathlib import Path


def ensure_cli_backward_compatibility():
    """Handle deprecate flag names here"""
    renamings = (
        ('--input-path', '--input'),
        ('--output-path', '--output'),
        ('save_artifacts', 'save-artifacts'),
        ('check_bit_accuracy', 'check-bit-accuracy'),
        ('--reference-branch', '--reference'),
        ('--batch-label', '--label'),
        ('--inputs-database', '--database'),
        ('--inputs-globs', 'REMOVED: Use "inputs.types" in qaboard.yaml'),
        ('--save-manifests', '--save-manifests-in-database'),
        ('--return-prefix-outputs-path', '--list-output-dirs'),
        ('--ci', '--share'),
        ('--dry-run', '--dryrun'),
        ('--lsf-memory', '--lsf-max-memory'),
        ('--group', '--batch'),
        ('--groups-file', '--batches-file'),
        ('--no-qa-database', '--offline'),
    )
    def renamed_deprecated(arg):
        for before, after in renamings:
            if arg == before:
                click.secho(f'[DEPRECATION WARNING]: "{before}" was replaced by "{after}" and will be removed in a future release.', fg='yellow')
                return after
        return arg
    sys.argv = [renamed_deprecated(arg) for arg in sys.argv]
    if '--lsf-sequential' in sys.argv:
        click.secho('[DEPRECATION WARNING]: "--lsf-sequential" was replaced with "--runner local"', fg='yellow', bold=True)



def cased_path(path):
    # Adapted from
    # https://stackoverflow.com/questions/3692261/in-python-how-can-i-get-the-correctly-cased-path-for-a-file/14742779#14742779
    if os.name != 'nt':
      return path
    import glob
    dirs = str(path).split('\\')
    # For absolute paths with drive names ("\\host\volume\..."), we must have the correct case at least at the beginning...
    # Still, then, we could always call .upper() if the length of the first part is 1 (drive letter..)
    if not dirs[0] and not dirs[1]:
      dirs = [f'\\\\{dirs[2]}\\{dirs[3]}', *dirs[4:]]
      test_name = [dirs[0]]
    elif not dirs[0]: # absolute paths like "\c\Users\..."
      dirs = [f'\\{dirs[1]}', *dirs[3:]]
      test_name = [dirs[0]]      
    elif dirs[0].endswith(':'): # e.g. C:\\
      test_name = [dirs[0]]
    else: # relative paths
      test_name = ["%s[%s]" % (dirs[0][:-1], dirs[0][-1])]
    for d in dirs[1:]:
        test_name += ["%s[%s]" % (d[:-1], d[-1])]
    res = glob.glob('\\'.join(test_name))
    if not res: #File not found
        return None
    return Path(res[0])



def escaped_for_cli(string):
  # we assume single_quotes are already escaped
  if os.name == 'nt':
    string_escaped = string.replace('\\', '\\\\')
    string_escaped = string_escaped.replace('"', '\\"')
    string_escaped = string_escaped.replace('|', '^|')
    return f'"{string_escaped}"'
  else:
    return 

mappings = (
  (r'\\networkdrive\somewhere', r'/mnt/somewhere'),
  # ...
)


def windows_to_linux(path : str) -> str:
  for path_windows, path_linux in mappings:
    if path.startswith(path_windows):
      path = path.replace(path_windows, path_linux)
  return path.replace('\\', '/')

def linux_to_windows(path : str) -> str:
  for path_windows, path_linux in mappings:
    if path.startswith(path_linux):
      path = path.replace(path_linux, path_windows)
  return path.replace('/', '\\')


def windows_to_linux_path(path : Path) -> Path:
  return Path(windows_to_linux(str(path)))

def linux_to_windows_path(path : Path) -> Path:
  return Path(linux_to_windows(str(path)))


def fix_linux_permissions(path: Path):
  """
  This function is meant to be only used from Samsung SIRC.

  Windows does not set file permissions correctly on the shared storage,
  it does not respect umask 0: files are not world-writable.
  Trying to each_file.chmod(0o777) does not work either
  The only option is to make the call from linux.
  We could save a list of paths and chmod them with their parent directories...
  but to make things faster to code, we just "ssh linux chmod everything"
  We can assume SSH to be present on Windows10
  """
  return
  from getpass import getuser
  click.secho("... Fixing linux file permissions", err=True)
  try:
    user = getuser()
    ssh = f"ssh -i \\\\netapp\\raid\\users\\{user}\\.ssh\\id_rsa -oStrictHostKeyChecking=no"
    hostname = f"{user}-vdi" if user != "sircdevops" else "jenkins10-srv"
    chmod = f'{ssh} {user}@{hostname} \'chmod -R 777 "{windows_to_linux_path(path).as_posix()}"\''
    click.secho(chmod, err=True)
    os.system(chmod)
  except Exception as e:
    click.secho(f'WARNING: {e}', err=True)
