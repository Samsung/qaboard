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
from copy import deepcopy
from pathlib import Path
from itertools import chain, product
from dataclasses import replace
from contextlib import contextmanager
from contextvars import ContextVar
from typing import List, Union, Dict, Tuple, Iterator, Any, Optional, cast

import yaml
import click

from .conventions import pretty_hash, get_settings, location_from_spec
from .utils import input_metadata, entrypoint_module
from .compat import cased_path
from .run import RunContext


# Keys of batch files that are settings for their batches, not batches
BATCH_FILE_SETTINGS = ('database', 'aliases', 'groups', 'configs', 'configurations', 'platform', 'matrix')

# The inputs we looked for without finding them, for callers that explain why a batch has no tests (the server)
_missing_inputs: ContextVar[Optional[List[Dict[str, Any]]]] = ContextVar('missing_inputs', default=None)

@contextmanager
def recording_missing_inputs():
  """While iterating over inputs, collects the inputs that were not found: [{"input", "database", "globs"?}]."""
  missing: List[Dict[str, Any]] = []
  token = _missing_inputs.set(missing)
  try:
    yield missing
  finally:
    _missing_inputs.reset(token)

def _record_missing_input(path, database, globs=None):
  missing = _missing_inputs.get()
  if missing is not None:
    missing.append({"input": str(path) if path else "*", "database": str(database), **({"globs": [str(g) for g in globs]} if globs else {})})


class BatchError(click.ClickException, ValueError):
  """
  A batch definition we can't use. `qa batch` prints "Error: <message>", the server shows the message.
  `input_index` is the position of the faulty input in the batch's inputs, to find its line.
  """
  def __init__(self, message, batch=None, input_index=None):
    super().__init__(message)
    self.batch = batch
    self.input_index = input_index

  def located(self, batches_file):
    """The same error, starting with the file (and line) where the batch is defined."""
    if not batches_file:
      return self
    line = _input_line(batches_file, self.batch, self.input_index) if self.input_index is not None else None
    return BatchError(f"{batches_file}{f':{line}' if line else ''}: {self.message}", self.batch, self.input_index)


def _yaml_get(node, key):
  """The node for `key` in a YAML mapping node (the last one, like PyYAML), or None."""
  found = None
  if isinstance(node, yaml.MappingNode):
    for k, v in node.value:
      if isinstance(k, yaml.ScalarNode) and k.value == key:
        found = v
  return found


def _input_line(batches_file, batch, index) -> Optional[int]:
  """The line of a batch's input in a batches file, if we can find it."""
  try:
    with open(batches_file) as f:
      root = yaml.compose(f, Loader=yaml.SafeLoader)
    definition = _yaml_get(root, batch)
    inputs = _yaml_get(definition, 'inputs') or _yaml_get(definition, 'tests')
    return inputs.value[index].start_mark.line + 1
  except Exception:
    return None


def _input_error(batch, inputs, index) -> BatchError:
  """Explains what is wrong with the input at `index`, that is not a path, a list, or a mapping."""
  value = inputs[index]
  previous = next((i for i in reversed(inputs[:index]) if isinstance(i, str)), None)
  after = f', after "{previous}"' if previous is not None else ' (the first one)' if index == 0 else ''
  if value is None:
    message = f'The batch "{batch}" has an empty input{after}: a "-" with nothing after it. Remove the "-", or write the input after it.'
  else:
    kind = {"int": "a number", "float": "a number", "bool": "true or false", "date": "a date", "datetime": "a date"}.get(type(value).__name__, f"a {type(value).__name__}")
    message = f'The batch "{batch}" has an input that YAML reads as {kind}, not a path: {value}{after}. Write it in quotes.'
  return BatchError(message, batch, index)


def flatten(lst: Union[str, List, Tuple]) -> Iterator[Union[str, List, Tuple]]:
  if isinstance(lst, tuple) or isinstance(lst, list):
    yield from chain.from_iterable((flatten(x) for x in lst))
  else: # type==str
    yield(lst)


