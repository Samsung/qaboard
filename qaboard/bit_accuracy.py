#!/usr/bin/env python
"""
Bit-accuracy test between 2 results folders.

We compare runs, not directories: from each run's context (input, configurations, platform, tuning parameters)
`CommitRuns` finds where a commit's run is saved. QA-Board knows where runs are, so we ask it first.
Otherwise (offline, unreachable, runs it doesn't know about) we follow the storage conventions (see conventions.py),
where `{user}` in the storage settings can be any user.
"""
import os
import glob
import sys
import json
import filecmp
import fnmatch
from dataclasses import dataclass, field, replace
from functools import lru_cache
from pathlib import Path
from typing import Dict, Iterator, List, Optional, Tuple

import click
from click import secho

from .conventions import batch_folder_name, get_commit_dirs, output_dirs_for_input_part, run_dir_in_commit
from .iterators import iter_inputs
from .matching import run_distance
from .run import RunContext
from .utils import PathType, checked_cde_attrs
from .config import project, config, default_batches_files


def default_cmp(file_1, file_2):
    return filecmp.cmp(str(file_1), str(file_2), shallow=False)

cmp_func = default_cmp
# In some cases you want to implement your own file comparaison.
# It can be useful if e.g. you want to allow a file-format change, but still fail in case of semantic changes
# To do this, write some/file.py implemented a "cmp(file_1, file_2)" function.
# It should return True if the files are "the same", False otherwise
# To use this file, set as environment variable QA_BITACCURACY_CMP=/your/file.py
custom_cmp = os.environ.get("QA_BITACCURACY_CMP")
if custom_cmp:
  try:
    cmp_source = Path(custom_cmp).resolve()
    # https://docs.python.org/3/library/importlib.html#importing-a-source-file-directly
    import importlib.util
    spec = importlib.util.spec_from_file_location('custom-cmp', str(cmp_source))
    assert spec
    module = importlib.util.module_from_spec(spec)
    sys.path.insert(0, str(cmp_source.parent))
    spec.loader.exec_module(module) # type: ignore
    cmp_func = module.cmp # type: ignore
  except Exception:
    import traceback
    exc_type, exc_value, exc_traceback = sys.exc_info()
    click.secho(f'ERROR: Error importing the custom cmp function.', fg='red', err=True, bold=True)
    click.secho(''.join(traceback.format_exception(exc_type, exc_value, exc_traceback)), fg='red', err=True)


def is_same_content(filename, meta_1, meta_2):
  # we allow changes in hex files' footers or raw imgprops, provided same critical attributes don't change
  if filename.endswith('.hex'):
    missing_attrs = [
      attr
      for attr in checked_cde_attrs
      if attr not in meta_1 or attr not in meta_2
    ]
    if missing_attrs:
      click.secho(f'WARNING: The following image attributes are missing in the manifest: {filename} {missing_attrs}', fg="yellow", err=True)
    return all(
      meta_1[attr] == meta_2[attr]
      for attr in checked_cde_attrs
      if attr in meta_1 and attr in meta_2
    )
  elif filename.endswith('.raw'):
    missing_attrs = [
      attr
      for attr in checked_cde_attrs
      if attr != "md5_data" and (attr not in meta_1 or attr not in meta_2)
    ]
    # warn if the RAW is missing attributes, but don't fail since some RAWs don't have imgprops file.
    if missing_attrs:
      click.secho(f'WARNING: The following image attributes are missing in the manifest: {filename} {missing_attrs}', fg="yellow", err=True)

    # we compare both data and metadata for raw files
    return (
      meta_1['md5'] == meta_2['md5'] and \
      all(
        meta_1[attr] == meta_2[attr]
        for attr in checked_cde_attrs
        if attr in meta_1 and attr in meta_2
      )
    )
  else:
    return meta_1['md5'] == meta_2['md5']


def is_ignored(rel_path: str, ignore) -> bool:
  """Whether the path of a file in a run's output directory starts with one of the bit_accuracy.ignore patterns."""
  return any(fnmatch.fnmatch(rel_path, f"{i}*") for i in ignore)


