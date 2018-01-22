from pathlib import Path
from git import RemoteProgress

from slamvizapp import repo
from .config import *



def git_pull():
  """Updates the repo and warms the cache listing the latests commits.."""
  class MyProgressPrinter(RemoteProgress):
    def update(self, op_code, cur_count, max_count=100.0, message="[No message]"):
      # print('...')
      # print(op_code, cur_count, max_count, (cur_count or 0)/max_count, message)
      pass
  for fetch_info in repo.remotes.origin.fetch(progress=MyProgressPrinter()):
    # print(f"Updated {fetch_info.ref} to {fetch_info.commit}")
    pass


def find_branch(commit_hash):
  """Tries to get from which branch a commit comes from. It's a *guess*."""
  std_out = repo.git.branch(contains=commit_hash, remotes=True)
  branches = [l.split(' ')[-1] for l in std_out.splitlines()]
  important_branches = ['origin/release', 'origin/master', 'origin/develop']
  for b in important_branches:  
    if b in branches:
      return b
  return branches[0]
