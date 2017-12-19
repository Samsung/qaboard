from pathlib import Path
import pickle
from models import CiCommit

from git import Repo, Commit, RemoteProgress


repo = Repo("psp_swip")
# we cache the lists of recent commits, it's very slow otherwise...
git_cache = Path('data/list_commits.pkl')

def list_commits(branch, page, max_count):
  """Returns recent commits on a given branch. If none is chosen, go through all branches"""
  with git_cache.open('rb') as f:
    lists_hexsha = pickle.load(f)

  max_count = min(max_count, 100)

  if (branch, page, max_count) in lists_hexsha:
    print('cached!')
    hashes = lists_hexsha[(branch, page, max_count)]
    print(hashes)
    return [repo.commit(c) for c in hashes]

  commits = []
  branches = [branch] if branch is not None else repo.refs
  for b in branches:
    # print(f'Listing <={max_count} commits in `{b}`')
    for c in repo.iter_commits(b, max_count=max_count, skip=page*max_count):
      commits.append(c)

  commits_set = set([c for c in commits])
  ci_commits = [CiCommit(c) for c in commits_set]
  ci_commits = [c for c in ci_commits if c.build_succeeded()]
  ci_commits.sort(key=lambda c: c.gitcommit.authored_datetime, reverse=True)
  ci_commits = ci_commits[:max_count]

  print(f"found {len(commits)} commits in {len(branches)}")
  with git_cache.open('wb') as f:
    lists_hexsha[(branch, page, max_count)] = [c.gitcommit.hexsha for c in ci_commits]
    print(f'saving..{list(lists_hexsha.keys())}')
    pickle.dump(lists_hexsha, f)
  return commits

# caches recent commits - listing them is slow...
def git_pull():
  """Updates the repo and returns the 20 last commits.."""
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
  # list_commits('develop', 0, 20)
  # list_commits('develop', 1, 20)
