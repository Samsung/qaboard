#!/usr/bin/env python
"""
Bit-accuracy test between 2 results folders
"""
import os
import filecmp
from pathlib import Path

import click
import git


def cmpfiles(dir_1=Path(), dir_2=Path(), patterns=None, ignored_names=None):
  """Bit-accuracy test between two directories.
  Almost like https://docs.python.org/3/library/filecmp.html
  """
  # print(dir_1)
  # print(dir_2)
  if not patterns:
    ignores = ['*']
  if not ignored_names:
    ignored_names = []

  mismatch = []  # not the same
  match = []     # the same
  only_in_1 = [] # exists in dir_1 but not in dir_1
  errors = []    # or errors accessing

  for pattern in patterns:
    for file_1 in dir_1.rglob(pattern):
      if not file_1.is_file(): continue
      if any(file_1.name == name for name in ignored_names): continue

      rel_path = file_1.relative_to(dir_1)
      file_2 = dir_2 / rel_path
      if file_2.is_file():
        try:
          is_same = filecmp.cmp(str(file_1), str(file_2))
        except:
          errors.append(rel_path)
        if not is_same:
          mismatch.append(rel_path)
        else:
          match.append(rel_path)
      else:
        only_in_1.append(rel_path)

    return {
      "mismatch": mismatch,
      "match": match,
      "only_in_1": only_in_1,
      "errors": errors,
    }



def is_bit_accurate(commit_dir, reference_commit, output_directories):
    """Throws if the results of the current output directory are not bit-accurate to the reference commit"""    
    from .config import config, ci_dir
    from .conventions import get_commit_ci_dir

    reference_rootproject_ci_dir = get_commit_ci_dir(ci_dir, reference_commit)
    click.secho(f'Current directory  : {commit_dir}', fg='cyan', bold=True, err=True)
    click.secho(f"Reference directory: {reference_rootproject_ci_dir}", fg='cyan', bold=True, err=True)
    patterns = [*config["bit_accuracy"]["patterns"], 'manifest.inputs.json']

    comparaisons = {'match': [], 'mismatch': [], 'errors': []}
    for output_directory in output_directories:
      comparaison = cmpfiles(
        dir_1=reference_rootproject_ci_dir / output_directory,
        dir_2=commit_dir / output_directory,
        patterns=patterns,
        ignored_names=['log.txt'],
      )
      # print(comparaison)
      comparaisons['match'].extend(comparaison['match'])
      comparaisons['mismatch'].extend(comparaison['mismatch'])
      comparaisons['errors'].extend(comparaison['errors'])
    # print(comparaisons)
    assert len(comparaisons['match']), "At least 1 results file should be compared. Looks like something went wrong."
    assert not len(comparaisons['errors']), "ERROR: while trying to read/compare\n" + "\n".join(comparaisons['error'])
    return not len(comparaisons['mismatch'])


def assert_ci_pipelines_are_done(reference_commit):
  if 'GITLAB_ACCESS_TOKEN' not in os.environ:
    click.secho(f'Could not check if the CI pipeline for {reference_commit} is done. Please add GITLAB_ACCESS_TOKEN to your environment variables', fg='yellow', err=True)
    return

  import requests
  from requests.utils import quote
  from .config import root_qatools_config, ci_dir

  headers = {'Private-Token': os.environ['GITLAB_ACCESS_TOKEN']}
  gitlab_api = "http://gitlab-srv/api/v4"
  project_id = quote(root_qatools_config['project']['name'], safe='')

  r = requests.get(f"{gitlab_api}/projects/{project_id}/repository/commits/{reference_commit.hexsha}", headers=headers)
  commit_data = r.json()
  status = commit_data.get('status')
  if status in ['pending', 'running']:
    click.secho(f'The CI pipeline for {reference_commit} is not over yet. Please retry later', fg='red', bold=True, err=True)
    exit(1)