def cmpfiles(dir_1=Path(), dir_2=Path(), patterns=None, ignore=None, cmp=default_cmp):
  """Bit-accuracy test between two directories. We usually use cmpmanifest only...
  Almost like https://docs.python.org/3/library/filecmp.html
  """
  if not cmp:
    cmp = default_cmp

  if not patterns:
    patterns = ['*']
  if not ignore:
    ignore = []

  mismatch = set()  # not the same
  match = set()     # the same
  only_in_1 = set() # exists in dir_1 but not in dir_2
  only_in_2 = set() # exists in dir_2 but not in dir_1
  errors = set()    # or errors accessing

  for pattern in patterns:
    files_1 = list(dir_1.rglob(pattern))
    files_2 = list(dir_2.rglob(pattern))

    for file_2 in files_2:
      if not file_2.is_file(): continue
      rel_path = file_2.relative_to(dir_2)
      if is_ignored(rel_path.as_posix(), ignore): continue
      if not (dir_1 / rel_path).is_file():
        only_in_2.add(rel_path)

    for file_1 in files_1:
      if not file_1.is_file(): continue
      rel_path = file_1.relative_to(dir_1)
      if is_ignored(rel_path.as_posix(), ignore): continue

      file_2 = dir_2 / rel_path
      if file_2.is_file():
        try:
          is_same = cmp(file_1, file_2)
          if not is_same:
            mismatch.add(rel_path)
          else:
            match.add(rel_path)
        except:
          errors.add(rel_path)
      else:
        only_in_1.add(rel_path)

  return {
    "mismatch": mismatch,
    "match": match,
    "only_in_1": only_in_1,
    "only_in_2": only_in_2,
    "errors": errors,
  }



def cmpmanifests(manifest_path_1, manifest_path_2, patterns=None, ignore=None):
  """Bit-accuracy test between two manifests.
  Their format is {filepath: {md5, size_st}}"""
  def parse_json(path):
    with path.open() as f:
      data = f.read()
      try:
        return json.loads(data)
      except Exception as e:
        print(data)
        raise Exception(f"{e} Could not parse as JSON: {path}")
  manifest_1 = parse_json(manifest_path_1)
  manifest_2 = parse_json(manifest_path_2)

  if not patterns:
    patterns = ['*']
  if not ignore:
    ignore = []

  mismatch = set()  # not the same
  match = set()     # the same
  only_in_1 = set() # exists in dir_1 but not in dir_1
  only_in_2 = set() # exists in dir_2 but not in dir_2
  errors = set()    # or errors accessing

  for pattern in patterns:
    pattern = f'*{pattern}'
    for file_2_str in manifest_2:
      if not fnmatch.fnmatch(file_2_str, pattern):
        continue
      if is_ignored(file_2_str, ignore):
        continue
      if file_2_str not in manifest_1:
        only_in_2.add(Path(file_2_str))

    for file_1_str, meta_1 in manifest_1.items():
      if not fnmatch.fnmatch(file_1_str, pattern):
        continue
      file_1 = Path(file_1_str)
      if is_ignored(file_1_str, ignore):
        continue
      if file_1_str in manifest_2:
        is_same = is_same_content(file_1_str, meta_1, manifest_2[file_1_str])
        if not is_same:
          mismatch.add(file_1)
        else:
          match.add(file_1)
      else:
        only_in_1.add(file_1)

  return {
    "mismatch": mismatch,
    "match": match,
    "only_in_1": only_in_1,
    "only_in_2": only_in_2,
    "errors": errors,
  }



# Replaces {user} in the storage settings when we look for the runs of any user
USER_WILDCARD = '\0user\0'

def glob_user(path: Path) -> List[Path]:
  """The existing directories matching `path`, where USER_WILDCARD matches any name"""
  path_str = str(path)
  if USER_WILDCARD not in path_str:
    return [path] if path.is_dir() else []
  pattern = '*'.join(glob.escape(part) for part in path_str.split(USER_WILDCARD))
  return sorted(Path(p) for p in glob.glob(pattern) if Path(p).is_dir())