def resolve_aliases(names : Union[str, List[str], Tuple[str, ...]], aliases: Dict[str, List[str]], depth=10) -> Iterator[Union[str, List[str], Tuple[str, ...]]]:
  # TODO: Expose an API that -> Iterator[str], after all the recursive calls.
  if names is None:
    return []
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
      if not isinstance(value, numbers.Real):
        return False
      operator, value_filter = number_spec.groups()
      value_filter = float(value_filter)
      if operator in ['=', '==']: return value == value_filter
      if operator == '>=': return float(value) >= value_filter
      if operator == '<=': return float(value) <= value_filter
      if operator == '>': return float(value) > value_filter
      if operator == '>': return float(value) > value_filter
      return False
    else:
      return fnmatch.fnmatch(value.casefold(), value_filter.casefold())
  elif isinstance(value_filter, dict):
    if value_filter and not value: return False
    return all([match(value.get(k,""), value_filter[k]) for k,v in value_filter.items()])
  else: # bool, number...
    return value == value_filter


def iter_inputs_at_path(path, database, globs, use_parent_folder, qatools_config, only=None, exclude=None):
  if path and path != "*":
    # sorted: glob lists in filesystem order, which differs between machines, and so would the runs of a batch
    input_paths = sorted(database.glob(str(path))) # to support wildcards
  else:
    # we want to match everything, including inputs starting at the level of the database
    # that could be identified by nested naming conventions like "tv/tv_*"
    input_paths = [*sorted(database.glob("*")), database]
  if not input_paths:
    _record_missing_input(path, database)
    if 'QA_BATCH_FAIL_IF_EMPTY' in os.environ:
      click.secho(f'ERROR: No inputs found for the batch "{path}" under {database}', fg='red', err=True)
      sys.exit(1)
    else:
      click.secho(f'WARNING: No inputs found for the batch "{path}" under {database}', fg='yellow', err=True)
      if 'QABOARD_TUNING' in os.environ and not database.is_absolute():
        click.secho('         You look for your input inside the project directory, but we cannot find them...', fg='red', err=True)
        click.secho('         Make sure that (1) your inputs are declared as artifacts, and (2) you called `qa save-artifacts`.', fg='red', err=True)
      return

  if not globs:
    yield from ((i, database) for i in input_paths)
    return

  maybe_parent = lambda path: path.parent if use_parent_folder else path
  seen_inputs = set()
  for glob in globs:
    for input_path in input_paths:
      input_path = cased_path(input_path)
      inputs = set([maybe_parent(f) for f in input_path.rglob(glob)])
      inputs = [cased_path(i) for i in inputs] # fix case issues on Windows
      if fnmatch.fnmatch(input_path, f'*/{glob}') or str(input_path).endswith(glob):
        inputs.append(cased_path(input_path))
      # the same order on every machine (rglob lists in filesystem order, sets in hash order)
      inputs = sorted(inputs)


      # This provides backward compatibility with flows were a tool based on regexes was used.
      if "QA_BATCH_FILTER_INPUT_REGEX" in os.environ:
        regex = os.environ["QA_BATCH_FILTER_INPUT_REGEX"]
        regex = regex.lstrip("^") # not sure it is always what we want but helps with the legacy workflow
        inputs = [i for i in inputs if re.search(regex, i.as_posix())]

      for i in inputs:
        if i in seen_inputs:
          continue
        metadata = []
        # ideally the increment would be after filtering,
        # but some projects rely on metadata() to limit the amount of tests they run based on the git diff
        # for those, we don't want to QA_BATCH_FAIL_IF_EMPTY check to fail
        seen_inputs.add(i)
        if only or exclude:
          metadata = input_metadata(i, database, i.relative_to(database), qatools_config)
          if only and not match(metadata, only): continue
          if exclude and match(metadata, exclude): continue
        # delete metadata that start with _
        if metadata:
          metadata_keys = list(metadata.keys())
          for k in metadata_keys:
            if k.startswith('_') or k == "input_path" or k == "rel_input_path":
              del metadata[k]
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

  if not seen_inputs:
    _record_missing_input(path, database, globs)
    if 'QA_BATCH_FAIL_IF_EMPTY' in os.environ:
      click.secho(f'ERROR: No inputs found matching "{path}" [{globs}] under "{database}".', fg='red', err=True)
      raise ValueError(f'No inputs found matching "{path}" [{globs}] under "{database}".')
    else:
      click.secho(f'WARNING: No inputs found matching "{path}" [{globs}] under "{database}".', fg='yellow', err=True)


