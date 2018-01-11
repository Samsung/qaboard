import pickle
from pathlib import Path
from git import RemoteProgress

from slamvizapp import repo
from .config import *


# we cache the lists of recent commits, it's very slow otherwise...
git_cache = app_data_directory/'list_commits.pkl'

def list_commits(branch, page, max_count):
  """Returns recent commits on a given branch.
  If None is chosen, it goes through all branches, but currently the count """
  with git_cache.open('rb') as f:
    lists_hexsha = pickle.load(f)

  max_count = min(max_count, 100)

  if (branch, page, max_count) in lists_hexsha:
    hashes = lists_hexsha[(branch, page, max_count)]
    return [repo.commit(c) for c in hashes]

  if branch is not None:
    commits = repo.iter_commits(branch, max_count=max_count, skip=page*max_count)
  else:
    # this is not accurate
    commits = []
    for ref in repo.refs:
      for c in repo.iter_commits(ref, max_count=max_count, skip=page*max_count):
        commits.append(c)

  # remove duplicates
  commits = list(set(commits))

  commits.sort(key=lambda c: c.authored_datetime, reverse=True)
  commits = commits[:max_count]

  print(f"found {len(commits)} commits")
  with git_cache.open('wb') as f:
    lists_hexsha[(branch, page, max_count)] = [c.hexsha for c in commits]
    print(f'saving..{list(lists_hexsha.keys())}')
    pickle.dump(lists_hexsha, f)
  return commits




def git_pull():
  """Updates the repo and warms the cache listing the latests commits.."""
  class MyProgressPrinter(RemoteProgress):
    def update(self, op_code, cur_count, max_count=100.0, message="[No message]"):
      print('...')
      # print(op_code, cur_count, max_count, (cur_count or 0)/max_count, message)
  for fetch_info in repo.remotes.origin.fetch(progress=MyProgressPrinter()):
    print(f"Updated {fetch_info.ref} to {fetch_info.commit}")

  # clear and warm the cache
  with git_cache.open('wb') as f:
    pickle.dump({}, f)
  list_commits(None, 0, 20)
  list_commits(None, 1, 20)
  list_commits('origin/develop', 0, 20)
  list_commits('origin/develop', 1, 20)


# find_branch below is slow, so we cache results
# we save to a file to avoid threading isses
if not (app_data_directory/'commits.pkl').exists():
    commit_branches = {}
    pickle.dump(commit_branches, open(str(app_data_directory/'commits.pkl'), 'wb'))

commit_branches = pickle.load(open(str(app_data_directory/'commits.pkl'), 'rb'))

def find_branch(commit_hash):
  """Tries to get from which branch a commit comes from. It's a *guess*."""
  if commit_hash in commit_branches:
    return commit_branches[commit_hash]
  else:
    std_out = repo.git.branch(contains=commit_hash, remotes=True)
    line = std_out.splitlines()[0]
    commit_branches[commit_hash] = line.split(' ')[-1]
    pickle.dump(commit_branches, open(str(app_data_directory/'commits.pkl'), 'wb'))
  return commit_branches[commit_hash]