def commit_outputs_pattern(commit: str) -> Optional[Path]:
  """Where a commit's runs are in the storage, with USER_WILDCARD for the {user} of the storage settings"""
  from .config import storage_roots, config, project, project_root, subproject, repo_root
  if project is None or project_root is None: # no qaboard.yaml
    return None
  outputs_root, _, _ = storage_roots(config, project, subproject, user_name=USER_WILDCARD)
  return outputs_root / project_root / get_commit_dirs(commit, repo_root) / subproject

def commit_outputs_dirs(commit: str) -> List[Path]:
  """Where a commit's runs are in the storage. With a {user} in the storage settings, there is one per user"""
  pattern = commit_outputs_pattern(commit)
  return glob_user(pattern) if pattern else []


@lru_cache()
def runs_known_by_qaboard(commit: str, batch_label: str) -> Optional[Tuple[Dict, ...]]:
  """The runs of a commit's batch according to QA-Board. None if it can't tell (unreachable, unknown commit or batch...)"""
  from .api import batch_info, ResultsUnreadable
  try:
    info = batch_info(reference=commit, batch=batch_label, metrics=["none-required"], ignore_errors=True)
  except ResultsUnreadable as e:
    secho(f"WARNING: QA-Board refused to tell where the runs of {commit[:8]} are ({e.response.status_code}): we look for them in the storage.", fg='yellow', err=True)
    return None
  except Exception: # e.g. it doesn't know the batch, or can't be reached
    info = {}
  if 'outputs' not in info:
    secho(f"Could not get the runs of {commit[:8]} ({batch_label}) from QA-Board: we look for them in the storage.", dim=True, err=True)
    return None
  return tuple(o for o in info['outputs'].values() if not o.get('deleted'))


# How we pick the reference run: the one with the same configurations, platform and tuning parameters,
# or the closest one on the same input, like the web app does
REFERENCE_MATCHES = ('exact', 'closest')

def run_settings(run) -> Dict:
  """What identifies a run on an input, from a RunContext, a run from QA-Board or a run.json"""
  get = (lambda k: getattr(run, k)) if isinstance(run, RunContext) else run.get
  return {
    'platform': get('platform'),
    'configurations': get('configurations') or [],
    # forwarded arguments (qa run -i input --some-arg) are not part of a run's directory
    'extra_parameters': {k: v for k, v in (get('extra_parameters') or {}).items() if k != 'forwarded_args'},
  }

def is_same_run(settings: Dict, other: Dict) -> bool:
  return json.dumps(settings, sort_keys=True) == json.dumps(other, sort_keys=True)

def matching_run(run_context: RunContext, runs, match='exact') -> Optional[Dict]:
  """The run from QA-Board with the same input, and the same configurations, platform and tuning parameters
  or with match='closest' the closest ones"""
  settings = run_settings(run_context)
  same_input = [r for r in runs if Path(r['test_input_path']).as_posix() == run_context.rel_input_path.as_posix()]
  # the same input can be in different databases
  other_database = lambda r: Path(r['test_input_database']) != Path(run_context.database)
  if match == 'closest':
    return min(same_input, key=lambda r: (run_distance(settings, run_settings(r)), other_database(r)), default=None)
  matches = [r for r in same_input if is_same_run(settings, run_settings(r))]
  return min(matches, key=other_database, default=None)


