#!/usr/bin/env python
"""
Removes the outputs from old commits from the disk. This saves storage...
"""
import datetime
import subprocess
import click
from gitdb.exc import BadName

from slamvizapp import repos, db_session
from slamvizapp.models import CiCommit
from slamvizapp.config import *




@click.command()
@click.option('--days', default=5, help='Outputs folders older than this will be removed.')
@click.option('--verbose', is_flag=True)
def clean(days, verbose):
  """Removes the outputs from old commits from the disk. This saves storage..."""
  now = datetime.datetime.now().astimezone()
  threshold = datetime.timedelta(days=days)
  def is_old(commit):
    return now - commit.authored_datetime > threshold

  repo = repos['dvs/psp_swip']

  # We don't want to touch the commits from that branch
  protected_refs = set(['origin/develop', 'origin/Release/AugustDemo'])
  protected_commits = set()
  for ref in protected_refs:
    for c in repo.iter_commits(ref):
      protected_commits.add(c)
  # for c in protected_commits:
  #   print(f'{c.hexsha} on {c.authored_datetime} by {c.author.name}')
  if verbose: print(f'{len(protected_commits)} protected')


  cicommits_dir = ci_directory/'dvs/psp_swip'/'commits'
  for cicommit_dir in cicommits_dir.glob('*__git__*'):
    commit_short_id = str(cicommit_dir)[-8:]
    try:
      commit = repo.commit(commit_short_id)
    except BadName:
      if verbose: print(f'{cicommit_dir}')
      continue

    if is_old(commit):
      if commit not in protected_commits:
        print(f'DELETE: {commit.hexsha} on {commit.authored_datetime} by {commit.author.name}')
        subprocess.Popen(f'rm -rf {cicommit_dir}', shell=True)
      else:
        if verbose:  print(f"find {cicommit_dir} -name '*mp4' -delete -print")  
        subprocess.Popen(f"find {cicommit_dir} -name '*mp4' -delete -print", shell=True)

  # we remove core dumps, they are soooo heavy...
  # we could update the LSF params to avoid creating them at all I guess
  subprocess.Popen("find /home/arthurf/ci/dvs/psp_swip/branches -maxdepth 3 -name '*core*' -delete -print", shell=True)



if __name__ == '__main__':
    clean()
