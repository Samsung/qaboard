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

from typing import List, Union, Dict, Tuple, Iterator, cast

import yaml
import click

from .conventions import make_hash, make_pretty_tuning_filename, get_settings
from .utils import input_metadata, entrypoint_module
from .compat import cased_path
from .run import RunContext


def flatten(lst: Union[str, List, Tuple]) -> Iterator[Union[str, List, Tuple]]:
  if isinstance(lst, tuple) or isinstance(lst, list):
    yield from chain.from_iterable((flatten(x) for x in lst))
  else: # type==str
    yield(lst)


def resolve_aliases(names : Union[str, List[str], Tuple[str, ...]], aliases: Dict[str, List[str]], depth=10) -> Iterator[Union[str, List[str], Tuple[str, ...]]]:
  if not depth:
    yield from chain.from_iterable(names)
  if isinstance(names, tuple) or isinstance(names, list):
    yield from chain.from_iterable((resolve_aliases(n, aliases, depth-1) for n in names))
  else: # type==str
    if names in aliases:
      yield from resolve_aliases(aliases[names], aliases, depth-1)
    else:
      yield names



def match(value, value_filter) -> bool:
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
      return fnmatch.fnmatch(value.casefold(), value_filter.casefold())
  elif isinstance(value_filter, dict):
    if value_filter and not value: return False
    return all([match(value.get(k,""), value_filter[k]) for k,v in value_filter.items()])
  else: # bool, number...
    return value == value_filter


def iter_inputs_at_path(path, database, globs, use_parent_folder, qatools_config, only=None, exclude=None):
  if not path:
    path = "*"

  maybe_parent = lambda path: path.parent if use_parent_folder else path
  input_paths = list(database.glob(str(path))) # to support wildcards
  if not input_paths:
    click.secho(f'Warning: No inputs found for the batch "{path}"', fg='yellow', err=True)
    return

  if not globs:
    yield from input_paths
    return

  nb_inputs = 0
  for glob in globs:
    for input_path in input_paths:
      input_path = cased_path(input_path)
      inputs = set([maybe_parent(f) for f in input_path.rglob(glob)])
      inputs = [cased_path(i) for i in inputs] # fix case issues on Windows
      if fnmatch.fnmatch(input_path, f'*/{glob}') or str(input_path).endswith(glob):
        inputs.append(cased_path(input_path))
      for i in inputs:
        if only or exclude:
          metadata = input_metadata(i, database, i.relative_to(database), qatools_config)
          if only:
            if not match(metadata, only): continue
          if exclude:
            if metadata:
              if match(metadata, exclude): continue
            if match(os.path.basename(i), exclude): continue
        nb_inputs += 1
        yield i

  #     if only:
  #       inputs = [i for i in inputs if match(input_metadata(i, database, i.relative_to(database), qatools_config), only)]
  #     if exclude:
  #       inputs = [i for i in inputs if not match(input_metadata(i, database, i.relative_to(database), qatools_config), exclude)]
  #     for i in inputs:
  #       nb_inputs += 1
  #       yield i
  #     if fnmatch.fnmatch(input_path, f'*/{glob}') or str(input_path).endswith(glob):
  #       metadata = input_metadata(input_path, database, input_path.relative_to(database), qatools_config)
  #       if only and not match(metadata, only): continue
  #       if exclude and match(metadata, exclude): continue
  #       nb_inputs += 1
  #       yield input_path

  if not nb_inputs:
    click.secho(f'Warning: No inputs found matching "{path}" under "{database}".', fg='yellow', err=True)


