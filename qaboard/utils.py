"""
Misc utilities 
"""
import os
import re
import sys
import json
import shutil
import traceback
from pathlib import Path
from itertools import chain
from fnmatch import fnmatch
from contextlib import contextmanager
from typing import Optional, Dict, List, Iterable, Tuple

import yaml
import click
from click._compat import isatty, strip_ansi


def merge(src: Dict, dest: Dict) -> Dict:
    """Deep merge dicts"""
    # https://stackoverflow.com/questions/20656135/python-deep-merge-dictionary-data
    if src:
      for key, value in src.items():
        if isinstance(value, dict):
          node = dest.setdefault(key, {})
          merge(value, node)
        else:
          # "super" is a reserved keyword
          if isinstance(value, list) and "super" in value:
            value = list(chain.from_iterable([[e] if e != "super" else dest.get(key, []) for e in value]))
          dest[key] = value
    return dest


def getenvs(variables: Iterable[str], default=None) -> Optional[str]:
  """Return the value of the environment variable that is defined - or None."""
  for name in variables:
    if name in os.environ:
      return os.environ[name]
  return default

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
  if os.environ.get('QA_NO_STREAM_REDIRECT'):
    yield sys.stdout, sys.stderr
    return
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


# FIXME: pass a path to the entrypoint, not a full config
def entrypoint_module(config):
  """Lazily returns the entrypoint module defined in a qaboard config"""
  import importlib.util
  entrypoint = config.get('project', {}).get('entrypoint')
  if not entrypoint:
    click.secho(f'ERROR: Could not find the entrypoint', fg='red', err=True, bold=True)
    click.secho(f'Add to qaboard.yaml:\n```\nproject:\n  entrypoint: my_main.py\n```', fg='red', err=True, dim=True)
    return FailingEntrypoint()
  else:
    entrypoint = Path(entrypoint)
  try:
      name = f'qaboard-entrypoint'
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
          f'{entrypoint} must implement a `run(context)` function, and optionnally `postprocess` / `metadata` / `iter_inputs`.\n'
          'Please read the tutorial at https://samsung.github.com/qaboard/docs\n',
          dim=True, err=True)
      return FailingEntrypoint()
  return module


# TODO: consider using @lru_cache since it's called twice within qa batch
# from functools import lru_cache
# @lru_cache() # but config not hashable.. we'd need to pass a path to the entrypoint
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




def _copy(src, destination):
  shutil.copy(str(src), str(destination))
  # We already use umask 0, but just to be sure, with our broken shared storage, we set the permissions to be open
  os.chmod(destination, 0o777)

def copy(src, destination):
  # We are forced to add some retry logic to deal with our broken storage
  # sometimes it raises a permission error but everything is OK on the second try...
  if not destination.parent.exists():
    destination.parent.mkdir(parents=True, exist_ok=True)
  try:
    _copy(src, destination)
  except:
    import time
    time.sleep(0.01) # seconds
    try:
      _copy(src, destination)
    except: # wt...
      shutil.copyfile(str(src), str(destination))



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
    return any(fnmatch(path.name, p) for p in plaintext_patterns)
  if not plaintext_patterns and binary_patterns:
    #print(list((path.name, p, fnmatch(path.name, p)) for p in binary_patterns))
    return not any(fnmatch(path.name, p) for p in binary_patterns)
  click.secho('ERROR: Cannot define both bit_accuracy.binary and bit_accuracy.plaintext in qaboard.yaml', fg='red')
  exit(1)


def file_info(path, normalize_eof=True, config=None, compute_hashes=True):
  """Return metadata about a file."""
  path = Path(path)
  # For bit-accuracy checks to work on text files between UNIX/windows,
  # we need to convert end-of-lines on Windows
  if os.name == 'nt' and is_plaintext(path, config=config) and normalize_eof:
    try:
      with path.open(newline=None, encoding="utf-8", errors='surrogateescape') as raw_file: # will accept both \t\n and \n as line endings
        text = raw_file.read()
    except Exception as e:
      print(f"WARNING: Error reading {path} (utf8/surrogateescape), {e}")
      try:
        with path.open(newline=None, encoding="utf-8", errors="ignore") as raw_file:
          text = raw_file.read()
      except Exception as e:
        print(f"ERROR: Error reading {path} (utf8/ignore), {e}")
        raise e

    from tempfile import NamedTemporaryFile
    with NamedTemporaryFile(mode='w+', delete=False, newline='\n') as normalized_file:
      normalized_file_name = normalized_file.name
    with open(normalized_file_name, 'w+', newline='\n', encoding="utf-8", errors='ignore') as normalized_file:
      normalized_file.write(text)

    normalized_file_info = file_info(normalized_file_name, normalize_eof=False)
    Path(normalized_file_name).unlink()
    return normalized_file_info
  info = {"st_size": os.stat(path).st_size}
  if compute_hashes:
    info['md5'] = md5_hex(path)
  return info


def md5_hex(path):
  import hashlib
  md5 = hashlib.md5()
  block_size = 4**10
  with path.open('rb') as f:
    while True:
      data = f.read(block_size)
      if not data: break
      md5.update(data)
  return md5.hexdigest()




def save_outputs_manifest(output_directory: Path, config=None, compute_hashes=True) -> Dict:
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


def total_storage(manifest):
  return sum([f['st_size'] for f in manifest.values()])


def load_tuning_search(tuning_search: str, tuning_search_file: Path) -> Tuple[Dict, str]:
  if tuning_search and tuning_search_file:
    click.secho('Error: specify only one of --tuning-search or --tuning-search-file', fg='red', err=True)
    exit(1)
  if tuning_search_file:
    if not tuning_search_file.exists():
      click.secho('Error: could not find the file specified by --tuning-search-file', fg='red', err=True)
      exit(1)
    with tuning_search_file.open('r') as f:
      tuning_search = f.read()
    suffix = tuning_search_file.suffix
    if suffix == '.yaml' or suffix == '.yml':
      tuning_search_dict = yaml.load(tuning_search, Loader=yaml.SafeLoader)
      filetype = 'yaml'
    elif suffix == '.json':
      tuning_search_dict = json.loads(tuning_search)
      filetype = 'json'
    else:
      raise ValueError(f"Unsupported --tuning-search-file format: {suffix}")
  else:
    tuning_search_dict = json.loads(tuning_search) if tuning_search else None
    filetype = 'json' # we default to json
  return tuning_search_dict, filetype