@dataclass
class CommitRuns:
  """Where the runs of a commit's batch are"""
  commit: str
  batch_label: str
  # Whether to ask QA-Board where runs are
  ask_qaboard: bool = True
  # Where the runs are saved if not in the storage (local runs), or where we look first (our own runs)
  local_dir: Optional[Path] = None
  in_storage: bool = True
  match: str = 'exact'
  _storage_dirs: Optional[List[Path]] = field(default=None, repr=False)

  def run_dir(self, run_context: RunContext) -> Path:
    """Where `qa run` saves the run, relative to the commit's outputs"""
    from .config import config
    return run_dir_in_commit(self.batch_label, run_context.platform, run_context.configurations, run_context.extra_parameters, run_context.rel_input_path, run_context.database, config)

  def storage_dirs(self) -> List[Path]:
    if self._storage_dirs is None:
      self._storage_dirs = commit_outputs_dirs(self.commit) if self.in_storage else []
    return self._storage_dirs

  def find(self, run_context: RunContext) -> List[Path]:
    """The output directories of the run (more than one if users' storage folders each have one)"""
    return [output_dir for output_dir, _ in self.find_runs(run_context)]

  def find_runs(self, run_context: RunContext) -> List[Tuple[Path, Dict]]:
    """The output directories of the run, with the settings of the run found (see run_settings)"""
    if self.ask_qaboard:
      runs = runs_known_by_qaboard(self.commit, self.batch_label)
      if runs is not None:
        run = matching_run(run_context, runs, self.match)
        if run:
          from .api import url_to_dir
          return [(url_to_dir(run['output_dir_url']), run_settings(run))]
    run_dir = self.run_dir(run_context)
    found = [self.local_dir / run_dir] if self.local_dir is not None and (self.local_dir / run_dir).is_dir() else []
    if not found:
      found = [d / run_dir for d in self.storage_dirs() if (d / run_dir).is_dir()]
    if not found and self.match == 'closest':
      return self.closest_saved_runs(run_context)
    return [(output_dir, run_settings(run_context)) for output_dir in found]

  def saved_runs_on_input(self, root: Path, run_context: RunContext) -> List[Tuple[Path, Dict]]:
    """The runs saved under `root` on the input, whatever their configurations, platform and tuning parameters"""
    from .config import config
    # the platform, configurations and tuning parameters are hashed in the folder between the label's and the input's
    input_dir = output_dirs_for_input_part(run_context.rel_input_path, Path(run_context.database), config)
    pattern = Path(glob.escape(str(root / batch_folder_name(self.batch_label)))) / '*' / glob.escape(str(input_dir)) / 'run.json'
    runs = []
    for run_path in sorted(glob.glob(str(pattern))):
      try:
        run_info = json.loads(Path(run_path).read_text())
      except (OSError, ValueError):
        continue
      # inputs whose folder have the same name, e.g. a.jpg and a.png
      if Path(run_info.get('input_path', '')).as_posix() == run_context.rel_input_path.as_posix():
        runs.append((Path(run_path).parent, run_settings(run_info)))
    return runs

  def closest_saved_runs(self, run_context: RunContext) -> List[Tuple[Path, Dict]]:
    """The saved runs on the input that are the closest to the run (more than one if users' storage folders each have one)"""
    runs = self.saved_runs_on_input(self.local_dir, run_context) if self.local_dir is not None else []
    if not runs:
      runs = [run for d in self.storage_dirs() for run in self.saved_runs_on_input(d, run_context)]
    if not runs:
      return []
    settings = run_settings(run_context)
    distances = [run_distance(settings, run_settings_) for _, run_settings_ in runs]
    return [run for run, distance in zip(runs, distances) if distance == min(distances)]

  def looked_at(self, run_context: RunContext) -> List[Path]:
    """Where we looked for the run, for error messages"""
    if self.match == 'closest': # any run on the input
      from .config import config
      input_dir = output_dirs_for_input_part(run_context.rel_input_path, Path(run_context.database), config)
      run_dir = batch_folder_name(self.batch_label) / '*' / input_dir
    else:
      run_dir = self.run_dir(run_context)
    roots = [self.local_dir] if self.local_dir is not None else []
    if self.in_storage:
      storage_dirs = self.storage_dirs()
      if not storage_dirs: # where it would be
        pattern = commit_outputs_pattern(self.commit)
        storage_dirs = [Path(str(pattern).replace(USER_WILDCARD, '{user}'))] if pattern else []
      roots.extend(d for d in storage_dirs if d not in roots)
    return [root / run_dir for root in roots]


def current_runs(ctx) -> CommitRuns:
  """Where the current commit's runs are, see `qa batch`"""
  from .config import is_ci, commit_id, local_commit_placeholder, outputs_commit, subproject
  shared = bool(is_ci or ctx.obj['share'])
  return CommitRuns(
    commit=commit_id or local_commit_placeholder,
    batch_label=ctx.obj['batch_label'],
    # runs that are not shared are not in QA-Board
    ask_qaboard=shared and not (ctx.obj['offline'] or ctx.obj['dryrun']),
    local_dir=outputs_commit if shared else subproject.resolve(),
    in_storage=shared,
  )


