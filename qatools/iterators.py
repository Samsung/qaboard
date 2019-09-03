"""
Iterators over inputs, parameters...
"""
import os
import sys
import re
import fnmatch
import traceback
from pathlib import Path
from itertools import chain
import numbers
import json

import yaml
import click

from .conventions import make_hash, make_pretty_tuning_filename
from .utils import input_metadata, entrypoint_module




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



def match(value, value_filter):
  # print('match:', value, 'vs', value_filter)
  if isinstance(value_filter, list):
    return any([match(value, e) for e in value_filter])
  elif isinstance(value_filter, str):
    number_spec = re.match(r'(==?|<=?|>=?)(.*)', value_filter)
    if number_spec:
      if not isinstance(value, numbers.Number):
        return False
      operator, value_filter = number_spec.groups()
      value_filter = float(value_filter)
      if operator in ['=', '==']: return value == value_filter
      if operator == '>=': return value >= value_filter
      if operator == '<=': return value <= value_filter
      if operator == '>': return value > value_filter
      if operator == '>': return value > value_filter
      return False
    else:
      return fnmatch.fnmatch(value, value_filter)
  elif isinstance(value_filter, dict):
    if value_filter and not value: return False
    return all([match(value.get(k), value_filter[k]) for k,v in value_filter.items()])
  else: # bool, number...
    return value == value_filter


def iter_inputs_at_path(path, database, globs, use_parent_folder, qatools_config, only=None, exclude=None):
  if not path:
    path = "*"

  maybe_parent = lambda path: path.parent if use_parent_folder else path
  input_paths = list(database.glob(path)) # to support wildcards
  if not input_paths:
    click.secho(f"Warning: no inputs for <{path}>.", fg='yellow', err=True)
    return

  for glob in globs:
    for input_path in input_paths:
      print(input_path, glob)
      inputs = set([maybe_parent(f) for f in input_path.rglob(glob)]) # | \
               # set([maybe_parent(f) for f in input_path.rglob(f'**/{glob}')])
      if only:
        inputs = [i for i in inputs if match(input_metadata(i, database, i.relative_to(database), qatools_config), only)]
      if exclude:
        inputs = [i for i in inputs if not match(input_metadata(i, database, i.relative_to(database), qatools_config), exclude)]
      yield from inputs
      if fnmatch.fnmatch(input_path, f'*/{glob}') or str(input_path).endswith(glob):
        metadata = input_metadata(input_path, database, input_path.relative_to(database), qatools_config)
        if only and not match(metadata, only): continue
        if exclude and match(metadata, exclude): continue
        yield input_path


def _iter_inputs(path, database, globs, use_parent_folder, qatools_config, only=None, exclude=None):
  entrypoint_module_ = entrypoint_module(qatools_config)
  if hasattr(entrypoint_module_, 'iter_inputs'):
    try:
      iter_inputs = entrypoint_module_.iter_inputs(path, database, only, exclude)
      # we filter twice just in case
      iter_inputs_filtered = (i for i in iter_inputs if (not only or match(i["metadata"], only)) and (not exclude or not match(i["metadata"], exclude)))
      yield from (i["absolute_input_path"] for i in iter_inputs_filtered)
      # we really could send a batch update to /our/ database here with all the metadata?
    except Exception as e:
      exc_type, exc_value, exc_traceback = sys.exc_info()
      click.secho(f'[ERROR] The `iter_inputs` function in your entrypoint raised an exception:', fg='red', bold=True)
      click.secho(''.join(traceback.format_exception(exc_type, exc_value, exc_traceback)), fg='red')
    return
  yield from iter_inputs_at_path(path, database, globs, use_parent_folder, qatools_config, only=None, exclude=None)



