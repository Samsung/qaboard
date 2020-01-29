#!/usr/bin/env python
"""
Bit-accuracy test between 2 results folders
"""
import os
import time
import filecmp
import fnmatch
import json
from pathlib import Path

import click
import git

from .config import subproject, config, commit_branch
from .gitlab import ci_commit_statuses


def cmpfiles(dir_1=Path(), dir_2=Path(), patterns=None, ignore=None):
  """Bit-accuracy test between two directories.
  Almost like https://docs.python.org/3/library/filecmp.html
  """
  if not patterns:
    patterns = ['*']
  if not ignore:
    ignore = []

  mismatch = []  # not the same
  match = []     # the same
  only_in_1 = [] # exists in dir_1 but not in dir_2
  errors = []    # or errors accessing

  for pattern in patterns:
    for file_1 in dir_1.rglob(pattern):
      if not file_1.is_file(): continue
      if any(fnmatch.fnmatch(file_1.name, i) for i in ignore): continue

      rel_path = file_1.relative_to(dir_1)
      file_2 = dir_2 / rel_path
      if file_2.is_file():
        try:
          is_same = filecmp.cmp(str(file_1), str(file_2), shallow=False)
          if not is_same:
            mismatch.append(rel_path)
          else:
            match.append(rel_path)
        except:
          errors.append(rel_path)
      else:
        only_in_1.append(rel_path)

  return {
    "mismatch": mismatch,
    "match": match,
    "only_in_1": only_in_1,
    "errors": errors,
  }



def cmpmanifests(manifest_path_1, manifest_path_2, patterns=None, ignore=None):
  """Bit-accuracy test between two manifests.
  Their format is {filepath: {md5, size_st}}"""
  with manifest_path_1.open() as f:
    manifest_1 = json.load(f)
  with manifest_path_2.open() as f:
    manifest_2 = json.load(f)
  # print(manifest_1)
  # print(manifest_2)
  # print(set(manifest_1.keys()) & set(manifest_2.keys()))

  if not patterns:
    patterns = ['*']
  if not ignore:
    ignore = []

  # print(patterns)

  mismatch = set()  # not the same
  match = set()     # the same
  only_in_1 = set() # exists in dir_1 but not in dir_1
  errors = set()    # or errors accessing

  for pattern in patterns:
    pattern = f'*{pattern}'
    for file_1_str, meta_1 in manifest_1.items():
      if not fnmatch.fnmatch(file_1_str, pattern):
        continue
      file_1 = Path(file_1_str)
      if any(fnmatch.fnmatch(file_1.name, i) for i in ignore):
        continue
      if file_1_str in manifest_2:
        is_same = meta_1['md5'] == manifest_2[file_1_str]['md5']
        if not is_same:
          mismatch.add(file_1)
        else:
          match.add(file_1)
      else:
        only_in_1.add(file_1)

  return {
    "mismatch": list(mismatch),
    "match": list(match),
    "only_in_1": list(only_in_1),
    "errors": list(errors),
  }



