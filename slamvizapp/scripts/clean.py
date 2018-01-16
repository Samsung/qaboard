#!/usr/bin/env python
"""
Removes the outputs from old commits from the disk. This saves storage...
"""
import datetime
import subprocess
import click

from slamvizapp import repo, CiCommit
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

  references = [branch] is branch else repo.refs
  old_commits = set()
  for ref in references:
    for c in repo.iter_commits(ref):
      is_old = now - c.authored_datetime > threshold
      if is_old(c) and c not in protected_commits:
        old_commits.add(c)
  print(f'{len(old_commits)} to be deleted')

  for c in old_commits:
    print(f'DELETE: {c.hexsha} on {c.authored_datetime} by {c.author.name}')
    ci_commit = CiCommit(c)
    if ci_commit.commit_dir.exists():
      command = f'rm -rf {str(ci_commit.commit_dir)}'
      subprocess.Popen([command], shell=True)
      # outputs = ci_commit.commit_dir/'output'
      # logs = ci_commit.commit_dir/'lsf.log'
      # command = f'rm -rf {str(outputs)} {str(logs)}'
      # print(command)


if __name__ == '__main__':
    clean()