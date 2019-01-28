"""
The naming conventions about where qatools saves results.
"""
import re
from pathlib import Path
import hashlib
import yaml
import json

def make_pretty_tuning_filename(paramstring, filetype, maxlen=20):
  """Best effort attempt at making a human-readable name from tuning parameters"""
  thishash = make_hash(paramstring)
  params_filename = paramstring.replace(",","_")
  for char in "{}:[] \r\n\"":
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
        params = yaml.load(f)
      elif parameters.suffix == '.cde':
        from cde import Config
        params = Config.loads(f.read()).asdict()
      else:
        params = json.load(f)
  return make_hash(params)




def make_hash(obj):
  params_s = json.dumps(obj, sort_keys=True)
  return hashlib.md5(params_s.encode()).hexdigest()



def batch_dir(commit_ci_dir, batch_label, tuning, save_with_ci=False):
  from qatools.config import is_ci, subproject
  from qatools.utils import slugify
  batch_folder = Path('output') if batch_label == 'default' else Path('tuning') / slugify(batch_label)
  return commit_ci_dir / batch_folder if (is_ci or save_with_ci) else subproject / batch_folder


def make_prefix_outputs_path(commit_ci_dir, batch_label, platform, configuration, tuning, save_with_ci):
  return (
    batch_dir(commit_ci_dir, batch_label, tuning, save_with_ci) /
    platform /
    configuration.replace("/", '.') /
    tuning_foldername(batch_label, hash_parameters(tuning))
  )


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


