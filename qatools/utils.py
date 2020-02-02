"""
Misc utilities useful for qatools 
"""
import os
import sys
import time
import re
import hashlib
import fnmatch
from pathlib import Path
import shutil
import traceback
import json
from contextlib import contextmanager

import yaml
import click
from click._compat import isatty, strip_ansi


class PathType(click.ParamType):
  """Wrapper for pathlib's Path type, for use with the Click CLI package."""
  name = 'path'
  def convert(self, value, param, ctx):
    if value is None:
      return None
    return Path(value)

class RedirectStream():
  def __init__(self, stream_name, file, color):
    # print(f'@ Redirecting {stream_name}')
    # print(f'> Redirecting {stream_name}', file=getattr(sys, stream_name))
    self.stream_name = stream_name
    self.stream = getattr(sys, stream_name)
    self.file = file.open('a')
    self.stream_color = color or isatty(self.stream)
    self.file_color = color
    setattr(sys, stream_name, self)
  def write(self, data):
    if self.file_color and self.stream_color:
      self.stream.write(data)
      self.file.write(data)
    else:
      data_stripped = data # strip_ansi(data)
      self.stream.write(data if self.stream_color else data_stripped)
      self.file.write(data if self.file_color else data_stripped)
    self.stream.flush()
    self.file.flush()
  def __del__(self):
    setattr(sys, self.stream_name, getattr(sys, f"__{self.stream_name}__"))
    try:
      self.file.close()
    except Exception as e:
      pass
      # we avoid printing here
      # click.secho(f'WARNING: Error when closing the log file', fg='yellow', bold=True)
      # click.secho(str(e), fg='yellow')
  def flush(self):
    self.file.flush()
    self.stream.flush()


@contextmanager
def redirect_std_streams(file, color=None):
  # print(">> Redirecting STDX")
  stdout = RedirectStream('stdout', file, color)
  stderr = RedirectStream('stderr', file, color)
  try:
    yield stdout, stderr
  finally:
    del stdout
    del stderr


class FailingEntrypoint:
  def run(self, context):
    return {"is_failed": True}
  def postprocess(self, metrics, context):
    return {"is_failed": True}


def entrypoint_module(config):
  """Lazily returns the entrypoint module defined in a qatools config"""
  import importlib.util
  entrypoint = config.get('project', {}).get('entrypoint')
  if not entrypoint:
    click.secho(f'ERROR: Could not find the entrypoint', fg='red', err=True, bold=True)
    click.secho(f'Add to qatools.yaml:\n```\nproject:\n  entrypoint: my_main.py\n```', fg='yellow', err=True, dim=True)
    return FailingEntrypoint()
  else:
    entrypoint = Path(entrypoint)
  try:
      name = f'qatools-entrypoint'
      # https://docs.python.org/3/library/importlib.html#importing-a-source-file-directly
      spec = importlib.util.spec_from_file_location(name, entrypoint)

      module = importlib.util.module_from_spec(spec)
      sys.path.insert(0, str(entrypoint.parent))
      spec.loader.exec_module(module)
      # sys.path.pop(0)

      # spec = importlib.util.spec_from_loader(name, importlib.machinery.SourceFileLoader(name, str(entrypoint)))
      # spec.submodule_search_locations = [str(entrypoint.parent)]
      # with cached versions of the entrypoint.... An option could be importlib.reload(module)
      # FIXME: at some points I had issues with sys.path, but no more (?)
  except Exception as e:
      exc_type, exc_value, exc_traceback = sys.exc_info()
      click.secho(f'ERROR: Error importing the entrypoint ({entrypoint}).', fg='red', err=True, bold=True)
      click.secho(''.join(traceback.format_exception(exc_type, exc_value, exc_traceback)), fg='red', err=True)
      click.secho(
          f'{entrypoint} must implement a `run(context)` function, and optionnally `postprocess` / `metadata`.\n'
          'Please read the tutorial at http://qa-docs/ or ask @arthurf for help\n',
          dim=True, err=True)
      return FailingEntrypoint()
  return module