def batch_runs(ctx, batches, batches_files) -> Iterator[RunContext]:
  """The runs of `qa batch`"""
  from .config import config
  for run_context in iter_inputs(batches, batches_files, ctx.obj['database'], ctx.obj['configurations'], ctx.obj['platform'], {}, config, ctx.obj['inputs_settings']):
    run_context.extra_parameters = ctx.obj['extra_parameters']
    yield run_context


def saved_runs(ctx, current: CommitRuns) -> List[RunContext]:
  """The runs saved in the current commit's outputs, for its label"""
  assert current.local_dir is not None
  label_dir = current.local_dir / batch_folder_name(current.batch_label)
  run_contexts = []
  for manifest in sorted(label_dir.rglob('manifest.outputs.json')):
    run_path = manifest.parent / "run.json"
    if not run_path.exists():
      secho("ERROR: Corrupted output directory. Missing 'run.json' file", fg="red", bold=True)
      secho(f"       We expected one in {run_path.parent}", fg="red")
      sys.exit(1)
    run_info = json.loads(run_path.read_text())
    database = Path(run_info.get('database', '.'))
    run_context = RunContext(
      type=run_info.get('input_type', 'default'),
      input_path=database / run_info['input_path'],
      database=database,
      platform=run_info.get('platform', ctx.obj['platform']),
      configurations=run_info.get('configurations') or [],
      extra_parameters=run_info.get('extra_parameters') or {},
      output_dir=manifest.parent,
    )
    # The default label's folder has the other labels' folders
    if 'database' in run_info and manifest.parent != current.local_dir / current.run_dir(run_context):
      continue
    run_contexts.append(run_context)
  return run_contexts


def describe(run_context: RunContext) -> str:
  description = str(run_context.rel_input_path)
  if run_context.configurations:
    description = f"{description}  {json.dumps(run_context.configurations)}"
  return description

def describe_differences(settings: Dict, reference: Dict) -> str:
  """How the reference run's settings differ, e.g. 'platform: hw, configurations: ["base", "fast"]'"""
  names = {'platform': 'platform', 'configurations': 'configurations', 'extra_parameters': 'tuning'}
  return ', '.join(
    f"{name}: {reference[key] if key == 'platform' else json.dumps(reference[key])}"
    for key, name in names.items()
    if json.dumps(settings[key], sort_keys=True) != json.dumps(reference[key], sort_keys=True)
  )