def _iter_inputs(path, database, inputs_settings, qatools_config, only=None, exclude=None):
  if path and Path(path).is_absolute():
    database_str, *path_parts =  Path(path).resolve().parts
    path = Path(*path_parts)
    database = Path(database_str)
  if database.is_absolute(): # normalization to avoid common issues where users ask for "//some/path" instead of "/some/path"
    database = database.resolve()
  entrypoint_module_ = entrypoint_module(qatools_config)
  if hasattr(entrypoint_module_, 'iter_inputs'):
    try:
      iter_inputs = entrypoint_module_.iter_inputs(path, database, only, exclude, inputs_settings)
      # we filter twice just in case
      iter_inputs_filtered = (i for i in iter_inputs if (not only or match(i["metadata"], only)) and (not exclude or not match(i["metadata"], exclude)))
      yield from ( (i["input_path"], i["database"]) for i in iter_inputs_filtered)
      # we really could send a batch update to /our/ database here with all the metadata?
    except Exception:
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



def iter_inputs(
  batches: List[str],
  batches_files: List[os.PathLike],
  default_database: Path,
  default_configurations: List,
  default_platform: str,
  default_job_configuration,
  qatools_config,
  default_inputs_settings=None,
  cli_runner_overrides=None,
  debug=os.environ.get('QA_DEBUG_ITER_INPUTS', False),
):
  """
  Returns an iterator over the (input_path, configurations, runner-configuration) from the selected batches
  # TODO: allow changing the entrypoint per-batch
  """
  available_batches: Dict = {}
  batches_sources: Dict[str, os.PathLike] = {} # where each batch is defined
  for batches_file in batches_files:
    try:
      from .config import project, subproject
      batches_file_path = location_from_spec(batches_file, {"project": project, "subproject": subproject})
      with open(batches_file_path) as f:
        new_batches = yaml.load(f, Loader=yaml.SafeLoader)
      if new_batches is None:
        click.secho(f"WARNING: no data in: {batches_file}", fg='yellow', err=True)
        continue
      if not isinstance(new_batches, dict):
        click.secho(f"WARNING: Invalid YAML (expected mapping/dict) in: {batches_file}", fg='yellow', err=True)
        continue
      if not new_batches:
        continue
    except Exception as e:
      click.secho(f"ERROR: Invalid YAML: {batches_file}", err=True)
      raise e
    # deep-merge the aliases
    old_aliases = available_batches.get('aliases', {})
    new_aliases: Dict = new_batches.get('aliases', new_batches.get('groups', {})) or {}
    available_batches['aliases'] = {**old_aliases, **new_aliases}

    for new_batch in new_batches:
      if new_batch.startswith('.') or new_batch in BATCH_FILE_SETTINGS:
        continue
      is_batch = isinstance(new_batches[new_batch], dict) # vs e.g. aliases
      is_pipeline = is_batch and new_batches[new_batch].get("type") == "pipeline"
      if is_batch and not is_pipeline:
        # Allow setting defaults for database/platform at the YAML level
        # But pipelines need their own special database, everything is hardcoded for them...
        for attr in ["platform", "database", "configurations", "configs"]:
          if attr in new_batches and attr not in new_batches[new_batch]:
              try:
                new_batches[new_batch][attr] = new_batches[attr]
              except Exception: # people often have things that are not batches, maybe aliases reused elsewhere...
                pass
      allow_duplicate_batches = qatools_config.get('inputs', {}).get('allow_duplicate_batches')
      batches_sources[new_batch] = batches_file_path
      if not allow_duplicate_batches or new_batch not in available_batches and new_batch not in available_batches['aliases']:
        available_batches[new_batch] = new_batches[new_batch]
      else: # we want to run both...
        if new_batch not in available_batches['aliases']:
          available_batches['aliases'][new_batch] = [f"{new_batch}_FIRST", f"{new_batch}@{batches_file}"]
          available_batches[f"{new_batch}_FIRST"] = available_batches[new_batch]
          available_batches[f"{new_batch}@{batches_file}"] = new_batches[new_batch]
          del available_batches[new_batch]
        else:
          available_batches['aliases'][new_batch].append(f"{new_batch}@{batches_file}")
          available_batches[f"{new_batch}@{batches_file}"] = new_batches[new_batch]
  if debug:
    click.secho(str(available_batches), dim=True, err=True)

  batch_aliases = available_batches.get('aliases', {})
  batches = list(resolve_aliases(batches, batch_aliases)) # type: ignore
  if not batches:
    if 'QA_BATCH_FAIL_IF_EMPTY' in os.environ:
      click.secho(f'ERROR: No batch was chosen.', fg='red', err=True)
      raise ValueError('No batch was chosen.')
    else:
      click.secho(f'WARNING: No batch was chosen.', fg='yellow', err=True)

  if not default_inputs_settings:
    inputs_settings = get_settings(qatools_config.get('inputs', {}).get('types', {}).get('default', 'default'), qatools_config)
  else:
    inputs_settings = deepcopy(default_inputs_settings)

  # Apply runner settings from default input type configuration
  updated_job_configuration = deepcopy(default_job_configuration)
  input_type_runners = inputs_settings.get('runners', {})
  if input_type_runners:
    # Apply default runner if specified in input type
    if 'default' in input_type_runners:
      default_runner_for_type = input_type_runners['default']
      updated_job_configuration["type"] = default_runner_for_type
    
    # Apply specific runner configuration from input type, for the runner that will run
    current_runner = (cli_runner_overrides or {}).get('type', updated_job_configuration.get('type', 'local'))
    if current_runner in input_type_runners and isinstance(input_type_runners[current_runner], dict):
      updated_job_configuration = {**updated_job_configuration, **input_type_runners[current_runner]}

  run_context = RunContext(
    input_path=Path(),
    database=default_database,
    configurations=default_configurations,
    platform=default_platform,
    job_options=updated_job_configuration,
    type=inputs_settings['type']
  )

  def located(batch, make_iterator):
    """Errors in a batch's definition say where it is defined."""
    try:
      yield from make_iterator()
    except BatchError as e:
      raise e.located(batches_sources.get(batch)) from None

  def check_batch(batch):
    if available_batches[batch] is None:
      click.secho(f"WARNING: Cannot use empty batch definitions like '{batch}:'. Check your batch YAML.", fg='yellow', err=True)
      click.secho(f"         If you want to run on all inputs consider using '{batch}: inputs:'.", fg='yellow', err=True)

  for batch in batches:
    if debug: click.secho(f'batch: {batch}', dim=True, err=True)

    # 1. Batches can directly match specifications from YAML files
    if batch in available_batches:
      check_batch(batch)
      batch_run_context = deepcopy(run_context)
      batch_run_context.batch = batch
      yield from located(batch, lambda: iter_batch(parse_batch(batch, available_batches[batch]), batch_run_context, qatools_config, inputs_settings, debug, cli_runner_overrides))
      continue
    
    # 2. Batches can be specified using wildcards
    matching_batches = [b for b in available_batches if b != 'aliases' and fnmatch.fnmatch(b, batch)]
    if matching_batches:
      for b in matching_batches:
        batch_run_context = deepcopy(run_context)
        batch_run_context.batch = b
        check_batch(b)
        yield from located(b, lambda: iter_batch(parse_batch(b, available_batches[b]), batch_run_context, qatools_config, inputs_settings, debug, cli_runner_overrides))
      continue

    # 3. Batch can be directly paths to inputs (semi-deprecated...) 
    if debug: click.secho(str(batch), bold=True, fg='cyan', err=True)
    inputs_iter = _iter_inputs(batch, run_context.database, inputs_settings, qatools_config)
    yield from (replace(run_context, input_path=i, database=d) for i, d in inputs_iter)