def escaped_for_cli(string):
  # we assume single_quotes are already escaped
  if os.name == 'nt':
    string_escaped = string.replace('\\', '\\\\')
    string_escaped = string_escaped.replace('"', '\\"')
    return f'"{string_escaped}"'
  else:
    return 

# TODO: consider using @lru_cache since it's called twice within qa batch
# from functools import lru_cache
# @lru_cache() # but config not hashable..
def input_metadata(absolute_input_path, database, input_path, config):
  entrypoint_module_ = entrypoint_module(config)
  if hasattr(entrypoint_module_, 'metadata'):
    try:
      metadata = entrypoint_module_.metadata(absolute_input_path, database, input_path)
      if metadata is None:
      	metadata = {}
    except Exception as e:
      exc_type, exc_value, exc_traceback = sys.exc_info()
      click.secho(f'[ERROR] The `metadata` function in your raised an exception:', fg='red', bold=True)
      click.secho(''.join(traceback.format_exception(exc_type, exc_value, exc_traceback)), fg='red', err=True)
      metadata = {}
  # With what's below we run into loops easily if the user uses iter_at_path
  # Let's ask users to be explicit
  # elif hasattr(entrypoint_module_, 'iter_inputs'):
  #   try:
  #     inputs = list(entrypoint_module_.iter_inputs(input_path, database, only=None, exclude=None))
  #     if len(inputs)==1:
  #       metadata = inputs[0].get('metadata', {})
  #     else:
  #       metadata = {}
  #   except Exception as e:
  #     exc_type, exc_value, exc_traceback = sys.exc_info()
  #     click.secho(f'[ERROR] The `iter_inputs` function in your raised an exception:', fg='red', bold=True)
  #     click.secho(''.join(traceback.format_exception(exc_type, exc_value, exc_traceback)), fg='red', err=True)
  #     metadata = {}
  else:
    metadata = {}
  return metadata

def input_data(database, input_path, config):
    if input_path.is_absolute():
      click.secho(f"[ERROR] Inputs are only allowed to be relative paths.", fg='red', bold=True)
      click.secho(f'We except you to split "{input_path}" into a "database" and a relative path.', fg='red')
      exit(1)
    absolute_input_path = (database / input_path).resolve()
    if not absolute_input_path.exists():
      click.secho(f"[ERROR] {absolute_input_path} cannot be found", fg='red')
      exit(1)
    return {
      "input_path": input_path,
      "absolute_input_path": absolute_input_path,
      "input_metadata": input_metadata(absolute_input_path, database, input_path, config)
    }




def _copy(src, destination):
  shutil.copy(str(src), str(destination))
  # we already use umask 0, but just to be sure, we set the permissions to be open
  os.chmod(destination, 0o777)

def copy_data(src, destination):
  shutil.copyfile(str(src), str(destination))

def copy(src, destination):
  # We are forced to add some retry logic to deal with our broken storage
  # sometimes it raises a permission error but everything is OK on the second try...
  if not destination.parent.exists():
    destination.parent.mkdir(parents=True, exist_ok=True)
  try:
    _copy(src, destination)
  except:
    time.sleep(0.01) # seconds
    try:
      _copy(src, destination)
    except: # wt...
      copy_data(src, destination)



default_plaintext = set(['.txt', '.cde', '.hex', '.iir', '.dvs'])
def is_plaintext(path, config=None):
  if not config:
    config = {}
  binary_patterns = config.get('bit_accuracy', {}).get('binary')
  if binary_patterns: # remove when everybody updates HW_ALG...
    binary_patterns.append('.exe')
    binary_patterns.append('.dll')
    binary_patterns = ['*' + b if b.startswith('.') else b for b in binary_patterns]

  plaintext_patterns = config.get('bit_accuracy', {}).get('plaintext')

  if not plaintext_patterns and not binary_patterns:
    return path.suffix in default_plaintext
  if plaintext_patterns and not binary_patterns:
    return any(fnmatch.fnmatch(path.name, p) for p in plaintext_patterns)
  if not plaintext_patterns and binary_patterns:
    #print(list((path.name, p, fnmatch.fnmatch(path.name, p)) for p in binary_patterns))
    return not any(fnmatch.fnmatch(path.name, p) for p in binary_patterns)
  click.secho('ERROR: Cannot define both bit_accuracy.binary and bit_accuracy.plaintext in qatools.yaml', fg='red')
  exit(1)