def is_bit_accurate(dir_new, dir_ref, run_context: RunContext, strict=False, manifest_name='manifest.outputs.json'):
    """Compares the results of a run versus a reference"""
    from .config import config
    run_identifier = describe(run_context)

    patterns = config.get("bit_accuracy", {}).get("patterns", [])
    if not (isinstance(patterns, list) or isinstance(patterns, tuple)):
      patterns = [patterns]
    if not patterns:
      patterns = ['*']

    ignore = config.get("bit_accuracy", {}).get("ignore", [])
    if not (isinstance(ignore, list) or isinstance(ignore, tuple)):
      ignore = [ignore]
    ignore = list(ignore) # we add to it, not to the configuration
    ignore.append('manifest.inputs.json') # compared when setting manifest_name
    ignore.append('run.json')             # qa-board data, not relevant
    ignore.append('log.txt')              # contains timestamps
    ignore.append('log.lsf.txt')          # contains timestamps
    ignore.append('metrics.json')         # contains measured run time
    ignore.append('metrics_definitions.json') # how to show metrics, not outputs
    ignore.append('.nfs000*')             # NFS temporary files

    missing_runs = False
    if not dir_ref.exists():
      click.secho(f"ERROR: No reference for {run_identifier}", fg='red')
      click.secho(f"       nothing at {dir_ref}", fg='red', dim=True)
      missing_runs = True
    if not dir_new.exists():
      click.secho(f"ERROR: Missing run for {run_identifier}", fg='red')
      click.secho(f"       nothing at {dir_new}", fg='red', dim=True)
      missing_runs = True
    if missing_runs:
      return False

    if (dir_new / manifest_name).exists() and (dir_ref / manifest_name).exists() and not custom_cmp:
      comparison = cmpmanifests(
        manifest_path_1 = dir_new / manifest_name,
        manifest_path_2 = dir_ref / manifest_name,
        patterns=patterns,
        ignore=ignore,
      )
    elif manifest_name == "manifest.outputs.json":
      comparison = cmpfiles(
        dir_1=dir_new,
        dir_2=dir_ref,
        patterns=patterns,
        ignore=ignore,
        cmp=cmp_func,
      )
    else:
      click.secho(f"ERROR: Could not find {manifest_name} in all runs", fg='red')
      return False
    run_identifier = f"{run_identifier}  @{manifest_name}"

    bit_accurate = True
    if strict:
      if comparison['only_in_1']:
        click.secho(run_identifier, fg='red', bold=True, err=True)
        click.secho(f'{dir_new}', fg='red', err=True, dim=True)
        click.secho(f"ERROR: ({len(comparison['only_in_1'])}) file(s) are not present in the reference run:", fg='red')
        for p in comparison['only_in_1']:
          click.secho(f'➖ {p}', fg='red', dim=True)
        bit_accurate = False
      if comparison['only_in_2']:
        click.secho(run_identifier, fg='red', bold=True, err=True)
        click.secho(f'{dir_new}', fg='red', err=True, dim=True)
        click.secho(f"ERROR: {len(comparison['only_in_2'])} file(s) existing in the reference run are not present:", fg='red')
        for p in comparison['only_in_2']:
          click.secho(f'➕  {p}', fg='red', dim=True)
        bit_accurate = False

    nothing_was_compared = not (len(comparison['match']) + len(comparison['mismatch']) + len(comparison['errors']) )
    if nothing_was_compared and bit_accurate:
      click.echo(click.style(f'🤔  {run_identifier}', fg='yellow') + click.style(' 0 files compared', fg='yellow', dim=True), err=True)

    if comparison['errors']:
      bit_accurate = False
      click.secho("ERROR: While trying to read those files:", fg='red', bold=True)
      click.secho(f'{dir_new}', fg='red', err=True, dim=True)
      for p in comparison['errors']:
        click.secho(f"⚠️  {p}", fg='red')

    if comparison['mismatch']:
      bit_accurate = False
      click.secho(run_identifier, fg='red', bold=True, err=True)
      click.secho(f'{dir_new}', fg='red', err=True, dim=True)
      click.secho(f"ERROR: Mismatch for:", fg='red')
      for p in comparison['mismatch']:
        click.secho(f'❌  {p}', fg='red', dim=True)

    if bit_accurate and not nothing_was_compared:
      click.secho(f"✔️  {run_identifier}", fg='green', err=True)
    return bit_accurate


def find_current_run(current: CommitRuns, run_context: RunContext) -> List[Path]:
  """The output directories of one of our runs, with an error message if there are none"""
  new_dirs = current.find(run_context)
  if not new_dirs:
    click.secho(f"ERROR: Missing run for {describe(run_context)}", fg='red')
    for d in current.looked_at(run_context):
      click.secho(f"       nothing at {d}", fg='red', dim=True)
  return new_dirs



