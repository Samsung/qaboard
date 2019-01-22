"""
Utilities related to CI: contacting the results database, naming conventions... 
"""
import os
import json
import yaml
from pathlib import Path
import hashlib
import re
import fnmatch

import click
from qatools.config import is_ci, subproject

class PathType(click.ParamType):
  """Wrapper for pathlib's Path type, for use with the Click CLI package."""
  name = 'path'
  def convert(self, value, param, ctx):
    return Path(value)

def file_info(path):
  """Return metadata about a file."""
  md5 = hashlib.md5()
  block_size = 2**20
  with path.open('rb') as f:
    while True:
      data = f.read(block_size)
      if not data: break
      md5.update(data)
  stats = os.stat(path)
  return {
    "st_mtime_ns": stats.st_mtime_ns,
    "st_size": stats.st_size,
    "md5": md5.hexdigest(),
  }

def latest_commit(repo, branch):
    """Returns the latest commit on a branch."""
    # FIXME: couldn't we just use the project's git repo URL from the configuration?
    # Here we find a local copy of the repo and use it to iterate through commits
    # TODO: we should use the branch slug.... but it will work for develop/master/release...
    return list(repo.iter_commits(branch, max_count=1))[0]


def slugify(s):
  s_slugified = s
  for c in ' /': # baaaaad
    s_slugified = s_slugified.replace(c, '-')
  return s_slugified

def make_hash(obj):
  params_s = json.dumps(obj, sort_keys=True)
  return hashlib.md5(params_s.encode()).hexdigest()


def batch_dir(commit_ci_dir, batch_label, tuning):
  batch_folder = Path('output') if batch_label == 'default' else Path('tuning') / slugify(batch_label)
  return commit_ci_dir / batch_folder if is_ci else subproject / batch_folder


def make_prefix_outputs_path(commit_ci_dir, batch_label, platform, configuration, tuning):
  return (
    batch_dir(commit_ci_dir, batch_label, tuning) /
    platform /
    # safer on windows
    configuration.replace(":","_") /
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
      tuning_search_dict = yaml.load(tuning_search)
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


def iter_recordings(groups, groups_file, database, default_configuration, config, globs=None, debug=False):
  """Returns an iterator over the (recording, configuration) from the selected groups
  params:
  - groups: array of group labels
  - groups_file: yaml file
  - configuration, is none is specified
  """
  if not globs:
    globs = config['inputs']['glob']
  if not isinstance(globs, tuple) and not isinstance(globs, list):
    globs = [globs]

  maybe_parent = lambda path: path.parent if config['inputs'].get('use_parent_folder', False) else path
  available_batches = yaml.load(Path(groups_file).open())
  for group in groups:
    if group not in available_batches:
      # Maybe we asked recordings from a location...
      # Have support for this makes test selection easier from the web UI,
      # because users don't have to define groups of tests all the time...
      location = group
      if debug:
        click.secho(str(location), bold=True, fg='cyan', err=True)
      
      for glob in globs:
        yield from set([(maybe_parent(f), default_configuration) for f in (database / location).rglob(glob)])
        if fnmatch.fnmatch(location, glob) or location.endswith(glob):
          yield maybe_parent(Path(database / location)), default_configuration
      return

    if available_batches[group] is None:
      continue

    if 'configuration' in available_batches[group]:
      group_configuration = available_batches[group]['configuration']
      if isinstance(group_configuration, list):
        group_configuration = ':'.join(group_configuration)
    else:
      group_configuration = default_configuration

    locations = available_batches[group]['tests']
    if not locations:
      click.secho(f"Warning: the selected group is empty ({group})", fg='yellow', err=True)
      continue

    if isinstance(locations, list):
      locations = {l: None for l in locations}

    for location, location_configuration in locations.items():
      if not location_configuration:
        location_configuration = group_configuration
      else:
        if isinstance(location_configuration, list):
          location_configuration = ':'.join(location_configuration)
        location_configuration = f'{group_configuration}:{location_configuration}'
      if debug:
        click.secho(str(database/location), bold=True, fg='cyan', err=True)

      for glob in globs:
        if fnmatch.fnmatch(location, glob) or location.endswith(glob):
          yield maybe_parent(Path(database / location)), location_configuration
        else:
          yield from set([(maybe_parent(f), location_configuration) for f in (database / location).rglob(glob)])




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


def iter_parameters(tuning_search=None, filetype='json', extra_parameters=None):
  extra_params = extra_parameters if extra_parameters else {}
  # http://scikit-learn.org/stable/modules/generated/sklearn.model_selection.ParameterSampler.html#sklearn.model_selection.ParameterSampler
  from sklearn.model_selection import ParameterGrid, ParameterSampler

  if not tuning_search:
    tuning_search = {
      'parameter_search': {},
      'search_type': 'grid',
    }

  if isinstance(tuning_search['parameter_search'], list):
    for param_search in tuning_search['parameter_search']:
      yield from iter_parameters(tuning_search={**tuning_search, 'parameter_search': param_search}, filetype=filetype, extra_parameters=extra_parameters)
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

  n_iter = tuning_search.get('search_options', {}).get('n_iter', 10)
  if tuning_search['search_type'] == 'grid':
    params_iterator = ParameterGrid(tuning_search['parameter_search'])
  elif tuning_search['search_type'] == 'sampler':
    params_iterator = ParameterSampler(tuning_search['parameter_search'], n_iter=n_iter)
  else:
    raise ValueError

  for counter, params_ in enumerate(params_iterator):
    if counter >= n_iter and n_iter > 0:
        click.secho(f"Stopping tuning combination after {n_iter} iterations", fg='yellow', err=True)
        return
    # the search overrides the extra parameters specified earlier
    params = {**extra_params, **params_}
    # we sort to avoid ordering issues; we want a unique hash per tuning configuration
    params_s = json.dumps(params, sort_keys=True)
    params_hash = make_hash(params)

    working_directory = Path('.') # can we do something smarter?
    params_file = working_directory / 'configurations' / 'tuning' / make_pretty_tuning_filename(params_s, filetype)
    params_file.parent.mkdir(parents=True, exist_ok=True)

    with params_file.open('w') as f:
      if filetype == 'json':
        f.write(params_s)
      elif filetype == 'yaml':
        yaml.dump(params, f)
      elif filetype == 'cde':
        from cde import Config
        config = Config()
        config.load_fromdict(config_dict)
        yaml.dump(params, f)
    yield params_file, params_hash, params