def file_info(path, normalize_eof=True, config=None, compute_hashes=True):
  """Return metadata about a file."""
  path = Path(path) # just to be sure...

  # For bit-accuracy checks to work on text files between UNIX/windows,
  # we need to convert end-of-lines on Windows
  #print ("is plaintext:",is_plaintext(path, config=config), path)
  if os.name == 'nt' and is_plaintext(path, config=config) and normalize_eof:
    try:
      with path.open(newline=None, encoding="utf-8", errors='ignore') as raw_file: # will accept both \t\n and \n as line endings
        text = raw_file.read()
    except:
      print(f"WARNING: Error reading {path}")
      try:
        with path.open(newline=None, errors="surrogateescape", encoding="utf-8") as raw_file:
          text = raw_file.read()
      except Exception as e:
        print(f"ERROR: Error reading {path} even with surrogateescape")
        raise e
    from datetime import datetime
    normalized_file_name = "%s_%s" % (str(path), re.sub('\W', '_', str(datetime.now())))
    with open(normalized_file_name, 'w+', newline='\n', encoding="utf-8", errors='ignore') as normalized_file:
      normalized_file.write(text)
    normalized_file_info = file_info(normalized_file_name, normalize_eof=False)
    Path(normalized_file_name).unlink()
    return normalized_file_info
  info = {"st_size": os.stat(path).st_size}
  if compute_hashes:
    md5 = hashlib.md5()
    block_size = 4**10
    with path.open('rb') as f:
      while True:
        data = f.read(block_size)
        if not data: break
        md5.update(data)
    info['md5'] = md5.hexdigest()
  return info

def save_outputs_manifest(output_directory, config=None, compute_hashes=True):
  """Save a manifest of all the files from the directory. It helps QA-Board list them quickly."""
  def should_be_in_manifest(path):
    # avoid logs with timestamps and temporary NFS files
    return path.is_file() and path.name != 'log.txt' and not path.name.startswith('.nfs00000')
  output_files = {
    path.relative_to(output_directory).as_posix(): file_info(path, config=config, compute_hashes=compute_hashes)
    for path in output_directory.rglob('*')
    if should_be_in_manifest(path)
  }
  with (output_directory / 'manifest.outputs.json').open('w') as f:
    json.dump(output_files, f, indent=2)
  return output_files



class _Repo(object):
  """Lazily wraps gitpython's Repo to avoid high import times and stay backward-compatible"""
  def __init__(self, repo_root):
    self.repo = None
    self.repo_root = repo_root

  def init(self):
    import git
    try:
      self.repo = git.Repo(str(self.repo_root))
    except:
      self.repo = None
  def __getattribute__(self, name):
    # print(f'_Repo.__getattribute__ {name}')
    if name in ['repo_root']:
      return object.__getattribute__(self, name)
    if not object.__getattribute__(self, 'repo'):
      object.__getattribute__(self, 'init')()

    repo = object.__getattribute__(self, 'repo')
    if not repo:
      raise ValueError(f"ERROR: Not a git rep {object.repo_root}")
    return repo.__getattribute__(name)


class _Commit(object):
  """Lazily wraps gitpython's Commit to avoid high import times and stay backward-compatible"""
  def __init__(self, repo, commit_id):
    self.commit = None
    self.repo = repo
    self.commit_id = commit_id

  def init(self):
    # print('init()')
    if not self.commit_id:
      self.commit = self.repo.commit(commit_id)
    else:
      # print('init: has commit_id')
      # print("type(self.repo.commit)", type(self.repo.head.commit))
      # print(self.repo.commit(self.repo.head.commit))
      self.commit = self.repo.head.commit

  def __getattribute__(self, name):
    if name in ['commit_id', 'repo']:
      return object.__getattribute__(self, name)
    if not object.__getattribute__(self, 'commit'):
      object.__getattribute__(self, 'init')()

    commit = object.__getattribute__(self, 'commit')
    # print("commit", type(commit))
    if not commit:
      raise ValueError(f"ERROR: Could not init a GitPython Commit: {object.commit_id}")
    # FIXME: this seems to init a data fetch of some sort...
    commit.committer
    return commit.__getattribute__(name)



