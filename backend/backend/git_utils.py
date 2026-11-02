import os
import re
import tempfile
from pathlib import Path

from git import Repo
from git import RemoteProgress
from git.exc import NoSuchPathError, InvalidGitRepositoryError

from .fs_utils import rmtree


# Repository paths and URLs come from unauthenticated webhooks and API calls.
# Paths must stay under the clone directory: no absolute paths, no "." or ".." segments
safe_project_path = re.compile(r"[A-Za-z0-9_][A-Za-z0-9_.-]*(/[A-Za-z0-9_][A-Za-z0-9_.-]*)*")
def check_project_path(project_path):
  if not safe_project_path.fullmatch(str(project_path)):
    raise ValueError(f"Invalid repository path: {project_path!r}")


class Repos():
  """Local clones of the repositories, at $QABOARD_DATA_GIT_DIR/<project_path>"""

  def __init__(self, git_hosts, clone_directory):
    self.git_hosts = git_hosts # see git_hosts/__init__.py
    self.clone_directory = Path(clone_directory)

  def __getitem__(self, project_path):
    return self.get(project_path)

  def get(self, project_path, git=None, project_url=None):
    """
    Return a git-python Repo object representing a clone of the repository.

    project_path: the full git repository namespace, eg group/repo
    git: what we know about the repository: Project.data['git'], e.g. {"hosting_type": "github", "web_url": ...}
         It tells us which host to clone it from. By default: the default host (GITLAB_HOST, else the first in QABOARD_GIT_HOSTS).
    project_url: from qaboard.yaml, used if `git` doesn't tell us the host.

    Paths come from unauthenticated webhooks and API calls, so we only ever delete what we created:
    - a path inside a clone (org/repo/src), or that holds clones (org), is refused,
    - we clone into a temporary sibling (.<name>.cloning-*), and rename it when the clone is complete,
    - a broken clone (it has a .git, but git can't read it) is replaced by a new clone, and only then deleted.
    """
    check_project_path(project_path)
    clone_location = self.clone_directory / project_path
    self.check_not_in_a_clone(project_path)
    # Tokens are only sent to the host they belong to: we never clone from a URL we're given
    try:
      host = self.git_hosts.for_repo(git, project_url)
    except ValueError:
      host = None # we can still read existing clones
    broken = False
    try:
      repo = Repo(str(clone_location))
      if host:
        repo.git.update_environment(**host.git_env()) # to fetch
      return repo
    except InvalidGitRepositoryError:
      if not os.path.lexists(clone_location / '.git'):
        # Not a clone: e.g. "org" has the clones of the namespace
        if clone_location.is_dir() and not clone_location.is_symlink() and not any(clone_location.iterdir()):
          clone_location.rmdir() # empty, we can clone there
        else:
          raise ValueError(f"Not a git clone: {project_path}") from None
      else:
        broken = True # e.g. a clone that was interrupted before we cloned in temporary directories
    except NoSuchPathError:
      pass
    if not host:
      host = self.git_hosts.for_repo(git, project_url) # raises why
    if broken:
      nested = self.nested_clones(clone_location)
      if nested:
        raise ValueError(f"The broken clone of {project_path} has other clones inside: {nested[:3]}")
    return self.clone(host, project_path, clone_location, replace_broken=broken)

  def check_not_in_a_clone(self, project_path):
    """Refuses paths inside one of our clones, e.g. org/repo/src when org/repo is a clone."""
    parent = self.clone_directory
    for part in Path(project_path).parts[:-1]:
      parent = parent / part
      if os.path.lexists(parent / '.git') or parent.is_symlink():
        raise ValueError(f"Invalid repository path: {project_path} is inside {parent.relative_to(self.clone_directory)}")

  def nested_clones(self, directory):
    """The clones inside a directory, not counting itself (we don't follow symlinks)."""
    nested = []
    for root, dirs, files in os.walk(directory):
      if root != str(directory) and ('.git' in dirs or '.git' in files):
        nested.append(os.path.relpath(root, directory))
      dirs[:] = [d for d in dirs if d != '.git']
    return nested

  def clone(self, host, project_path, clone_location, replace_broken=False):
    print(f'Cloning <{project_path}> from {host} to {self.clone_directory}')
    clone_location.parent.mkdir(parents=True, exist_ok=True)
    # Names starting with "." are not valid repository paths: webhooks can't name them
    tmp_location = Path(tempfile.mkdtemp(prefix=f".{clone_location.name}.cloning-", dir=clone_location.parent))
    tmp_location.chmod(0o755) # like the folders git creates, mkdtemp's are only readable by us
    trash = None
    try:
      try:
        # https://gitpython.readthedocs.io/en/stable/reference.html#git.repo.base.Repo.clone_from
        Repo.clone_from(host.clone_url(project_path), str(tmp_location), env=host.git_env())
      except Exception as e:
        print(f'[ERROR] Could not clone {project_path} from {host}. Please set $QABOARD_DATA_DIR to a writable location and verify your network settings')
        raise RuntimeError(host.redact(str(e))) from None
      if replace_broken:
        trash = Path(tempfile.mkdtemp(prefix=f".{clone_location.name}.broken-", dir=clone_location.parent))
        try:
          os.rename(clone_location, trash / 'clone')
        except FileNotFoundError:
          pass # another worker replaced it
      try:
        os.rename(tmp_location, clone_location) # atomic
      except OSError:
        if not (clone_location / '.git').is_dir():
          raise
        print(f'{project_path} was cloned by another worker')
    finally:
      for location in (tmp_location, trash):
        if location and location.exists():
          rmtree(location)
    repo = Repo(str(clone_location))
    repo.git.update_environment(**host.git_env())
    return repo


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