@click.command()
@click.pass_context
@click.option('--batch', '-b', 'batches', required=True, multiple=True, help="Only check bit-accuracy for this batch of inputs+configs+database.")
@click.option('--batches-file', 'batches_files', type=PathType(),  default=default_batches_files, multiple=True, help="YAML file listing batches of inputs+config+database selected from the database.")
@click.option('--strict', is_flag=True, help="By default only files existing in current/ref runs are checked. This files ensure we fail if some files exist in one run and not the other.")
def check_bit_accuracy_manifest(ctx, batches, batches_files, strict):
    """
    Checks the bit accuracy of the results in the current output directory
    versus the latest commit on origin/develop.
    """
    # Some projects run costly metadata logic only at the batch level
    # to skip runs. They rely on this to identify metadata calls at the run-level
    # behaviour needs to match for bit-accuracy checks
    os.environ['QA_BATCH']= 'true'

    current = current_runs(ctx)
    click.secho(f'Current directory  : {current.local_dir}', fg='cyan', bold=True, err=True)
    all_bit_accurate = True
    nb_compared = 0
    missing_runs = 0
    run_context = None
    for run_context in batch_runs(ctx, batches, batches_files):
      reference_dir = run_context.database / run_context.rel_input_path
      inputs_manifest_exists =  (reference_dir / "manifest.inputs.json").exists()
      outputs_manifest_exists = (reference_dir / "manifest.outputs.json").exists()
      if not inputs_manifest_exists:
        click.secho(f"[WARNING] no input manifest for {reference_dir}", fg='yellow')
      if not outputs_manifest_exists:
        click.secho(f"[WARNING] no output manifest for {reference_dir}", fg='yellow')
        if not inputs_manifest_exists: continue
      nb_compared += 1
      if run_context.input_path.is_file():
        click.secho('ERROR: check_bit_accuracy_manifest only works for inputs that are folders', fg='red', err=True)
        # otherwise the manifest is at input_path.parent/manifest.json in the database and input_path.stem/manifest.json in the results
        sys.exit(1)

      new_dirs = find_current_run(current, run_context)
      if not new_dirs:
        missing_runs += 1
      for new_dir in new_dirs:
        if inputs_manifest_exists:
          all_bit_accurate = is_bit_accurate(new_dir, reference_dir, run_context, strict=strict, manifest_name='manifest.inputs.json') and all_bit_accurate
        if outputs_manifest_exists:
          all_bit_accurate = is_bit_accurate(new_dir, reference_dir, run_context, strict=strict) and all_bit_accurate

    if missing_runs:
      click.secho(f"ERROR: {missing_runs} runs are missing!", bg='red', underline=True, bold=True)
      sys.exit(1)
    if not all_bit_accurate:
      click.secho("\nError: you are not bit-accurate versus the manifest.", bg='red', underline=True, bold=True)
      click.secho("Reminder: the manifest lists the expected inputs/outputs for each test. It acts as an explicit gatekeeper against changes", fg='red', dim=True)
      if run_context and not run_context.database.is_absolute():
        click.secho("If that's what you wanted, update and commit all manifests.", fg='red')
      else:
        click.secho("To update the manifests for all tests, run:", fg='red')
        click.secho("$ qa batch --save-manifests --batch *", fg='red')
      sys.exit(1)

    if not nb_compared:
      click.secho("\nWARNING: Nothing was compared! It's not likely to be what you expected...", fg='yellow', underline=True, bold=True)



