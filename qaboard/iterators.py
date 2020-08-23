"""
Iterators over inputs, parameters...
"""
import os
import re
import sys
import json
import numbers
import fnmatch
import traceback
from copy import copy
from pathlib import Path
from itertools import chain
from dataclasses import replace
from typing import List, Union, Dict, Tuple, Iterator, cast

import yaml
import click

from .conventions import make_hash, make_pretty_tuning_filename, get_settings, location_from_spec
from .utils import input_metadata, entrypoint_module
from .compat import cased_path
from .run import RunContext


def flatten(lst: Union[str, List, Tuple]) -> Iterator[Union[str, List, Tuple]]:
  if isinstance(lst, tuple) or isinstance(lst, list):
    yield from chain.from_iterable((flatten(x) for x in lst))
  else: # type==str
    yield(lst)


def resolve_aliases(names : Union[str, List[str], Tuple[str, ...]], aliases: Dict[str, List[str]], depth=10) -> Iterator[Union[str, List[str], Tuple[str, ...]]]:
  # TODO: Expose an API that -> Iterator[str], after all the recursive calls.
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
    if 'QA_BATCH_FAIL_IF_EMPTY' in os.environ:
      click.secho(f'ERROR: No inputs found for the batch "{path}"', fg='red', err=True)
      raise ValueError 
    else:
      click.secho(f'WARNING: No inputs found for the batch "{path}"', fg='yellow', err=True)
      return

  if not globs:
    yield from ((i, database) for i in input_paths)
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
        yield i, database

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
    if 'QA_BATCH_FAIL_IF_EMPTY' in os.environ:
      click.secho(f'ERROR: No inputs found matching "{path}" under "{database}".', fg='red', err=True)
      raise ValueError 
    else:
      click.secho(f'WARNING: No inputs found matching "{path}" under "{database}".', fg='yellow', err=True)


def _iter_inputs(path, database, inputs_settings, qatools_config, only=None, exclude=None):
  if path and Path(path).is_absolute():
    database_str, *path_parts =  Path(path).parts
    path = Path(*path_parts)
    database = Path(database_str)
  entrypoint_module_ = entrypoint_module(qatools_config)
  if hasattr(entrypoint_module_, 'iter_inputs'):
    try:
      iter_inputs = entrypoint_module_.iter_inputs(path, database, only, exclude, inputs_settings)
      # we filter twice just in case
      iter_inputs_filtered = (i for i in iter_inputs if (not only or match(i["metadata"], only)) and (not exclude or not match(i["metadata"], exclude)))
      yield from ( (i["input_path"], i["database"]) for i in iter_inputs_filtered)
      # we really could send a batch update to /our/ database here with all the metadata?
    except Exception as e:
      exc_type, exc_value, exc_traceback = sys.exc_info()
      click.secho(f'[ERROR] The `iter_inputs` function in your entrypoint raised an exception:', fg='red', bold=True, err=True)
      click.secho(''.join(traceback.format_exception(exc_type, exc_value, exc_traceback)), fg='red', err=True)
    return

  globs = inputs_settings.get('globs', inputs_settings.get('glob'))
  if not globs:
    pass
  elif not isinstance(globs, tuple) and not isinstance(globs, list):
    globs = [globs]
  use_parent_folder = inputs_settings.get('use_parent_folder', False)
  yield from iter_inputs_at_path(path, database, globs, use_parent_folder, qatools_config, only=only, exclude=exclude)



def iter_inputs(batches: List[str], batches_files: List[os.PathLike], default_database: Path, default_configurations: List, default_platform: str, default_job_configuration, qatools_config, default_inputs_settings=None, debug=os.environ.get('QA_DEBUG_ITER_INPUTS', False)):
  """
  Returns an iterator over the (input_path, configurations, runner-configuration) from the selected batches
  # TODO: allow changing the entrypoint per-batch
  """
  available_batches: Dict = {}
  for batches_file in batches_files:
    try:
      new_batches = yaml.load(open(batches_file), Loader=yaml.SafeLoader)
    except Exception as e:
      click.secho(f"ERROR: Invalid YAML: {batches_file}", err=True)
      raise e
    if new_batches and isinstance(new_batches, dict):
      # deep-merge the aliases
      old_aliases = available_batches.get('aliases', {})
      new_aliases = new_batches.get('aliases', new_batches.get('groups', {}))
      available_batches.update(new_batches)
      available_batches['aliases'] = {**old_aliases, **new_aliases}
  if debug:
    click.secho(str(available_batches), dim=True, err=True)

  batch_aliases = available_batches.get('aliases', {})
  batches = list(resolve_aliases(batches, batch_aliases)) # type: ignore
  if not batches:
    if 'QA_BATCH_FAIL_IF_EMPTY' in os.environ:
      click.secho(f'ERROR: No batch was chosen.', fg='red', err=True)
      raise ValueError 
    else:
      click.secho(f'WARNING: No batch was chosen.', fg='yellow', err=True)

  if not default_inputs_settings:
    inputs_settings = get_settings(qatools_config.get('inputs', {}).get('types', {}).get('default', 'default'), qatools_config)
  else:
    inputs_settings = copy(default_inputs_settings)
  run_context = RunContext(
    input_path=Path(),
    database=default_database,
    configurations=default_configurations,
    platform=default_platform,
    job_options=default_job_configuration,
    type=inputs_settings['type']
  )

  for batch in batches:
    if debug: click.secho(f'batch: {batch}', dim=True, err=True)

    # We can ask for two types of batches:
    # 1. All inputs under a given folder in the database
    if batch not in available_batches:
      # Maybe we asked recordings from a location...
      if debug: click.secho(str(batch), bold=True, fg='cyan', err=True)
      inputs_iter = _iter_inputs(batch, run_context.database, inputs_settings, qatools_config)
      yield from (replace(run_context, input_path=i, database=d) for i, d in inputs_iter)
    else:
      yield from iter_batch(available_batches[batch], run_context, qatools_config, inputs_settings, debug)