class SubscriptableDict:
  def __init__(self, data):
    self.data = data
  def __getattr__(self, name):
    return self.data[name]
  def __getitem__(self, name):
    return self.data[name]

def deep_interpolate(value, replaced: str, to_value):
  if isinstance(value, dict):
    return {k: deep_interpolate(v, replaced, to_value) for k, v in value.items()}
  elif isinstance(value, list):
    return [deep_interpolate(v, replaced, to_value) for v in value]
  elif isinstance(value, str):
    if value == replaced:
      return to_value
    else:
      obj = {replaced: SubscriptableDict(to_value) if isinstance(to_value, dict) else to_value}
      wrapped_replaced = r"(\${" + replaced + r"([^}]*)})"
      matches = re.findall(wrapped_replaced, value)
      full_match = False
      if matches:
        for match in matches:
          match_str = match[0]
          if len(match_str) == len(value):
            full_match = True
          try:
            value = value.replace(match_str, match_str[1:].format(**obj))
          except Exception: # we don't care if some format strings don't match our object
            pass
      if full_match:
        try:
          return int(value)
        except Exception:
          pass
        try:
          return float(value)
        except Exception:
          pass
        try:
          return json.loads(value)
        except Exception:
          pass
      return value
  else:
    return value

def parse_batch(batch_name, batch):
  """Returns an empty batch if there is an issue with the batch's content"""
  # Happens often when there is an orphan "my-batch:" in in the yaml file
  if batch is None:
    click.secho(f'WARNING: Empty definition for the batch {batch_name}', fg='yellow', err=True)
    return None
  if not isinstance(batch, dict):
    raise BatchError(f'The batch "{batch_name}" must be a mapping with keys like inputs, configurations, database..., got a {type(batch).__name__}: {batch}', batch_name)
  return batch


