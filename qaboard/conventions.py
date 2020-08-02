"""
The naming conventions about where qatools saves results.
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



def slugify(s : str, maxlength=64):
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

def slugify_config(s : str, maxlength=64):
  """Slugiy a string like they do at Gitlab."""
  # lowercased and shortened to 63 bytes
  if len(s) < maxlength:
    return slugify(s)
  s_hash = make_hash(s)[:8]
  return f"{s_hash}-{slugify(s[-(maxlength-8):], maxlength=None)}"


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



def get_commit_dirs(commit):
  # FIXME: change conventions
  if not commit:
    return Path()
  if isinstance(commit, str): # commit hexsha
    try:
      authored_date, author_name, commit_id = git_show(format='%at|%an|%H').split('|')
      dir_name = f'{authored_date}__{author_name}__{commit_id[:8]}'
    except:
      return Path()    
  else:
    try:
      # CiCommit from the backend
      committer_name = commit.committer_name if commit.committer_name else "unknown"
      dir_name = f'{int(commit.authored_datetime.timestamp())}__{committer_name}__{commit.hexsha[:8]}'
    except:
      # gitpython commit
      dir_name = f'{commit.authored_date}__{commit.author.name}__{commit.hexsha[:8]}'
  return Path('commits') / dir_name


# backward compatibility for the CI of HW_ALG (tools/ci_scripts/find_valid_build.py) and has to exist for tof/swip_tof's runs
def get_commit_ci_dir(ci_dir, commit):
  return ci_dir / get_commit_dirs(commit)


def batch_folder_name(label:str) -> Path:
  return Path('output') if label == 'default' else Path('tuning') / slugify(label)


def batch_dir(outputs_commit, batch_label, tuning, save_with_ci=False):
  from qaboard.config import is_ci, subproject
  batch_folder = batch_folder_name(batch_label)
  return outputs_commit / batch_folder if (is_ci or save_with_ci) else subproject / batch_folder


def tuning_foldername(batch_label, tuning_parameters_hash):
  if batch_label != 'default':
    if not tuning_parameters_hash:
      param_hash = make_hash({})
    else:
      param_hash = tuning_parameters_hash
    parameters_folder = Path(param_hash[:2]) / param_hash
  else:
    parameters_folder = ''
  return parameters_folder 




def make_batch_dir(outputs_commit, batch_label, platform, configuration, tuning, save_with_ci):
  return batch_dir(outputs_commit, batch_label, tuning, save_with_ci)

def make_batch_conf_dir(outputs_commit, batch_label, platform, configuration, tuning, save_with_ci):
  return (
    batch_dir(outputs_commit, batch_label, tuning, save_with_ci) /
    platform /
    slugify_config(configuration) /
    tuning_foldername(batch_label, hash_parameters(tuning))
  )

