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

import yaml
import click
from click._compat import isatty, strip_ansi


class PathType(click.ParamType):
  """Wrapper for pathlib's Path type, for use with the Click CLI package."""
  name = 'path'
  def convert(self, value, param, ctx):
    return Path(value)


class RedirectStream():
  def __init__(self, stream_name, file, color):
    # print(f'Redirecting {stream_name}')
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
    self.file.close()
  def flush(self):
    self.file.flush()
    self.stream.flush()


def redirect_std_streams(file, color=None):
  RedirectStream('stdout', file, color)
  RedirectStream('stderr', file, color)


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
      # https://docs.python.org/3/library/importlib.html#importing-a-source-file-directly
      sys.path.append(str(entrypoint.parent)) # allow imports relative to the entrypoint's directory # FIXME: called multiple times...
      spec = importlib.util.spec_from_file_location('entrypoint', entrypoint)
      module = importlib.util.module_from_spec(spec)
      spec.loader.exec_module(module)
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
  elif hasattr(entrypoint_module_, 'iter_inputs'):
    try:
      inputs = list(entrypoint_module_.iter_inputs(input_path, database, only=None, exclude=None))
      print(inputs)
      if len(inputs)==1:
        metadata = inputs[0].get('metadata', {})
      else:
        metadata = {}
    except Exception as e:
      exc_type, exc_value, exc_traceback = sys.exc_info()
      click.secho(f'[ERROR] The `iter_inputs` function in your raised an exception:', fg='red', bold=True)
      click.secho(''.join(traceback.format_exception(exc_type, exc_value, exc_traceback)), fg='red', err=True)
      metadata = {}
  else:
    metadata = {}
  return metadata

def input_data(database, input_path, config):
    if input_path.is_absolute():
      click.secho(f"[ERROR] the input should be given as a relative path.", fg='red')
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
  binary_patterns = config.get('bit-accuracy', {}).get('binary')
  plaintext_patterns = config.get('bit-accuracy', {}).get('plaintext')
  if not plaintext_patterns and not binary_patterns:
    return path.suffix in default_plaintext
  if plaintext_patterns and not binary_patterns:
    return any(fnmatch.fnmatch(path.name, p) for p in plaintext_patterns)
  if not plaintext_patterns and binary_patterns:
    return not any(fnmatch.fnmatch(path.name, p) for p in binary_patterns)
  click.secho('ERROR: Cannot define both bit-accuracy.binary and bit-accuracy.plaintext in qatools.yaml', fg='red')
  exit(1)


def file_info(path, normalize_eof=True, config=None):
  """Return metadata about a file."""
  path = Path(path) # just to be sure...

  # For bit-accuracy checks to work on text files between UNIX/windows,
  # we need to convert end-of-lines on Windows
  if os.name == 'nt' and is_plaintext(path, config):
    from tempfile import NamedTemporaryFile
    with NamedTemporaryFile(mode='w+', delete=False, newline='\n') as normalized_file:
      normalized_file_name = normalized_file.name
      with path.open(newline=None) as raw_file: # will accept both \t\n and \n as line endings
        raw_lines = raw_file.readlines()
        normalized_file.writelines(raw_lines)
        # normalized_file.flush()
    normalized_file_info = file_info(normalized_file_name, normalize_eof=False)
    Path(normalized_file_name).unlink()
    return normalized_file_info

  md5 = hashlib.md5()
  block_size = 4**10
  with path.open('rb') as f:
    while True:
      data = f.read(block_size)
      if not data: break
      md5.update(data)
  stats = os.stat(path)
  return {
    # "st_mtime_ns": stats.st_mtime_ns,
    "st_size": stats.st_size,
    "md5": md5.hexdigest(),
  }


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