def is_bit_accurate(commit_rootproject_dir, reference_rootproject_dir, output_directories, reference_platform=None):
    """Compares the results of the current output directory versus a reference"""    
    from .config import config
    patterns = config.get("bit_accuracy", {}).get("patterns", [])
    if not (isinstance(patterns, list) or isinstance(patterns, tuple)):
      patterns = [patterns]
    if not patterns:
      patterns = ['*']
    patterns.append('manifest.inputs.json')

    ignore = config.get("bit_accuracy", {}).get("ignore", [])
    if not (isinstance(ignore, list) or isinstance(ignore, tuple)):
      ignore = [ignore]
    ignore.append('log.txt')      # contains timestamps
    ignore.append('log.lsf.txt')  # contains timestamps
    ignore.append('metrics.json') # contains measured run time
    ignore.append('.nfs000*')     # NFS temporary files

    if not len(output_directories):
      click.secho("WARNING: nothing was compared", fg='yellow')
      return True

    comparaisons = {'match': [], 'mismatch': [], 'errors': []}
    for output_directory in output_directories:
      # print('output_directory', output_directory)
      dir_1 = reference_rootproject_dir / output_directory
      dir_2 = commit_rootproject_dir / output_directory

      # it's ugly and fragile...
      if reference_platform:
        from .config import platform
        dir_2 = Path(str(dir_2).replace(platform, reference_platform))

      # print('dir_1', dir_1)
      # print('dir_2', dir_2)
      if (dir_1 / 'manifest.outputs.json').exists() and (dir_2 / 'manifest.outputs.json').exists():
        comparaison = cmpmanifests(
          manifest_path_1 = dir_1 / 'manifest.outputs.json',
          manifest_path_2 = dir_2 / 'manifest.outputs.json',
          patterns=patterns,
          ignore=ignore,
        )
        comparaisons['match'].extend(output_directory / p for p in comparaison['match'])
        comparaisons['mismatch'].extend(output_directory / p for p in comparaison['mismatch'])
      else:
        comparaison = cmpfiles(
          dir_1=dir_1,
          dir_2=dir_2,
          patterns=patterns,
          ignore=ignore,
        )
        comparaisons['match'].extend(output_directory / p for p in comparaison['match'])
        comparaisons['mismatch'].extend(output_directory / p for p in comparaison['mismatch'])
        comparaisons['errors'].extend(output_directory / p for p in comparaison['errors'])

    # print(comparaisons['mismatch'])
    nothing_was_compared = not (len(comparaisons['match']) + len(comparaisons['mismatch']) + len(comparaisons['errors']) )
    if nothing_was_compared:
      for o in output_directories:
        click.echo(click.style(str(o), fg='yellow') + click.style(' (warning: no files were found to compare)', fg='yellow', dim=True), err=True)

    if len(comparaisons['errors']):
      click.secho("ERROR: while trying to read those files:", fg='red', bold=True)
      for p in comparaisons['error']:
        click.secho(str(p), fg='red')
      return False

    if len(comparaisons['mismatch']):
      for o in output_directories:
        click.secho(str(o), fg='red', bold=True, err=True)
      click.secho(f"ERROR: mismatch for:", fg='red')
      for p in comparaisons['mismatch']:
        click.secho(f'  {p}', fg='red', dim=True)
      return False

    bit_accurate = not len(comparaisons['mismatch'])
    if bit_accurate and not nothing_was_compared:
      for o in output_directories:
        click.secho(str(o), fg='green', err=True)
    return bit_accurate



def lastest_successful_ci_commit(commit, max_parents_depth=config.get('bit_accuracy', {}).get('max_parents_depth', 5)):
  if max_parents_depth < 0:
    click.secho(f'Could not find a commit that passed CI', fg='red', bold=True, err=True)
    exit(1)

  failed_ci_job_name = config.get('bit_accuracy', {}).get('failed_ci_job_name')
  if failed_ci_job_name and subproject:
    failed_ci_job_name = f"{failed_ci_job_name} {subproject.name}",


  wait_time = 15 # seconds
  while True:
    statuses = ci_commit_statuses(commit.hexsha, ref=commit_branch, name=failed_ci_job_name)
    # print(statuses)

    if statuses is None:
      click.secho(f'WARNING: Could not get the CI status. You may need a different GITLAB_ACCESS_TOKEN.', fg='yellow', err=True)
      return commit

    if failed_ci_job_name:
      # print('filtering')
      statuses = [s for s in statuses if s['name'] == f"{subproject.name} {failed_ci_job_name}"]
      # print(statuses)

    commit_failed = any(s['status'] in ['failed', 'canceled'] and not s.get('allow_failure', False) for s in statuses)
    if commit_failed:
      click.secho(f"WARNING: {commit.hexsha[:8]} failed the CI pipeline. (statuses: {set(s['status'] for s in statuses)})", fg='yellow', bold=True, err=True)
      if config.get('bit_accuracy', {}).get('on_reference_failed_ci') == 'compare-first-parent':
        click.secho(f"We now try to compare against its first parent.", fg='yellow', err=True)
        return lastest_successful_ci_commit(commit.parents[0], max_parents_depth=1)
      else:
        return commit

    commit_success = all(s['status'] == 'success' or s.get('allow_failure', False) for s in statuses)
    if commit_success:
      return commit

    click.secho(f"The CI pipeline for {commit.hexsha[:8]} is not over yet (statuses: {set(s['status'] for s in statuses)}). Retrying in {wait_time}s", fg='yellow', dim=True, err=True)
    # click.secho(str(statuses), fg='yellow', dim=True, err=True)
    time.sleep(wait_time)
