from git import Repo
from git import RemoteProgress
from git.exc import NoSuchPathError


class Repos():
  """Holds data for multiple repositories."""

  def __init__(self, git_server, clone_directory):
    self._repos = {}
    self.git_server = git_server
    self.clone_directory = clone_directory

  def __getitem__(self, project_path):
    """
    Return a git-python Repo object representing a clone
    of $QABOARD_GIT_SERVER/project_path at $QABOARD_DATA

    project_path: the full git repository namespace, eg dvs/psp_swip
    """
    clone_location = str(self.clone_directory / project_path)
    try:
      repo = Repo(clone_location)
    except NoSuchPathError:
      try:
        print(f'Cloning <{project_path}> to {self.clone_directory}')
        repo = Repo.clone_from(
          # for now we expect everything to be on gitlab-srv via http
          f'git@{self.git_server}:{project_path}',
          str(clone_location)
        )
      except Exception as e:
        print(f'[ERROR] Could not clone: {e}. Please set $QABOARD_DATA to a writable location and verify your network settings')
        raise(e)
    self._repos[project_path] = repo
    return self._repos[project_path]


def git_pull(repo):
  """Updates the repo and warms the cache listing the latests commits.."""
  class MyProgressPrinter(RemoteProgress):
    def update(self, op_code, cur_count, max_count=100.0, message="[No message]"):
      # print('...')
      # print(op_code, cur_count, max_count, (cur_count or 0)/max_count, message)
      pass
  try:
    for fetch_info in repo.remotes.origin.fetch(progress=MyProgressPrinter()):
      # print(f"Updated {fetch_info.ref} to {fetch_info.commit}")
      pass
  except Exception as e:
    print(e)

def find_branch(commit_hash, repo):
  """Tries to get from which branch a commit comes from. It's a *guess*."""
  std_out = repo.git.branch(contains=commit_hash, remotes=True)
  branches = [l.split(' ')[-1] for l in std_out.splitlines()]
  important_branches = ['origin/release', 'origin/master', 'origin/develop']
  for b in important_branches:
    if b in branches:
      return b
  if branches:
    return branches[0]
  return 'unknown'