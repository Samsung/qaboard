import subprocess
from pathlib import Path
from typing import Tuple, Optional, Dict


def git_show(format: str) -> str:
  # https://git-scm.com/docs/git-show
  # Common options:
  # %H hash, %P parent hashes
  # %an author name, %ae author email, %cn/%ce for commit
  # %at author date t/i/D for timestamp/iso/..
  # %B %s%b suject/body
  p = subprocess.run(
    ["git", "show", "-s", f"--format={format}"],
    encoding='utf8',
    stdout=subprocess.PIPE,
    stderr=subprocess.PIPE,
    check=True,
  )
  return p.stdout.strip()




def latest_commit(repo, reference):
    """Returns the latest commit on a reference (commit, tag or branch)."""
    # FIXME: couldn't we just use the project's git repo URL from the configuration?
    # Here we find a local copy of the repo and use it to iterate through commits
    # TODO: we should use the branch slug.... but it will work for develop/master/release...
    remote = repo.remote()
    try:
      return remote.refs[reference].commit
    except:
      try:
        # print([r.name for r in remote.refs if ('testing' in r.name)])
        # print([r for r in remote.refs if r.name==reference or r.name==f'{r.remote_name}/{reference}'])
        return [r for r in remote.refs if r.name==reference or reference.replace(r.remote_name, '') == r.name or reference==f'{r.remote_name}/{r.name}'][0]
      except:
        return repo.commit(rev=reference)
    # try:/
    #   return list(repo.iter_commits(reference.replace('origin/', ''), max_count=1))[0]


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






