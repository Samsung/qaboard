#!/usr/bin/env python
"""
Removes the outputs from old commits from the disk. This saves storage...
"""
import datetime
import subprocess
from pathlib import Path

import click
from gitdb.exc import BadName

from slamvizapp import repos, db_session
from slamvizapp.models import CiCommit
from slamvizapp.config import default_ci_directory




@click.command()
@click.argument('project', required=True)
@click.option('--protected-branch', multiple=True, help='Artifacts from this branch wont be removed.')
@click.option('--days', default=5, help='Outputs folders older than this will be removed.')
@click.option('--verbose', is_flag=True)
def clean(project, protected_branch, days, verbose):
  """Removes the outputs from old commits from the disk. This saves storage..."""
  now = datetime.datetime.now().astimezone()
  threshold = datetime.timedelta(days=days)
  def is_old(commit):
    return now - commit.authored_datetime > threshold

  repo = repos[project]

  # We don't want to touch delete artifacts from commits in those "protected" branches
  protected_refs = set(protected_branch)
  protected_commits = set()
  # Even for the protected branches, we remove the heaviest artifacts after a while (eg movies..)
  # Since it can be problematic for bit-accuracy tests, we make sure their latests commits are kept as-is.
  latest_protected_commits = set()

  for ref in protected_refs:
    for c in repo.iter_commits(ref):
      protected_commits.add(c)

  for ref in protected_refs:
    for c in repo.iter_commits(ref, max_count=1):
      latest_protected_commits.add(c)

  # for c in protected_commits:
  #   print(f'{c.hexsha} on {c.authored_datetime} by {c.author.name}')
  # if verbose: print(f'{len(protected_commits)} protected')

  if project == 'dvs/psp_swip': 
  	ci_directory = default_ci_directory
  elif project == 'tof/swip_tof':
  	ci_directory = Path('/stage/algo_data/ToF/Git_CI_output')
  else:
  	raise NotImplementedError('please write some code to get the project CI directory from the database...')
  cicommits_dir = ci_directory / project / 'commits'
  for cicommit_dir in cicommits_dir.glob('*__*__*'):
    commit_short_id = str(cicommit_dir)[-8:]
    try:
      commit = repo.commit(commit_short_id)
    except BadName:
      if verbose: print(f'BadName: {commit_short_id} in {cicommit_dir}')
      continue

    if is_old(commit):
      if commit not in protected_commits:
        print(f'DELETE: {commit.hexsha} on {commit.authored_datetime} by {commit.author.name}')
        subprocess.Popen(f'rm -rf "{cicommit_dir}"', shell=True)
      else:
        if commit not in latest_protected_commits:
          command = f"find '{cicommit_dir}' -type f \( -iname \*.mp4 -o -iname \*.pcd -o -iname \*.hex \) -delete -print"
          # print(command)
          subprocess.Popen(command, shell=True)

  # we remove core dumps, they are soooo heavy...
  # we could update the LSF params to avoid creating them at all I guess
  subprocess.Popen(f"find '{ci_directory/project}/branches' -maxdepth 3 -name '*core*' -delete -print", shell=True)



if __name__ == '__main__':
    clean()