def iter_batch(batch: Dict, default_run_context: RunContext, qatools_config, default_inputs_settings, debug, cli_runner_overrides=None):
    if batch is None:
      return

    run_context = deepcopy(default_run_context)
    run_context.configurations = batch.get('configs', batch.get('configurations', batch.get('configuration', run_context.configurations)))
    run_context.configurations = list(flatten(run_context.configurations))
    if 'platform' in batch:
      run_context.platform = batch['platform']
    runner = run_context.job_options.get('type', 'local')

    # First, apply input type runner settings
    if 'type' in batch:
      run_context.type = batch['type']
      inputs_settings = get_settings(batch['type'], qatools_config)
      from .config import get_default_database
      run_context.database = get_default_database(inputs_settings)
      
      # Merge runner settings from input type configuration
      input_type_runners = inputs_settings.get('runners', {})
      if input_type_runners:
        # Apply default runner if specified in input type
        if 'default' in input_type_runners:
          default_runner_for_type = input_type_runners['default']
          run_context.job_options = {
            **run_context.job_options,
            "type": default_runner_for_type,
          }
          runner = default_runner_for_type
        
        # Apply specific runner configuration from input type for the current runner
        current_runner = (cli_runner_overrides or {}).get('type', run_context.job_options.get('type', runner))
        if current_runner in input_type_runners and isinstance(input_type_runners[current_runner], dict):
          run_context.job_options = {**run_context.job_options, **input_type_runners[current_runner]}
    else:
      inputs_settings = deepcopy(default_inputs_settings)

    # Then, apply batch-level runner overrides (these take precedence)
    if "runner" in batch:
      runner = batch["runner"]
      run_context.job_options = {
        **run_context.job_options,
        "type": runner,
      }
      
      # Apply runner-specific config from input type if available
      if 'type' in batch:
        input_type_runners = inputs_settings.get('runners', {})
        if runner in input_type_runners and isinstance(input_type_runners[runner], dict):
          run_context.job_options = {**run_context.job_options, **input_type_runners[runner]}
    
    # Apply batch-level runner configuration, for the runner that will run: e.g. `--runner=local` uses the batch's `local` settings,
    # even if the default runner is lsf
    if cli_runner_overrides and 'type' in cli_runner_overrides:
      runner = cli_runner_overrides['type']
    if runner in batch and isinstance(batch[runner], dict):
      run_context.job_options = {**run_context.job_options, **batch[runner]}

    # Apply CLI overrides (highest precedence)
    if cli_runner_overrides:
      run_context.job_options = {**run_context.job_options, **cli_runner_overrides}

    inputs_settings.update(batch)

    batch_database = location_from_spec(batch.get('database', run_context.database))
    if batch_database:
      run_context.database = batch_database
    if batch.get('matrix'):
      # We used to rely on ParameterGrid
      # https://scikit-learn.org/stable/modules/generated/sklearn.model_selection.ParameterGrid.html
      # but imports are super slow, so we replaced with stdlib with the same API
      batch_matrices = batch['matrix']
      # A sequence of dicts signifies a sequence of grids to search,
      # useful to avoid exploring parameter combinations that make no sense or have no effect.
      if isinstance(batch_matrices, dict):
        batch_matrices = [batch_matrices]
      for batch_matrix in batch_matrices:
        keys = batch_matrix.keys()
        values = batch_matrix.values()
        for combination in product(*values):
          matrix = dict(zip(keys, combination))
          batch_ = deepcopy(batch)
          for key in ['matrix', 'configuration', 'configurations', 'configs', 'platform']:
            if key in batch:
              del batch_[key]
          matrix_run_context = deepcopy(run_context)
          if 'platform' in matrix:
            matrix_run_context.platform = matrix['platform']
          matrix_config = None
          for k in ['configuration', 'configurations', 'configs']:
            if k in matrix:
              matrix_config = matrix[k]
          if matrix_config:
            # if no config is specified in the batch, but the matrix defined some
            # them we want to replace the default config, not append to it
            run_context_uses_default_config = not any([k in batch for k in ['configs', 'configurations', 'configuration']])
            if matrix_run_context.configurations and not run_context_uses_default_config:
              matrix_run_context.configurations.append(matrix_config)
            else:
              matrix_run_context.configurations = matrix_config
          for param, value in matrix.items():
            if param in ['configuration', 'configurations', 'configs', 'platform']:
              continue
            matrix_run_context.configurations = deep_interpolate(matrix_run_context.configurations, 'matrix', {param: value})
          yield from iter_batch(batch_, matrix_run_context, qatools_config, default_inputs_settings, debug, cli_runner_overrides)
      return

    locations = batch.get('inputs', batch.get('tests'))
    if not locations:
      inputs_iter = _iter_inputs(None, run_context.database, inputs_settings, qatools_config, only=batch.get('only'), exclude=batch.get('exclude'))
      yield from (replace(run_context, input_path=i, database=d) for i, d in inputs_iter)
      return

    # We also allow each input to have its settings...
    if isinstance(locations, str): # a single input
      locations = [locations]
    if isinstance(locations, dict): # {inputA: config, inputB: config}
      locations_and_configs = [(location, config) for location, config in locations.items()]
    elif isinstance(locations, list): # [inputA, inputA] or [(inputA, configA), (inputB, configB)] or [{inputA: configA, inputB: configB}]
      locations_and_configs = []
      for index, l in enumerate(locations):
        if isinstance(l, str):
          locations_and_configs.append((l, None))
        elif isinstance(l, list) and l:
          location, *location_configurations = l
          locations_and_configs.append((location, location_configurations))
        elif isinstance(l, dict):
          for location, location_configurations in l.items():
            locations_and_configs.append((location, location_configurations))
        else:
          raise _input_error(run_context.batch, locations, index)
    else:
      raise BatchError(f'The inputs of the batch "{run_context.batch}" must be a list of paths, not: {locations}', run_context.batch)

    for location, location_configurations in locations_and_configs:
      location_run_context = deepcopy(run_context)
      location_inputs_settings = inputs_settings
      if location_configurations:
        if isinstance(location_configurations, dict):
          if location_configurations.get(runner):
            # the command line options still win
            location_run_context.job_options = {**location_run_context.job_options, **location_configurations[runner], **(cli_runner_overrides or {})}
          if 'database' in location_configurations:
            location_database = location_from_spec(location_configurations['database'])
            if location_database:
              location_run_context.database = location_database
          if 'platform' in location_configurations:
            location_run_context.platform = location_configurations['platform']
          location_inputs_settings = deepcopy(inputs_settings)
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
            patch_config = cast(List, location_configurations.get('configs', location_configurations.get('configurations', location_configurations.get('configuration', []))))
            location_run_context.configurations = [*location_run_context.configurations, *patch_config]
        elif isinstance(location_configurations, list):
          location_run_context.configurations = [*location_run_context.configurations, *list(flatten(location_configurations))]
        else: # string?
          location_run_context.configurations =  [*location_run_context.configurations, location_configurations]
      if debug: click.secho(str(location_run_context.database / location), bold=True, fg='cyan', err=True)
      inputs_iter = _iter_inputs(location, location_run_context.database, location_inputs_settings, qatools_config, only=batch.get('only'), exclude=batch.get('exclude'))
      yield from (replace(location_run_context, input_path=i, database=d) for i, d in inputs_iter)