def iter_inputs(groups, groups_file, database, default_configuration, default_lsf_configuration, qatools_config, globs=None, debug=os.environ.get('QATOOLS_DEBUG', False)):
  """Returns an iterator over the (input_path, configurations, lsf-configuration) from the selected groups
  params:
  - groups: array of group names or paths whose inputs you want to iterate
  - groups_file: path to a yaml file, or an array of paths
  - config: is none is specified
  """
  if not globs:
    globs = qatools_config.get('inputs', {}).get('glob', [])
    if not globs:
      click.secho(f'WARNING: Could not find how to identify inputs.', fg='yellow', err=True)
      click.secho(f'Consider adding to qatools.yaml somelike like:\n```\ninputs:\n  glob: *.hex\n```', fg='yellow', err=True, dim=True)

  if not isinstance(globs, tuple) and not isinstance(globs, list):
    globs = [globs]

  if not (isinstance(groups_file, list) or isinstance(groups_file, tuple)):
    groups_file = [groups_file]
  available_batches = {}
  for p in groups_file:
    new_batches = yaml.load(Path(p).open(), Loader=yaml.SafeLoader)
    if new_batches and isinstance(new_batches, dict):
      old_groups = available_batches.get('groups', {})
      new_groups = new_batches.get('groups', {})
      available_batches.update(new_batches)
      available_batches['groups'] = {**old_groups, **new_groups}

  if debug: click.secho(str(available_batches), dim=True)
  # for convenience, users can define "groups of groups"
  group_aliases = available_batches.get('groups', {})
  groups = list(alias_groups(groups, group_aliases))

  if not groups:
    click.secho(f'WARNING: No group chosen.', fg='yellow', err=True)

  for group in groups:
    if debug: click.secho(f'group: {group}', dim=True)

    # We can ask for two types of groups:
    # 1. All inputs under a given folder in the database
    if group not in available_batches:
      # Maybe we asked recordings from a location...
      if debug: click.secho(str(group), bold=True, fg='cyan', err=True)
      inputs_iter = _iter_inputs(group, database, globs, qatools_config['inputs'].get('use_parent_folder', False), qatools_config)
      yield from ((i, default_configuration , default_lsf_configuration, database) for i in inputs_iter)
      return

    # 2. Those defined in the groups_file
    if available_batches[group] is None: continue # happens when there is an orphan "$group:" in in the yaml...
    group_only = available_batches[group].get('only')
    group_exclude = available_batches[group].get('exclude')
    # Each group can define his own default runtime and LSF configuration
    group_lsf_configuration = {**default_lsf_configuration, **available_batches[group].get('lsf', {})}
    group_configuration = available_batches[group].get('configurations', available_batches[group].get('configuration', default_configuration))
    group_configuration = list(flatten(group_configuration))
    group_database = Path(available_batches[group].get('database', {}).get('windows' if os.name=='nt' else 'linux', database))
    group_globs = available_batches[group].get('globs', globs)
    locations = available_batches[group].get('inputs', available_batches[group].get('tests'))
    if not locations:
      if not group_only and not group_exclude:
        click.secho(f"Warning: the selected group is empty ({group})", fg='yellow', err=True)
        continue
      else:
        # run all inputs matching only/exclude
        inputs_iter = _iter_inputs(None, group_database, group_globs, qatools_config['inputs'].get('use_parent_folder', False), qatools_config, only=group_only, exclude=group_exclude)
        yield from ((i, group_configuration, group_lsf_configuration, group_database) for i in inputs_iter)
        return

    # We also allow each input to have its settings...
    if isinstance(locations, list):
      locations_as_dict = {}
      for l in locations:
        if l in locations:
          if not isinstance(l, dict):
            locations_as_dict[l] = None
          else:
            locations_as_dict.update(l)
      locations = locations_as_dict

    if not locations: # return everything
      inputs_iter = _iter_inputs(None, group_database, group_globs, qatools_config['inputs'].get('use_parent_folder', False), qatools_config, only=group_only, exclude=group_exclude)
      yield from ((i, group_configuration, group_lsf_configuration, group_database) for i in inputs_iter)
      return

    for location, location_configuration in locations.items():
      if not location_configuration:
        location_configuration = group_configuration
        location_database = group_database
        location_globs = group_globs
        location_lsf_configuration = group_lsf_configuration
      else:
        if isinstance(location_configuration, dict):
          location_lsf_configuration = {**group_lsf_configuration, **location_configuration.get('lsf', {})}
          location_database = Path(location_configuration.get('database', {}).get('windows' if os.name=='nt' else 'linux', group_database))
          location_globs = location_configuration.get('globs', group_globs)
          for k in ['lsf', 'globs', 'database']:
            if k in location_configuration:
              del location_configuration[k]
          if 'configuration' not in location_configuration:
            location_configuration = [*group_configuration, location_configuration]
          else:
            location_configuration = [*group_configuration, *location_configuration.get('configuration', [])]
        elif isinstance(location_configuration, list):
          location_configuration = list(flatten(location_configuration))
          location_configuration = [*group_configuration, *location_configuration]
          location_globs = group_globs
          location_database = group_database
          location_lsf_configuration = group_lsf_configuration
        else:
          location_configuration =  [*group_configuration, location_configuration]
          location_globs = group_globs
          location_database = group_database
          location_lsf_configuration = group_lsf_configuration
      if debug: click.secho(str(location_database / location), bold=True, fg='cyan', err=True)
      inputs_iter = _iter_inputs(location, location_database, location_globs, qatools_config['inputs'].get('use_parent_folder', False), qatools_config, only=group_only, exclude=group_exclude)
      yield from ((i, location_configuration, location_lsf_configuration, location_database) for i in inputs_iter)




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

  n_iter = tuning_search.get('search_options', {}).get('n_iter')
  if tuning_search['search_type'] == 'grid':
    params_iterator = ParameterGrid(tuning_search['parameter_search'])
  elif tuning_search['search_type'] == 'sampler':
    params_iterator = ParameterSampler(tuning_search['parameter_search'], n_iter=n_iter)
  else:
    raise ValueError

  for counter, params_ in enumerate(params_iterator):
    if n_iter and counter >= n_iter and n_iter > 0:
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
