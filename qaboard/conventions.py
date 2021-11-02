"""
The conventions about where QA-Board stores results.
"""
import os
import re
import json
import hashlib
import subprocess
from pathlib import Path
from typing import List, Dict, Union, Optional

import yaml
import click

from .git import git_show



def location_from_spec(spec: Union[str, Dict, os.PathLike], interpolation_vars: Optional[Dict] = None) -> Path:
  if isinstance(spec, dict):
    # Mounts are often called differently on linux and windows
    mount_flavor = 'windows' if os.name == 'nt' else 'linux'
    if mount_flavor not in spec:
      raise ValueError(f"Expected a key named {mount_flavor} in {spec}. Vars:{interpolation_vars}")
    location = spec[mount_flavor]
  else:
    location = spec
  location = os.path.expandvars(location)
  if interpolation_vars:
    location = location.format(**interpolation_vars)
  return Path(location)


def get_settings(inputs_type, config):
  config_inputs = config.get('inputs', {})  
  config_inputs_types = config_inputs.get('types', {})
  if inputs_type != 'default' and inputs_type not in config_inputs_types:
    error = f'Error: Unknown input type <{inputs_type}>. It is not defined in your qaboard.yaml'
    click.secho(error, fg='red', err=True, bold=True)
    raise ValueError(error)
  settings = {
    **config_inputs,
    **config_inputs_types.get(inputs_type, {}),
    "type": inputs_type,
  }
  if 'globs' not in settings:
    settings['globs'] = settings.get('glob')
  return settings



def batches_files(config, batch_paths, project, subproject, root_qatools):
  if root_qatools:
    assert bool(config) ^ bool(batch_paths)

  paths = []
  if config:
    config_inputs = config.get('inputs', {})
    # "batches" is prefered, but we want to stay backward compatible
    paths = config_inputs.get('groups', config_inputs.get('batches'))
  elif batch_paths:
    paths = batch_paths

  if not paths:
    return paths
  if not (isinstance(paths, list) or isinstance(paths, tuple)):
    paths = [paths]
  paths = [location_from_spec(p, {"project": project, "subproject": subproject}) for p in paths]

  if any(['*' in str(paths)]):
    from itertools import chain
    from glob import iglob
    # in python3.10 glob supports root_dir...
    prev_cwd = os.getcwd()
    os.chdir(root_qatools)  
    paths = list(chain.from_iterable([iglob(str(path)) for path in paths]))
    os.chdir(prev_cwd)
  return paths

def slugify(s : str, maxlength=32):
  # lowercased and shortened to 63 bytes
  slug = s.lower()
  if maxlength:
    slug = slug[:(maxlength - 1)]
  # everything except 0-9 and a-z replaced with -. 
  slug = re.sub('[^0-9a-z.=]', '-', slug)
  slug = re.sub('-{2,}', '-', slug)
  # No leading / trailing -.
  # if len(slug) > 1: # empty config: -
  #   slug = slug.strip('-') 
  slug = slug.strip('-') 
  return slug

def slugify_hash(s, maxlength=32):
  if not isinstance(s, str):
    s_to_slugify = json.dumps(s, sort_keys=True)
  else:
    s_to_slugify = s
  if len(s_to_slugify) < maxlength:
    return slugify(s_to_slugify)
  s_hash = make_hash(s)[:8]
  return f"{s_hash}-{slugify(s_to_slugify[-(maxlength-8):], maxlength=None)}"


def deserialize_config(configuration: str) -> List:
  # print("[deserialize] before : ", configuration)
  if configuration == '-':
    return []
  configurations: List = []
  configuration_part = ''

  is_windows = os.name == 'nt'
  for token in configuration.split(':'):
    # FIXME: For users that work locally on Windows,
    #        we take care of the special case "base:C://Users:delta"
    #        Ideally we should provide configs via `qa -c config1 -c C://file` and avoid this issue...
    if is_windows and not configuration_part and token[0] in ['\\', '/']:
      maybe_absolute_path = configurations[-1] + token if configurations else token
      if os.path.exists(maybe_absolute_path):
        configurations[-1] = maybe_absolute_path
        continue

    # FIXME: Same issue here: we started with ":"-separated arrays of configs
    #        Of course, hell breaks loose when we try to use json...
    maybe_start_of_json = token.startswith('{')
    if not configuration_part and not maybe_start_of_json:
      configurations.append(token)
    else:
      configuration_part = f"{configuration_part}:{token}" if configuration_part else token
      try:
        configurations.append(json.loads(configuration_part))
        configuration_part = ''
      except:
        # It's not perfect: we should deal with quoting...
        # For now let's say using "{" or "}" is discouraged as part of config strings
        # Again, the better fix is not to do this ":"-separated serialization in the first place
        if configuration_part.count('{') == configuration_part.count('}'):
          configurations.append(configuration_part)
          configuration_part = ''
        else:
          pass
  if configuration_part:
      configurations.append(configuration_part)
  # print("[deserialize] after: ", configurations)
  return configurations