@click.command()
@click.pass_context
@click.option(
    "--reference",
    default=config.get('project', {}).get('reference_branch', 'master'),
    help="Branch, tag or commit used as reference."
)
@click.option('--batch', '-b', 'batches', multiple=True, help="Only check bit-accuracy for those batches of inputs+configs+database.")
@click.option('--batches-file', 'batches_files', type=PathType(),  default=default_batches_files, multiple=True, help="YAML file listing batches of inputs+config+database selected from the database.")
@click.option('--strict', is_flag=True, help="By default only files existing in current/ref runs are checked. This files ensure we fail if some files exist in one run and not the other.")
@click.option('--reference-label', default = None, help="Compare against another label on the same batch")
@click.option('--reference-platform', help="Compare against a difference platform.")
@click.option('--reference-match', type=click.Choice(REFERENCE_MATCHES), default='exact', show_default=True, help="Compare with the reference's run with the same configurations, platform and tuning parameters, or with the closest one on the same input, like the web app.")
def check_bit_accuracy(ctx, reference, batches, batches_files, strict, reference_label, reference_platform, reference_match):
    """
    Checks the bit accuracy of the results in the current output directory
    versus the latest commit on origin/develop.
    """
    from .config import is_in_git_repo, commit_branch, commit_id, is_ci
    from .git_hosts import lastest_successful_ci_commit
    from .api import qaboard_url
    from .git import latest_commit, git_parents

    # Some projects run costly metadata logic only at the batch level
    # to skip runs. They rely on this to identify metadata calls at the run-level
    # behaviour needs to match for bit-accuracy checks
    os.environ['QA_BATCH']= 'true'

    if not is_in_git_repo:
      click.secho("You are not in a git repository, maybe in an artifacts folder. `check_bit_accuracy` is unavailable.", fg='yellow', dim=True)
      sys.exit(1)


    if is_ci and commit_branch == reference:
      click.secho(f'We are on branch {reference}', fg='cyan', bold=True, err=True)
      click.secho(f"Comparing bit-accuracy against this commit's ({commit_id[:8]}) parents.", fg='cyan', bold=True, err=True)
      # It will work until we try to rebase merge requests.
      # We really should use Gitlab' API (or our database) to ask about previous pipelines on the branch
      reference_commits = git_parents(commit_id)
    else:
      # ideally we should do something smarter...
      # https://stackoverflow.com/questions/18222634/given-a-git-refname-can-i-detect-whether-its-a-hash-tag-or-branch
      origin_reference = reference if "origin" in reference else f"origin/{reference}"
      origin_latest_commit = latest_commit(origin_reference)
      if origin_latest_commit != origin_reference: # it was a commit
        click.secho(f'Comparing bit-accuracy versus the latest remote commit of {origin_reference}', fg='cyan', bold=True, err=True)
        reference_commits = [origin_latest_commit]
      else:
        click.secho(f'Comparing bit-accuracy versus {reference}', fg='cyan', bold=True, err=True)
        reference_commits = [reference]
    click.secho(f"{commit_id[:8]} versus {reference_commits}.", fg='cyan', err=True)

    current = current_runs(ctx)
    click.secho(f'Current directory  : {current.local_dir}', fg='cyan', bold=True, err=True)
    if batches:
      run_contexts = list(batch_runs(ctx, batches, batches_files))
    else: # backward-compat for DVS, can likely be removed at the next refactoring
      run_contexts = saved_runs(ctx, current)
    if not run_contexts:
      click.secho("WARNING: There are no runs to compare.", fg='yellow', bold=True, err=True)
    runs_dirs = [(run_context, find_current_run(current, run_context)) for run_context in run_contexts]
    all_bit_accurate = all(new_dirs for _, new_dirs in runs_dirs)

    # The reference's runs are from its CI, where the label is not prefixed by the user like with `qa --share`
    reference_label = reference_label if reference_label else ctx.obj['raw_batch_label']
    for reference_commit in reference_commits:
      # if the reference commit is pending or failed, we wait or maybe pick a parent
      reference_commit = lastest_successful_ci_commit(reference_commit) # TODO: don't do this if passed a commit hash
      references = CommitRuns(reference_commit, reference_label, ask_qaboard=not ctx.obj['offline'], match=reference_match)
      click.secho(f"Reference: {reference_commit[:8]} ({reference_label})", fg='cyan', bold=True, err=True)
      for run_context, new_dirs in runs_dirs:
        reference_run = replace(run_context, platform=reference_platform) if reference_platform else run_context
        reference_runs = references.find_runs(reference_run)
        reference_dirs = [reference_dir for reference_dir, _ in reference_runs]
        for _, reference_settings in reference_runs[:1]:
          differences = describe_differences(run_settings(reference_run), reference_settings)
          if differences:
            click.secho(f"≈  {describe(run_context)}", fg='yellow', err=True, nl=False)
            click.secho(f"  versus the closest run, with {differences}", fg='yellow', dim=True, err=True)
        if not reference_dirs:
          click.secho(f"ERROR: No reference for {describe(run_context)}", fg='red')
          for d in references.looked_at(reference_run):
            click.secho(f"       nothing at {d}", fg='red', dim=True)
          all_bit_accurate = False
        for new_dir in new_dirs:
          for reference_dir in reference_dirs:
            all_bit_accurate = is_bit_accurate(new_dir, reference_dir, run_context, strict=strict) and all_bit_accurate
            all_bit_accurate = is_bit_accurate(new_dir, reference_dir, run_context, strict=strict, manifest_name='manifest.inputs.json') and all_bit_accurate
    if not all_bit_accurate:
      click.secho(f"\nERROR: results are not bit-accurate to {reference_commits}.", bg='red', bold=True)
      if is_ci:
        click.secho(f"\nTo investigate, go to", fg='red', underline=True)
        for reference_commit in reference_commits:
          url = f"{qaboard_url}/{project.as_posix()}/commit/{commit_id}?reference={reference_commit}&selected_views=bit_accuracy"
          if batches:
            url = f"{url}&batch={batches[0]}"
          click.secho(url, fg='red')
      sys.exit(1)
