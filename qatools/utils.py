"""
Misc utilities useful for qatools 
"""
import os
import re
import time
import json
import yaml
import fnmatch
import hashlib
from itertools import chain
from pathlib import Path
import shutil

import click

from .conventions import make_hash, make_pretty_tuning_filename


class PathType(click.ParamType):
  """Wrapper for pathlib's Path type, for use with the Click CLI package."""
  name = 'path'
  def convert(self, value, param, ctx):
    return Path(value)



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
    nb_files += 1
  except:
    time.sleep(0.01) # seconds
    try:
      _copy(src, destination)
    except: # wt...
      copy_data(src, destination)


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


def flatten(lst):
  if type(lst) not in (tuple, list):
    yield(lst)
    return
  yield from chain.from_iterable((flatten(x) for x in lst))
# list(flatten([1, [2], [3, 4, [5], [6, [7]]] ]))
# list(flatten([1, {"cde:" [2, 3]} ]))


def alias_groups(group, group_aliases):
  if type(group) not in (tuple, list):
    if group in group_aliases:
      yield from alias_groups(group_aliases.get(group), group_aliases)
    else:
      yield group
  else:
    yield from chain.from_iterable((alias_groups(x, group_aliases) for x in group))
# list(alias_groups(["ci", "xxxxx"], {"ci": ["a", "b"], "b": ["e", "f"]}))
# list(alias_groups(["branch-specific"],  {'chain': ['remosaic', 'hdr3', 'hdr-2'], 'branch-specific': ['small-group']}))

def iter_recordings(groups, groups_file, database, default_configuration, default_lsf_configuration, qatools_config, globs=None, debug=False):
  """Returns an iterator over the (recording, configurations, lsf-configuration) from the selected groups
  params:
  - groups: array of group labels
  - groups_file: path to a yaml file, or an array of paths
  - configuration, is none is specified
  """
  if not globs:
    globs = qatools_config.get('inputs', {}).get('glob', [])
    if not globs:
      click.secho(f'WARNING: Could not find how to identify input tests.', fg='yellow', err=True)
      click.secho(f'Consider adding to qatools.yaml somelike like:\n```\ninputs:\n  glob: *.hex\n```', fg='yellow', err=True, dim=True)

  if not isinstance(globs, tuple) and not isinstance(globs, list):
    globs = [globs]

  if not (isinstance(groups_file, list) or isinstance(groups_file, tuple)):
    groups_file = [groups_file]
  available_batches = {}
  for p in groups_file:
    available_batches.update(yaml.load(Path(p).open()))

  # for convenience, users can define "groups of groups"
  group_aliases = available_batches.get('groups', {})
  groups = alias_groups(groups, group_aliases)

  maybe_parent = lambda path: path.parent if qatools_config['inputs'].get('use_parent_folder', False) else path
  for group in groups:
    # We can ask for two types of groups:
    # 1. All tests under a given folder in the database
    if group not in available_batches:
      # Maybe we asked recordings from a location... Having support for this makes test selection.
      location = group
      if debug or True:
        click.secho(str(location), bold=True, fg='cyan', err=True)
      
      for glob in globs:
        for matched_location in database.glob(location):
          rglob = '**/' + glob
          tests = set([maybe_parent(f) for f in matched_location.rglob(glob)])
          yield from [(test, default_configuration, default_lsf_configuration, database) for test in tests]

          if fnmatch.fnmatch(matched_location, rglob) or str(matched_location).endswith(glob):
            yield maybe_parent(matched_location), default_configuration, default_lsf_configuration, database
      return

    # 2. Those defined in the groups_file
    if available_batches[group] is None: continue
    locations = available_batches[group]['tests']
    if not locations:
      click.secho(f"Warning: the selected group is empty ({group})", fg='yellow', err=True)
      continue

    # Each group can define his own default runtime and LSF configuration
    group_lsf_configuration = {**default_lsf_configuration, **available_batches[group].get('lsf', {})}
    group_configuration = available_batches[group].get('configuration', default_configuration)
    group_configuration = flatten(group_configuration)
    group_database = Path(available_batches[group].get('database', {}).get('windows' if os.name=='nt' else 'linux', database))

    # We also allow each test to have his own configuration...
    if isinstance(locations, list):
      locations = {l: None for l in locations}

    for location, location_configuration in locations.items():
      if not location_configuration:
        location_configuration = group_configuration
        location_database = group_database
        location_lsf_configuration = group_lsf_configuration
      else:
        if isinstance(location_configuration, dict):
          location_lsf_configuration = {**group_lsf_configuration, **location_configuration.get('lsf', {})}
          location_database = Path(location_configuration.get('database', {}).get('windows' if os.name=='nt' else 'linux', database))
          location_configuration = [*group_configuration, *location_configuration.get('configuration', [])]
        elif isinstance(location_configuration, list):
          location_configuration = flatten(location_configuration)
          location_configuration = [*group_configuration, *location_configuration]
          location_database = group_database
          location_lsf_configuration = group_lsf_configuration
        else:
          location_configuration =  [*group_configuration, location_configuration]
          location_database = group_database
          location_lsf_configuration = group_lsf_configuration
      if debug:
        click.secho(str(location_database / location), bold=True, fg='cyan', err=True)

      for glob in globs:
        if fnmatch.fnmatch(location, glob) or location.endswith(glob):
          yield maybe_parent(Path(location_database / location)), location_configuration, location_lsf_configuration, location_database
        else:
          tests = set([maybe_parent(f) for f in (location_database / location).rglob(glob)])
          yield from [(test, location_configuration, location_lsf_configuration, location_database) for test in tests]



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