def git_head(repo_root : Path) -> (str, str):
  """Return the git ref and sha for the HEAD""" 
  with (repo_root / '.git' / 'HEAD').open() as f:
    head_data = f.read().strip()
    if head_data.startswith('ref: refs/heads/'):
      commit_branch = head_data[16:]
    else:
      commit_branch = head_data

  # Maybe we should just call "git rev-parse HEAD" from repo_root,
  # there cant be that much overhead and it won't be as fragile...
  refs_head_path = repo_root / '.git' / 'refs' / 'heads' / commit_branch
  if refs_head_path.exists():
    with refs_head_path.open() as f:
      return commit_branch, f.read().strip()

  packed_refs_path = repo_root / '.git' / 'packed-refs'
  if packed_refs_path.exists():
    with packed_refs_path.open() as f:
      for line in f.readlines():
        if line.startswith('#'):
          continue
        try:
          hexsha, ref = line.strip().split(maxsplit=1)
          if ref == f"refs/heads/{commit_branch}":
            return commit_branch, hexsha
        except:
            pass
  return commit_branch, commit_branch


def latest_commit(repo, reference):
    """Returns the latest commit on a reference (commit, tag or branch)."""
    # FIXME: couldn't we just use the project's git repo URL from the configuration?
    # Here we find a local copy of the repo and use it to iterate through commits
    # TODO: we should use the branch slug.... but it will work for develop/master/release...
    remote = repo.remote()
    try:
      return remote.refs[reference].commit
    except:
      try:
        # print([r.name for r in remote.refs if ('testing' in r.name)])
        # print([r for r in remote.refs if r.name==reference or r.name==f'{r.remote_name}/{reference}'])
        return [r for r in remote.refs if r.name==reference or reference.replace(r.remote_name, '') == r.name or reference==f'{r.remote_name}/{r.name}'][0]
      except:
        return repo.commit(rev=reference)
    # try:/
    #   return list(repo.iter_commits(reference.replace('origin/', ''), max_count=1))[0]


def getenvs(variables, default=None):
  """Return the value of the environment variable that is defined - or None."""
  for name in variables:
    if name in os.environ:
      return os.environ[name]
  return default


def load_tuning_search(tuning_search, tuning_search_file):
  if tuning_search and tuning_search_file:
    click.secho('Error: specify only one of --tuning-search or --tuning-search-file', fg='red', err=True)
    exit(1)
  if tuning_search_file:
    if not tuning_search_file.exists():
      click.secho('Error: could not find the file specified by --tuning-search-file', fg='red', err=True)
      exit(1)
    with tuning_search_file.open('r') as f:
      tuning_search = f.read()
    if tuning_search_file.suffix == '.yaml':
      tuning_search_dict = yaml.load(tuning_search, Loader=yaml.SafeLoader)
      filetype = 'yaml'
    elif tuning_search_file.suffix == '.cde':
      from cde import Config
      tuning_search_dict = Config.loads(f.read()).asdict()
      filetype = 'cde'
    else:
      tuning_search_dict = json.loads(tuning_search)
      filetype = 'json'
  else:
    tuning_search_dict = json.loads(tuning_search) if tuning_search else None
    filetype = 'json' # we default to json
  return tuning_search_dict, filetype




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
    else: # relative paths
      test_name = ["%s[%s]" % (dirs[0][:-1], dirs[0][-1])]
    for d in dirs[1:]:
        test_name += ["%s[%s]" % (d[:-1], d[-1])]
    res = glob.glob('\\'.join(test_name))
    if not res: #File not found
        return None
    return Path(res[0])

