#!/usr/bin/env python
"""
Bit-accuracy test between 2 results folders
"""
import os
import filecmp
import fnmatch
import json
from pathlib import Path

import click

from .config import subproject, config, commit_branch


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
