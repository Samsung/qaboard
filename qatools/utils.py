"""
Utilities related to CI: contacting the results database, naming conventions... 
"""
import os
import hashlib
import json
import yaml
from pathlib import Path

import click
import requests
from .config import config, is_ci, commit_type, commit_id


def notify_qa_database(**kwargs):
  """
  Send a notification to the server updating the QA database.
  It will know that it should look for new results
  """
  # some light custom serialization
  for key, value in kwargs.items():
    if issubclass(type(value), Path):
      kwargs[key] = str(value)

  # we send updates to
  protocol = os.getenv('QATOOLS_DB_PROTOCOL', 'http')
  host = os.getenv('QATOOLS_DB_HOST', 'dvs')
  port = os.getenv('QATOOLS_DB_PORT', '5000')
  url = f'{protocol}://{host}:{port}/api/v1/output/'
  data= {
    'job_type': commit_type,
    'git_commit_sha': commit_id,
    **kwargs,
  }
  # we make sure we have all the parameters
  if not 'extra_parameters' in kwargs:
    data = {**data, 'extra_parameters': {}}
  try:
    r = requests.post(url, json=data)
    r.raise_for_status()
  except:
    print('WARNING: Failed to update the QA database.')
    print(r.request.headers)
    print(r.request.body)
    print(f'{r.status_code}: {r.text}')


def save_metrics(output_directory, **kwargs):
  # the SLAM may already write here metrics like run-time, cpu usage...
  if (output_directory/'metrics.json').exists():
    with (output_directory/'metrics.json').open('r') as f:
      old_metrics = json.load(f)
  else:
      old_metrics = {}
  new_metrics = {
    **old_metrics,
    **kwargs,
  }
  print(new_metrics)
  with (output_directory/'metrics.json').open('w') as f:
      json.dump(new_metrics, f, sort_keys=True, indent=2, separators=(',', ': '))


def commit_dir_name(commit):
    """Returns the name of the directory under which the QA tools save the results
    args: commit, gitpython Commit.
    """
    return f'{reference_commit.authored_date}__git__{reference_commit.hexsha[:8]}'


def tuning_foldername(batch_label, tuning_parameters_hash):
  if batch_label != 'default':
    if not tuning_parameters_hash:
      param_hash = hashlib.md5(json.dumps({}).encode()).hexdigest()
    else:
      param_hash = tuning_parameters_hash
    parameters_folder = Path(param_hash[:2]) / param_hash
  else:
    parameters_folder = ''
  return parameters_folder 

def hash_parameters(filepath):
  if not filepath:
    params = {}
  else:
    with filepath.open('r') as f:
      params = json.load(f)
  params_s = json.dumps(params, sort_keys=True)
  return hashlib.md5(params_s.encode()).hexdigest()

def slugify(s):
  s_slugified = s
  for c in ' /': # baaaaad
    s_slugified = s_slugified.replace(c, '-')
  return s_slugified

def iter_recordings(groups, groups_file, database, default_configuration):
  """Returns an iterator over the (recording, configuration) from the selected groups
  params:
  - groups: array of group labels
  - groups_file: yaml file
  - configuration, is none is specified
  """
  available_batches = yaml.load(Path(groups_file).open())
  for group in groups:
    print(available_batches[group])
    if 'configuration' in available_batches[group]:
      group_configuration = available_batches[group]['configuration']
      if isinstance(group_configuration, list):
        group_configuration = ':'.join(group_configuration)
    else:
      group_configuration = default_configuration

    locations = available_batches[group]['tests']
    if not locations:
      print("Warning: the selected batch is empty")
      continue

    if isinstance(locations, list):
      locations = {l:group_configuration for l in locations}

    for location, location_configuration in locations.items():
      if not location_configuration:
        location_configuration = group_configuration
      click.secho(str(location), bold=True, fg='cyan')
      maybe_parent = lambda path: path.parent if config['inputs']['use_parent_folder'] else path
      yield from [(maybe_parent(f), location_configuration) for f in (database/location).rglob(config['inputs']['glob'])]
      if location.endswith(config['inputs']['glob']):
        yield maybe_parent(Path(database/location)), location_configuration



hash_empty_tuning = hashlib.md5(json.dumps({}).encode()).hexdigest()


def iter_parameters(tuning_search=None):
  # http://scikit-learn.org/stable/modules/generated/sklearn.model_selection.ParameterSampler.html#sklearn.model_selection.ParameterSampler
  from sklearn.model_selection import ParameterGrid, ParameterSampler
  if not tuning_search:
    yield (None, hash_empty_tuning, {})
    return
  if isinstance(tuning_search['parameter_search'], list):
    for param_search in tuning_search['parameter_search']:
      tuning_search_ = tuning_search
      tuning_search_['parameter_search'] = param_search
      yield from iter_parameters(tuning_search=tuning_search_)
    return

  for parameter, values in tuning_search['parameter_search'].items():
    if isinstance(values, dict):
      if not 'function' in values or not 'arguments' in values:
        raise ValueError
      if values['function'] == 'range':
        args = values['arguments']
        if 'start' not in args: args['start']=0
        if 'stop' not in args: args['stop']=0
        if 'step' not in args: args['step']=1
        tuning_search[parameter] = list(range(args['start'], args['stop'], args['step']))

  if tuning_search['search_type'] == 'grid':
    params_iterator = ParameterGrid(tuning_search['parameter_search'])
  elif tuning_search['search_type'] == 'sampler':
    if 'search_options' in tuning_search and 'n_iter' in tuning_search['search_options']:
      n_iter = tuning_search['search_options']['n_iter']
    else:
      n_iter = 10
    params_iterator = ParameterSampler(tuning_search['parameter_search'], n_iter=n_iter)
  else:
    raise ValueError
  for params in params_iterator:
    params_s = json.dumps(params, sort_keys=True)
    params_hash = hashlib.md5(params_s.encode()).hexdigest()
    params_file = working_directory/'tuning'/'params'/f'{params_hash[:2]}/{params_hash}.json'
    params_file.parent.mkdir(parents=True, exist_ok=True)
    with params_file.open('w') as f:
      json.dump(params, f)
    yield params_file, params_hash, params


class PathType(click.ParamType):
  """Wrapper for pathlib's Path type, for use with the Click CLI package."""
  name = 'path'
  def convert(self, value, param, ctx):
    return Path(value)