def _iter_inputs(path, database, inputs_settings, qatools_config, only=None, exclude=None):
  if path and Path(path).is_absolute():
    click.secho(f"[ERROR] Inputs are only allowed to be relative paths.", fg='red', bold=True)
    click.secho(f'Please split "{path}" into a "database" and a relative path.', fg='red')
    raise ValueError
  entrypoint_module_ = entrypoint_module(qatools_config)
  if hasattr(entrypoint_module_, 'iter_inputs'):
    try:
      iter_inputs = entrypoint_module_.iter_inputs(path, database, only, exclude, inputs_settings)
      # we filter twice just in case
      iter_inputs_filtered = (i for i in iter_inputs if (not only or match(i["metadata"], only)) and (not exclude or not match(i["metadata"], exclude)))
      yield from (i["absolute_input_path"] for i in iter_inputs_filtered)
      # we really could send a batch update to /our/ database here with all the metadata?
    except Exception as e:
      exc_type, exc_value, exc_traceback = sys.exc_info()
      click.secho(f'[ERROR] The `iter_inputs` function in your entrypoint raised an exception:', fg='red', bold=True, err=True)
      click.secho(''.join(traceback.format_exception(exc_type, exc_value, exc_traceback)), fg='red', err=True)
    return

  globs = inputs_settings.get('globs', inputs_settings.get('glob'))
  if not globs:
    click.secho(f'ADVICE: Tell us how to identify inputs. You will be able to `qa batch` on all inputs under a given folder.', fg='cyan', err=True)
    click.secho(f'Consider adding to qaboard.yaml something like:\n```\ninputs:\n  globs: "*.bmp"\n```', fg='cyan', err=True, dim=True)
  elif not isinstance(globs, tuple) and not isinstance(globs, list):
    globs = [globs]
  use_parent_folder = inputs_settings.get('use_parent_folder', False)
  yield from iter_inputs_at_path(path, database, globs, use_parent_folder, qatools_config, only=only, exclude=exclude)



def iter_inputs(groups, groups_file, database, default_configuration, default_platform, default_job_configuration, qatools_config, inputs_settings=None, debug=os.environ.get('QA_DEBUG_ITER_INPUTS', False)):
  """Returns an iterator over the (input_path, configurations, runner-configuration) from the selected groups
  params:
  - groups: array of group names or paths whose inputs you want to iterate
  - groups_file: path to a yaml file, or an array of paths
  - config: is none is specified
  """
  # FIXME: can't change platform/entrypoint per-batch

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

  if not inputs_settings:
    inputs_settings = get_settings(qatools_config.get('inputs', {}).get('types', {}).get('default', 'default'), qatools_config)
  else:
    from copy import copy
    inputs_settings = copy(inputs_settings)

  if debug: click.secho(str(available_batches), dim=True)
  # for convenience, users can define "groups of groups"
  group_aliases = available_batches.get('groups', {})
  groups = list(resolve_aliases(groups, group_aliases))

  runner = default_job_configuration.get('type', 'local')

  if not groups:
    click.secho(f'WARNING: No group chosen.', fg='yellow', err=True)

  for group in groups:
    if debug: click.secho(f'group: {group}', dim=True)

    # We can ask for two types of groups:
    # 1. All inputs under a given folder in the database
    if group not in available_batches:
      # Maybe we asked recordings from a location...
      if debug: click.secho(str(group), bold=True, fg='cyan', err=True)
      inputs_iter = _iter_inputs(group, database, inputs_settings, qatools_config)
      yield from (RunContext(input_path=i, database=database, configurations=default_configuration, platform=default_platform, job_options=default_job_configuration, type=inputs_settings['type']) for i in inputs_iter)
      return

    # 2. Those defined in the groups_file
    if available_batches[group] is None: continue # happens when there is an orphan "$group:" in in the yaml...
    group_only = available_batches[group].get('only')
    group_exclude = available_batches[group].get('exclude')
    group_platform = available_batches[group].get('platform', default_platform)
    # Each group can define his own default runtime and runner configuration
    group_job_configuration = {**default_job_configuration, **available_batches[group].get(runner, {})}
    group_configuration = available_batches[group].get('configurations', available_batches[group].get('configuration', default_configuration))
    group_configuration = list(flatten(group_configuration))
    group_database = Path(available_batches[group].get('database', {}).get('windows' if os.name=='nt' else 'linux', database))
    if 'type' in available_batches[group]:
      group_type = available_batches[group]['type']
      group_inputs_settings = get_settings(group_type, qatools_config)
    else:
      group_inputs_settings = inputs_settings
    group_inputs_settings.update(available_batches[group])
    locations = available_batches[group].get('inputs', available_batches[group].get('tests'))
    if not locations:
      # run all inputs matching only/exclude
      inputs_iter = _iter_inputs(None, group_database, group_inputs_settings, qatools_config, only=group_only, exclude=group_exclude)
      yield from (RunContext(input_path=i, database=group_database, configurations=group_configuration, platform=group_platform, job_options=group_job_configuration, type=group_inputs_settings['type']) for i in inputs_iter)
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

    for location, location_configuration in locations.items():
      if not location_configuration:
        location_platform = group_platform
        location_configuration = group_configuration
        location_database = group_database
        location_job_configuration = group_job_configuration
        location_inputs_settings = group_inputs_settings
      else:
        if isinstance(location_configuration, dict):
          location_job_configuration = {**group_job_configuration, **location_configuration.get(runner, {})}
          location_database = Path(location_configuration.get('database', {}).get('windows' if os.name=='nt' else 'linux', group_database))
          if 'type' in location_configuration:
            location_type = location_configuration['type']
            location_inputs_settings = get_settings(location_type, qatools_config)
          else:
            location_inputs_settings = group_inputs_settings
          location_inputs_settings.update(location_configuration)
          for k in ['type', 'database', runner, 'platform', 'glob', 'globs', 'use_parent_folder']:
            if k in location_configuration:
              del location_configuration[k]
          if 'configurations' not in location_configuration and 'configurations' not in location_configuration:
            location_configuration = [*group_configuration, location_configuration]
          else:
            patch_config = location_configuration.get('configurations', location_configuration.get('configuration', []))
            location_configuration = [*group_configuration, *patch_config]
        elif isinstance(location_configuration, list):
          location_configuration = list(flatten(location_configuration))
          location_configuration = [*group_configuration, *location_configuration]
          location_platform = group_platform
          location_database = group_database
          location_job_configuration = group_job_configuration
          location_inputs_settings = group_inputs_settings
        else: # string?
          location_platform = group_platform
          location_configuration =  [*group_configuration, location_configuration]
          location_database = group_database
          location_job_configuration = group_job_configuration
          location_inputs_settings = group_inputs_settings
      if debug: click.secho(str(location_database / location), bold=True, fg='cyan', err=True)
      inputs_iter = _iter_inputs(location, location_database, location_inputs_settings, qatools_config, only=group_only, exclude=group_exclude)
      yield from (RunContext(input_path=i, database=location_database, configurations=location_configuration, platform=location_platform, job_options=location_job_configuration, type=location_inputs_settings['type']) for i in inputs_iter)




