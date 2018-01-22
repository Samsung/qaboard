#!/usr/bin/env python
"""
Removes the outputs from old commits from the disk. This saves storage...
"""
import datetime
import subprocess
import click

from slamvizapp import repo, db_session
from slamvizapp.models import CiCommit
from slamvizapp.config import *


@click.command()
@click.option('--days', default=7, help='Outputs folders older than this will be removed.')
@click.option('--branch', default=None, help='Delete only from this branch.')
def clean(days, branch):
  """Removes the outputs from old commits from the disk. This saves storage..."""
  # We don't want to touch the commits from that branch
  protected_refs = set(['origin/develop'])
  protected_commits = set()
  for ref in protected_refs:
    for c in repo.iter_commits(ref):
      protected_commits.add(c)

  # for c in protected_commits:
  #   print(f'{c.hexsha} on {c.authored_datetime} by {c.author.name}')
  print(f'{len(protected_commits)} protected')

  now = datetime.datetime.now().astimezone()
  threshold = datetime.timedelta(days=days)

  references = [branch] if branch else repo.refs
  old_commits = set()
  for ref in references:
    for c in repo.iter_commits(ref):
      is_old = now - c.authored_datetime > threshold
      if is_old and c not in protected_commits:
        old_commits.add(c)
  print(f'{len(old_commits)} to be deleted')

  for c in old_commits:
    print(f'DELETE: {c.hexsha} on {c.authored_datetime} by {c.author.name}')
    commit_dir = ci_directory / 'commits' / f'{c.authored_date}__git__{c.hexsha[:8]}'
    if commit_dir.exists():
      command = f'rm -rf {str(commit_dir)}'
      subprocess.Popen([command], shell=True)
      # outputs = ci_commit.commit_dir/'output'
      # logs = ci_commit.commit_dir/'lsf.log'
      # command = f'rm -rf {str(outputs)} {str(logs)}'
      # print(command)


  subprocess.Popen("find /home/arthurf/ci/dvs/psp_swip/branches -maxdepth 3 -name '*core*' -delete", shell=True)



if __name__ == '__main__':
    clean()