def load_runs_file(path) -> List[Dict[str, Any]]:
  """
  Reads the runs listed for `qa batch --runs-file`, e.g. when QA-Board redoes runs:
    {"runs": [{"input_path", "database", "type", "platform", "configurations", "extra_parameters", "job_options", "batch"}]}
  input_path is relative to the database. Only input_path and database are required.
  """
  try:
    with Path(path).open() as f:
      data = json.load(f)
  except (OSError, ValueError) as e:
    raise click.UsageError(f"Could not read the runs file {path}: {e}")
  runs = data.get('runs') if isinstance(data, dict) else None
  is_run = lambda run: isinstance(run, dict) and 'input_path' in run and 'database' in run and isinstance(run.get('job_options') or {}, dict)
  if not isinstance(runs, list) or not all(is_run(run) for run in runs):
    raise click.UsageError(f'Invalid runs file {path}: expected {{"runs": [{{"input_path": ..., "database": ..., ...}}]}}')
  return runs


# Job options that depend on who runs `qa batch`, from where, and for which command.
# When we redo runs, we don't reuse the values they were started with.
local_job_options = ('command_id', 'batch_dir', 'cwd', 'user', 'bridge')

def rerun_job_options(job_options: Optional[Dict[str, Any]], default_job_options: Dict[str, Any], cli_runner_overrides: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
  """The job options to redo a run that was started with `job_options`, from a `qa batch` that would use `default_job_options`."""
  job_options = job_options or {}
  cli_runner_overrides = cli_runner_overrides or {}
  if 'type' in cli_runner_overrides and job_options.get('type') != cli_runner_overrides['type']:
    # They were options for another runner
    job_options = {}
  settings = {k: v for k, v in job_options.items() if k not in local_job_options}
  local = {k: v for k, v in default_job_options.items() if k in local_job_options}
  return {**default_job_options, **settings, **local, **cli_runner_overrides}


def iter_runs(runs: List[Dict[str, Any]], default_type: str, default_platform: str, default_job_options: Dict[str, Any], cli_runner_overrides=None) -> Iterator[RunContext]:
  """The runs from a runs file (see load_runs_file), with the job options they were started with."""
  for run in runs:
    database = Path(run['database'])
    if database.is_absolute():
      database = database.resolve()
    yield RunContext(
      type=run.get('type') or default_type,
      input_path=database / run['input_path'],
      database=database,
      platform=run.get('platform') or default_platform,
      configurations=list(run.get('configurations') or []),
      extra_parameters=dict(run.get('extra_parameters') or {}),
      batch=run.get('batch'),
      job_options=rerun_job_options(run.get('job_options'), default_job_options, cli_runner_overrides),
    )


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
  # a grid by default, as the docs show `--tuning-search '{"parameter_search": {...}}'`
  search_type = tuning_search.get('search_type', 'grid')
  if not parameter_search:
    params_iterator = [{}]
  elif search_type == 'grid':
    # http://scikit-learn.org/stable/modules/generated/sklearn.model_selection.ParameterSampler.html#sklearn.model_selection.ParameterSampler
    from sklearn.model_selection import ParameterGrid
    # from search import ParameterGrid
    params_iterator = ParameterGrid(parameter_search)
  elif search_type == 'sampler':
    from sklearn.model_selection import ParameterSampler
    # from search import ParameterSampler
    params_iterator = ParameterSampler(parameter_search, n_iter=n_iter)
  else:
    raise ValueError(f"Unknown tuning search_type: {search_type!r}, use 'grid' or 'sampler'")

  for counter, params_ in enumerate(params_iterator):
    if n_iter and counter >= n_iter and n_iter > 0:
        click.secho(f"Stopping tuning combination after {n_iter} iterations", fg='yellow', err=True)
        return
    # the search overrides the extra parameters specified earlier
    params = {**extra_params, **params_}
    params_str = json.dumps(params, sort_keys=True)
    params_hash = pretty_hash(params_str)


    # We can either save the tuning parameters on the CLI only, or in a file
    # If we save in a file, then it must be readable on the server that will execute the run
    #   so /tmp folders are not possible. We can assume the current working directory is readable,
    #   but in CI settings the current user may no have enough permissions to write there (if we switched user to handle storage quotas...)
    #   and in any case if the files are temporary it makes reproducing the runs that much harder...
    yield params, params_str, params_hash