def iter_parameters(tuning_search=None, filetype='json', extra_parameters=None):
  extra_params = extra_parameters if extra_parameters else {}
  if not tuning_search:
    tuning_search = {
      'parameter_search': {},
      'search_type': 'grid',
    }

  if isinstance(tuning_search['parameter_search'], list):
    for param_search in tuning_search['parameter_search']:
      yield from iter_parameters(tuning_search={**tuning_search, 'parameter_search': param_search}, filetype=filetype, extra_parameters=extra_parameters)
    return

  parameter_search = tuning_search['parameter_search']

  ## Support for functions/ranges was removed - no one ever used them.
  # for parameter, values in parameter_search.items():
  #   if isinstance(values, dict):
  #     if not 'function' in values or not 'arguments' in values:
  #       raise ValueError
  #     if values['function'] == 'range':
  #       args = values['arguments']
  #       if 'start' not in args: args['start']=0
  #       if 'stop' not in args: args['stop']=0
  #       if 'step' not in args: args['step']=1
  #       tuning_search[parameter] = list(range(args['start'], args['stop'], args['step']))

  n_iter = tuning_search.get('search_options', {}).get('n_iter')
  if not parameter_search:
    params_iterator = [{}]
  elif tuning_search['search_type'] == 'grid':
    # http://scikit-learn.org/stable/modules/generated/sklearn.model_selection.ParameterSampler.html#sklearn.model_selection.ParameterSampler
    from sklearn.model_selection import ParameterGrid
    # from search import ParameterGrid
    params_iterator = ParameterGrid(parameter_search)
  elif tuning_search['search_type'] == 'sampler':
    from sklearn.model_selection import ParameterSampler
    # from search import ParameterSampler
    params_iterator = ParameterSampler(parameter_search, n_iter=n_iter)
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

    if params:
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