def serialize_config(configurations: List) -> str:
  # print("[serialize] before: ", configurations)
  if not configurations:
    return '-'
  if isinstance(configurations, str):
    return configurations
  configurations = [json.dumps(c, sort_keys=True) if isinstance(c, dict) else c for c in configurations]
  # print("[serialize] during", configurations)
  configuration = ":".join(configurations)
  # print("[serialize] after: ", configuration)
  return configuration


def pretty_hash(params_str, maxlen=20):
  """Best effort attempt at making a human-readable name from tuning parameters"""
  params_hash = make_hash(params_str)
  params_hash_pretty = params_str.replace(",","_")
  for char in "\\{}:[] \r\n\"/":
    params_hash_pretty = params_hash_pretty.replace(char,"")
  if len(params_hash_pretty) > maxlen:
    params_hash_pretty = params_hash[:8] + '-' + re.sub("[a-zA-Z_]+", lambda x: x.group(0)[-2:], params_hash_pretty)
  if len(params_hash_pretty) > maxlen:
    params_hash_pretty = params_hash_pretty[-10:] + '-' + params_hash[:10]
  return params_hash_pretty



def hash_parameters(parameters):
  # we can specify either None, directly parameters, or a Path
  if not parameters:
    params = {}
  elif isinstance(parameters, dict):
    params = parameters
  else:
    with parameters.open('r') as f:
      if parameters.suffix == '.yaml':
        params = yaml.load(f, Loader=yaml.SafeLoader)
      elif parameters.suffix == '.cde':
        from cde import Config
        params = Config.loads(f.read()).asdict()
      else:
        params = json.load(f)
  return make_hash(params)




def make_hash(obj):
  params_s = json.dumps(obj, sort_keys=True)
  return hashlib.md5(params_s.encode()).hexdigest()



def get_commit_dirs(commit, repo_root: Optional[Path]=None) -> Path:
  # If there is no git data we store outputs in the current working directory,
  # or at the project root if using subprojects...
  # FIXME: on Windows the trick of returning an absolute path and have some_path / get_commit_dirs()
  #        be equal to get_commit_dirs() doesn't work...
  if not commit:
    if repo_root is None:
      raise ValueError("Not enough information about the commit to know where to store its data.")
    return repo_root.resolve()
  if isinstance(commit, str): # commit hexsha
    try:
      commit_id = git_show(format='%H', reference=commit)
    except:
      if repo_root is None:
        raise ValueError("Not enough information about the commit to know where to store its data.")
      # if we run within an artifact directory, we're not in a git repo, so "git show" will fail.
      click.secho(f"WARNING: Could not resolve the commit locally ({commit}). Not enough information to know where to store artifacts/runs.", fg='yellow', err=True)
      return repo_root.resolve()
  else:
    commit_id = commit.hexsha
  # git hex hashes are size 40. For us 16 should be plenty enough...
  dir_name = f'{commit_id[:2]}/{commit_id[2:16]}'
  return Path(dir_name)


# backward compatibility for the CI of HW_ALG (tools/ci_scripts/find_valid_build.py) and has to exist for tof/swip_tof's runs
def get_commit_ci_dir(ci_dir, commit):
  return ci_dir / get_commit_dirs(commit)


def batch_folder_name(label:str) -> Path:
  return Path('output') if label == 'default' else Path('output') / slugify_hash(label)



def batch_dir(outputs_commit, batch_label, save_with_ci=False):
  from qaboard.config import is_ci, subproject
  batch_folder = batch_folder_name(batch_label)
  return outputs_commit / batch_folder if (is_ci or save_with_ci) else subproject.resolve() / batch_folder

def make_batch_dir(outputs_commit, batch_label, platform, configurations, extra_parameters, save_with_ci):
  return batch_dir(outputs_commit, batch_label, save_with_ci)

def make_batch_conf_dir(outputs_commit, batch_label, platform, configurations, extra_parameters, save_with_ci):
  full_configurations = [platform] if platform != 'linux' else []
  full_configurations.extend([*configurations, extra_parameters])
  return (
    batch_dir(outputs_commit, batch_label, save_with_ci) /
    slugify_hash(full_configurations, maxlength=16)
  )

def output_dirs_for_input_part(input_path, database, config):
    input_dir = input_path.with_suffix('')
    if config.get('outputs', {}).get('output_dir_uses_database'):
        if not database.is_absolute():
            input_dir = database / input_dir
        else:
            input_dir = database.relative_to(database.root) / input_dir
    if len(input_dir.as_posix()) > 70:
        input_dir = Path(slugify_hash(input_dir.as_posix(), maxlength=70))
    return input_dir
