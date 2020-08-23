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



def location_from_spec(spec: Union[str, Dict], interpolation_vars: Optional[Dict] = None) -> Path:
  if isinstance(spec, dict):
    # Mounts are often called differently on linux and windows
    mount_flavor = 'windows' if os.name == 'nt' else 'linux'
    if mount_flavor not in spec:
      raise ValueError(f"Expected a key named {mount_flavor} in {spec}")
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


def make_pretty_tuning_filename(paramstring, filetype, maxlen=20):
  """Best effort attempt at making a human-readable name from tuning parameters"""
  thishash = make_hash(paramstring)
  params_filename = paramstring.replace(",","_")
  for char in "\\{}:[] \r\n\"/":
    params_filename = params_filename.replace(char,"")
  if len(params_filename) > maxlen:
    params_filename = thishash[:8] + '-' + re.sub("[a-zA-Z_]+", lambda x: x.group(0)[-2:], params_filename)
  if len(params_filename) > maxlen:
    params_filename = params_filename[-10:] + '-' + thishash[:10]
  return f"{params_filename}.{filetype}"



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
      commit_id = git_show(format='%H')
    except:
      if repo_root is None:
        raise ValueError("Not enough information about the commit to know where to store its data.")
      # if we run within an artifact directory, we're not in a git repo, so "git show" will fail.
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

