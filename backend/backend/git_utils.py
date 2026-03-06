import os
from urllib.parse import urlparse

from git import Repo
from git import RemoteProgress
from git.exc import NoSuchPathError, InvalidGitRepositoryError

from .fs_utils import as_user

class Repos():
  """Holds data for multiple repositories."""

  def __init__(self, git_server, clone_directory):
    self._repos = {}
    self.git_server = git_server
    if not self.git_server.endswith('/'):
        self.git_server = self.git_server + '/'
    self.clone_directory = clone_directory

  def _authenticated_clone_url(self, project_path, hosting_type=None, web_url=None):
    """Build an authenticated clone URL for GitHub or GitLab."""
    if hosting_type == 'github':
      github_token = os.environ.get('GITHUB_ACCESS_TOKEN', '')
      if web_url:
        parsed = urlparse(web_url)
        host = parsed.hostname
        scheme = parsed.scheme
      else:
        host = 'github.com'
        scheme = 'https'
      if github_token:
        return f"{scheme}://x-access-token:{github_token}@{host}/{project_path}"
      return f"{scheme}://{host}/{project_path}"
    else:
      # GitLab (default)
      gitlab_token = os.environ.get('GITLAB_ACCESS_TOKEN', '')
      if gitlab_token:
        return self.git_server.replace('://', f"://oauth2:{gitlab_token}@") + project_path
      return f"{self.git_server}{project_path}"

  def __getitem__(self, project_path, hosting_type=None, web_url=None):
    """
    Return a git-python Repo object representing a clone
    of $QABOARD_GIT_SERVER/project_path at $QABOARD_DATA_DIR

    project_path: the full git repository namespace, eg group/repo
    hosting_type: 'github' or 'gitlab' (default)
    web_url: the web URL of the repo (used to derive host for GitHub Enterprise)
    """
    clone_location = str(self.clone_directory / project_path)
    try:
      repo = Repo(clone_location)
    except InvalidGitRepositoryError:
      from fs_utils import rmtree
      rmtree(clone_location) # fail, and hopefully it will work better next time...
    except NoSuchPathError:
      try:
        clone_url = self._authenticated_clone_url(project_path, hosting_type=hosting_type, web_url=web_url)
        print(f'Cloning <{project_path}> to {self.clone_directory}')
        # https://gitpython.readthedocs.io/en/stable/reference.html#git.repo.base.Repo.clone_from
        repo = Repo.clone_from(
          clone_url,
          str(clone_location),
        )
      except Exception as e:
        print(f'[ERROR] Could not clone: {e}. Please set $QABOARD_DATA_DIR to a writable location and verify your network settings')
        raise(e)
    self._repos[project_path] = repo
    return self._repos[project_path]

  def get(self, project_path, hosting_type=None, web_url=None):
    """Like __getitem__ but accepts hosting context parameters."""
    return self.__getitem__(project_path, hosting_type=hosting_type, web_url=web_url)


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