def deep_interpolate(value, replaced: str, to_value):
  if isinstance(value, dict):
    return {k: deep_interpolate(v, replaced, to_value) for k, v in value.items()}
  elif isinstance(value, list):
    return [deep_interpolate(v, replaced, to_value) for v in value]
  elif isinstance(value, str):
    if value == replaced:
      return to_value
    else:
      return value.replace(replaced, str(to_value))
  else:
    return value


def iter_batch(batch: Dict, default_run_context: RunContext, qatools_config, default_inputs_settings, debug):
    # Happens often when there is an orphan "my-batch:" in in the yaml file
    if batch is None:
      return

    run_context = copy(default_run_context)
    run_context.configurations = batch.get('configs', batch.get('configurations', batch.get('configuration', run_context.configurations)))
    run_context.configurations = list(flatten(run_context.configurations))
    if 'platform' in batch:
      run_context.platform = batch['platform']
    runner = run_context.job_options.get('type', 'local')
    if batch.get(runner):
      run_context.job_options = {**run_context.job_options, **batch[runner]}

    if 'type' in batch:
      run_context.type = batch['type']
      inputs_settings = get_settings(batch['type'], qatools_config)
      from .config import get_default_database
      run_context.database = get_default_database(inputs_settings)
    else:
      inputs_settings = copy(default_inputs_settings)
    inputs_settings.update(batch)

    batch_database = location_from_spec(batch.get('database', run_context.database))
    if batch_database:
      run_context.database = batch_database
    if batch.get('matrix'):
      from sklearn.model_selection import ParameterGrid
      for matrix in ParameterGrid(batch['matrix']):
        batch_ = copy(batch)
        for key in ['matrix', 'configuration', 'configurations', 'configs', 'platform']:
          if key in batch:
            del batch_[key]
        matrix_run_context = copy(run_context)
        if 'platform' in matrix:
          matrix_run_context.platform = matrix['platform']
        if 'configuration' in matrix:
          matrix_run_context.configurations = matrix['configuration']
        if 'configurations' in matrix:
          matrix_run_context.configurations = matrix['configurations']
        if 'configs' in matrix:
          matrix_run_context.configurations = matrix['configs']
        for param, value in matrix.items():
          if param in ['configuration', 'configurations', 'configs', 'platform']:
            continue
          matrix_run_context.configurations = deep_interpolate(matrix_run_context.configurations, '${matrix.%s}' % param, value)
        yield from iter_batch(batch_, matrix_run_context, qatools_config, default_inputs_settings, debug)
      return

    locations = batch.get('inputs', batch.get('tests'))
    if not locations:
      inputs_iter = _iter_inputs(None, run_context.database, inputs_settings, qatools_config, only=batch.get('only'), exclude=batch.get('exclude'))
      yield from (replace(run_context, input_path=i, database=d) for i, d in inputs_iter)
      return

    # We also allow each input to have its settings...
    if isinstance(locations, list):
      locations_as_dict: Dict = {}
      for l in locations:
        if l in locations:
          if not isinstance(l, dict):
            locations_as_dict[l] = None
          else:
            locations_as_dict.update(l)
      locations = locations_as_dict

    for location, location_configurations in locations.items():
      location_run_context = copy(run_context)
      location_inputs_settings = inputs_settings
      if location_configurations:
        if isinstance(location_configurations, dict):
          if location_configurations.get(runner):
            location_run_context.job_options = {**location_run_context.job_options, **location_configurations[runner]}
          if 'database' in location_configurations:
            location_database = location_from_spec(location_configurations['database'])
            if location_database:
              location_run_context.database = location_database
          if 'platform' in batch:
            location_run_context.platform = location_configurations['platform']
          location_inputs_settings = copy(inputs_settings)
          if 'type' in location_configurations:
            location_run_context.type = location_configurations['type']
            location_inputs_settings = get_settings(location_run_context.type, qatools_config)
          location_inputs_settings.update(location_configurations) # todo: only the keys below
          for k in ['type', 'database', runner, 'platform', 'glob', 'globs', 'use_parent_folder']:
            if k in location_configurations:
              del location_configurations[k]
          if location_configurations and 'configs' not in location_configurations and 'configurations' not in location_configurations and 'configurations' not in location_configurations:
            location_run_context.configurations = [*location_run_context.configurations, location_configurations]
          else:
            patch_config = location_configurations.get('configs', location_configurations.get('configurations', location_configurations.get('configuration', [])))
            location_run_context.configurations = [*location_run_context.configurations, *patch_config]
        elif isinstance(location_configurations, list):
          location_run_context.configurations = [*location_run_context.configurations, *list(flatten(location_configurations))]
        else: # string?
          location_run_context.configurations =  [*location_run_context.configurations, location_configurations]
      if debug: click.secho(str(location_run_context.database / location), bold=True, fg='cyan', err=True)
      inputs_iter = _iter_inputs(location, location_run_context.database, location_inputs_settings, qatools_config, only=batch.get('only'), exclude=batch.get('exclude'))
      yield from (replace(location_run_context, input_path=i, database=d) for i, d in inputs_iter)




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
        elif filetype == 'yaml' or filetype == 'yml':
          yaml.dump(params, f)
        else:
          raise ValueError(f"{params_file} should be json/yaml")
    yield params_file, params_hash, params
