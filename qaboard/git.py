import subprocess
from pathlib import Path
from typing import Tuple, Optional, Dict, List

import click


def git_show(format: str, reference: str = None) -> str:
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
    check=True,
  )
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


def git_head(repo_root : Path) -> Tuple[str, str]:
  """Return the git ref and sha for the HEAD""" 
  with (repo_root / '.git' / 'HEAD').open() as f:
    head_data = f.read().strip()
    if head_data.startswith('ref: refs/heads/'):
      commit_branch = head_data[16:]
    else:
      commit_branch = head_data

  # Maybe we should just call "git rev-parse HEAD" from repo_root,
  # there cant be that much overhead and it won't be as fragile...
  refs_head_path = repo_root / '.git' / 'refs' / 'heads' / commit_branch
  if refs_head_path.exists():
    with refs_head_path.open() as f:
      return commit_branch, f.read().strip()

  packed_refs_path = repo_root / '.git' / 'packed-refs'
  if packed_refs_path.exists():
    with packed_refs_path.open() as f:
      for line in f.readlines():
        if line.startswith('#'):
          continue
        try:
          hexsha, ref = line.strip().split(maxsplit=1)
          if ref == f"refs/heads/{commit_branch}":
            return commit_branch, hexsha
        except:
            pass
  return commit_branch, commit_branch


# if __name__ == '__main__':
#   import fire
#   fire.Fire(latest_commit)