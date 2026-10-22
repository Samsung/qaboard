import os
import subprocess
from pathlib import Path
from typing import Tuple, Optional, List

import click

from .compat import linux_to_windows


def git_show(format: str, reference: Optional[str] = None) -> str:
  """
  Wrapper around git show --format={format} [reference]

  https://git-scm.com/docs/git-show
  Common options:
    %H hash, %P parent hashes
    %an author name, %ae author email, %cn/%ce for commit
    %at author date t/i/D for timestamp/iso/..
    %B %s%b suject/body
  """
  command = ["git", "show", "-s", f"--format={format}"]
  if reference:
    command.append(reference)
  p = subprocess.run(
    command,
    encoding='utf8',
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
  )
  try:
    p.check_returncode()
  except Exception as e:
    if p.stdout:
      click.secho(p.stdout, fg='red', err=True)
    raise e
  return p.stdout.strip()


def git_parents(reference: str) -> List[str]:
  # returns a list of the parent hashes
  return git_show('%P', reference).split()


def git_remotes() -> List[str]:
  # returns a list of the remote names
  p = subprocess.run(
    ["git", "remote", "show"],
    encoding='utf8',
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    check=True,
  )
  return p.stdout.strip().splitlines()


def latest_commit(reference: str) -> str:
    """Returns the latest commit on a reference (commit, tag or branch)."""
    remotes = git_remotes()
    remote = remotes[-1] if remotes else None
    if len(remotes) > 1:
      click.secho(f"WARNING: Multiple remotes found, defaulting to {remote}", fg='yellow')

    if remote:
      p = subprocess.run(
        ["git", "ls-remote", remote, reference],
        encoding='utf8',
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
      )
      lines = p.stdout.strip().splitlines()
      if lines:
        return lines[0].split()[0]

    p = subprocess.run(
        ["git", "show", "-s", f"--format=%H", reference],
        encoding='utf8',
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    local_commit = p.stdout.strip()
    if local_commit:
      return local_commit
    return reference


def _safe_linux_to_windows(path: str) -> str:
  """On Windows, translate an absolute linux path in a .git pointer or commondir. Relative paths resolve as-is."""
  if os.name != 'nt' or not path.startswith(('/', '\\')):
    return path
  return linux_to_windows(path)


def git_dirs(repo_root: Path) -> Tuple[Path, Path]:
  """
  Return the git directory (HEAD) and the common directory (refs/, packed-refs) of a checkout.

  They differ in a git worktree: there .git is a file pointing to <main>/.git/worktrees/<name>,
  whose "commondir" file points back to the main repository's .git, where the branches live.
  In submodules, .git is also a file, pointing to a (often relative) path under the parent's .git/modules.
  """
  git_dir = repo_root / '.git'
  if git_dir.is_file():
    pointer = git_dir.read_text().strip()
    if pointer.startswith('gitdir:'):
      pointer = pointer[len('gitdir:'):].strip()
    pointer = _safe_linux_to_windows(pointer)
    git_dir = repo_root / pointer # stays absolute if the pointer is absolute
  # .git/worktrees/some-worktree/commondir points to the main repository's .git
  common_dir = git_dir
  commondir_path = git_dir / 'commondir'
  if commondir_path.is_file():
    common_dir = git_dir / _safe_linux_to_windows(commondir_path.read_text().strip())
  return git_dir, common_dir


def git_head(repo_root : Path) -> Tuple[str, str]:
  """Return the git ref and sha for the HEAD"""
  git_dir, common_dir = git_dirs(repo_root)
  with (git_dir / 'HEAD').open() as f:
    head_data = f.read().strip()
  if not head_data.startswith('ref: refs/heads/'):
    # detached HEAD
    return head_data, head_data
  commit_branch = head_data[16:]

  # We read the refs ourselves to avoid the overhead of calling git at import time
  for refs_dir in dict.fromkeys([git_dir, common_dir]):
    refs_head_path = refs_dir / 'refs' / 'heads' / commit_branch
    if refs_head_path.is_file():
      with refs_head_path.open() as f:
        return commit_branch, f.read().strip()

  packed_refs_path = common_dir / 'packed-refs'
  if packed_refs_path.exists():
    with packed_refs_path.open() as f:
      for line in f.readlines():
        if line.startswith('#'):
          continue
        try:
          hexsha, ref = line.strip().split(maxsplit=1)
          if ref == f"refs/heads/{commit_branch}":
            return commit_branch, hexsha
        except Exception:
            pass

  # Other ref storage backends (e.g. reftable), or layouts we don't know about
  p = subprocess.run(
    ["git", "rev-parse", "--verify", "--quiet", "HEAD"],
    cwd=repo_root,
    encoding='utf8',
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
  )
  if p.returncode == 0 and p.stdout.strip():
    return commit_branch, p.stdout.strip()
  # e.g. a branch without commits yet
  return commit_branch, commit_branch




class GitWrapperError(ValueError, AttributeError):
  """
  Raised by the _Repo/_Commit wrappers when GitPython can't give them what they wrap.
  It's also an AttributeError so that, like before, hasattr(config.repo, ...) is False outside a git repository
  (or without GitPython), and getattr(config.repo, name, default) returns the default.
  """


# for backward compatibility only
class _Repo(object):
  """Lazily wraps gitpython's Repo to avoid high import times and stay backward-compatible"""
  def __init__(self, repo_root):
    self.repo = None
    self.repo_root = repo_root

  def init(self):
    try:
      import git # GitPython is not a dependency of qaboard
      self.repo = git.Repo(str(self.repo_root))
    except Exception:
      self.repo = None

  def __getattribute__(self, name):
    if name in ['repo_root']:
      return object.__getattribute__(self, name)
    if not object.__getattribute__(self, 'repo'):
      object.__getattribute__(self, 'init')()

    repo = object.__getattribute__(self, 'repo')
    if not repo:
      raise GitWrapperError(f"ERROR: Not a git repository, or GitPython is not installed: {object.__getattribute__(self, 'repo_root')}")
    return getattr(repo, name)

# for backward compatibility only
class _Commit(object):
  """Lazily wraps gitpython's Commit to avoid high import times and stay backward-compatible"""
  def __init__(self, repo, commit_id):
    self.commit = None
    self.repo = repo
    self.commit_id = commit_id

  def init(self):
    try:
      self.commit = self.repo.commit(self.commit_id) if self.commit_id else self.repo.head.commit
    except Exception: # not a git repository, a commit missing from the clone...
      self.commit = None

  def __getattribute__(self, name):
    if name in ['commit_id', 'repo']:
      return object.__getattribute__(self, name)
    if not object.__getattribute__(self, 'commit'):
      object.__getattribute__(self, 'init')()

    commit = object.__getattribute__(self, 'commit')
    if not commit:
      raise GitWrapperError(f"ERROR: Could not init a GitPython Commit: {object.__getattribute__(self, 'commit_id')}")
    # getattr() and not __getattribute__: GitPython reads most attributes lazily, in __getattr__
    return getattr(commit, name)



# if __name__ == '__main__':
#   import fire
#   fire.Fire(latest_commit)
