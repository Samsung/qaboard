"""
Folder listings for the file browser, and which access rules apply to a path.

nginx serves the files under /s/ (the URL of /algo/x is /s/algo/x). For folders, browsers get
the web app's file browser, which asks the backend for the listing (see backend/api/files.py).
"""
import os
import re
import stat
from functools import lru_cache
from pathlib import Path
from typing import Dict, FrozenSet, List, NamedTuple, Optional, TypeVar
from urllib.parse import unquote, urlsplit

from . import accounts
from .config import storage_roots
from .storage import private_dirs


# Above this, we show the first entries and say the listing is truncated
MAX_ENTRIES = 100_000

T = TypeVar('T')


def normalize(path: str) -> str:
  """'/algo//x/../y/' => '/algo/y'"""
  return os.path.normpath('/' + path.lstrip('/'))


def path_from_url(url: str) -> Optional[str]:
  """The path of a file URL: '/s/algo/a%20b?x=1' => '/algo/a b'. None if it's not under /s/"""
  url_path = unquote(urlsplit(url).path)
  if url_path != '/s' and not url_path.startswith('/s/'):
    return None
  return normalize(url_path[2:])


def is_listable(path: str) -> bool:
  """We list the folders in the storage ($QABOARD_STORAGE_ROOTS), but not the server's own folders."""
  real = Path(os.path.realpath(path))
  if not any(real.is_relative_to(os.path.realpath(root)) for root in storage_roots):
    return False
  return not any(real.is_relative_to(private_dir) for private_dir in private_dirs())


# In folders from the storage settings, e.g. /algo/outputs/{user}/project
USER_PLACEHOLDER = '{user}'


def folder_for(pattern: str, path: str) -> Optional[str]:
  """
  The folder matching `pattern` that is `path` or contains it, where {user} matches any folder name.
  '/algo/outputs/{user}/repo', '/algo/outputs/alice/repo/run' => '/algo/outputs/alice/repo'. None if none.
  """
  if USER_PLACEHOLDER not in pattern:
    return pattern
  match = _folder_regex(pattern).match(path)
  return match.group(1) if match else None


@lru_cache(maxsize=4096)
def _folder_regex(pattern: str) -> re.Pattern:
  regex = re.escape(pattern.rstrip('/')).replace(re.escape(USER_PLACEHOLDER), '[^/]+')
  return re.compile(f'({regex})(?:/|$)')


def folder_and_parents(path: str) -> List[str]:
  """'/algo/x/y' => ['/algo/x/y', '/algo/x', '/algo']"""
  folders = []
  path = normalize(path)
  while path != '/':
    folders.append(path)
    path = os.path.dirname(path)
  return folders


def longest_prefix(path: str, prefixes: Dict[str, T]) -> Optional[T]:
  """The value of the most specific folder in `prefixes` that contains `path` (or is `path`)."""
  best, best_length = None, -1
  for prefix, value in prefixes.items():
    prefix = normalize(prefix)
    if (path == prefix or path.startswith(prefix.rstrip('/') + '/')) and len(prefix) > best_length:
      best, best_length = value, len(prefix)
  return best


class UnixAccount(NamedTuple):
  uid: int
  gids: FrozenSet[int]

# Users without an account (e.g. anonymous) only get the permissions of "others"
NOBODY = UnixAccount(uid=-1, gids=frozenset())


def unix_account(user_name: Optional[str]) -> UnixAccount:
  """The Unix account of a QA-Board user, see backend/accounts.py"""
  return _unix_account(user_name, accounts.version())

@lru_cache(maxsize=4096)
def _unix_account(user_name: Optional[str], accounts_version) -> UnixAccount:
  if not user_name:
    return NOBODY
  account = accounts.account(user_name)
  if not account:
    return NOBODY
  return UnixAccount(uid=account.uid, gids=accounts.group_ids(user_name, account.gid))


def _permissions(st: os.stat_result, account: UnixAccount) -> int:
  """The rwx bits that apply to the account, e.g. 0b101 for r-x"""
  if st.st_uid == account.uid:
    return (st.st_mode >> 6) & 0o7
  if st.st_gid in account.gids:
    return (st.st_mode >> 3) & 0o7
  return st.st_mode & 0o7


def unix_can_read(path: str, root: str, account: UnixAccount) -> bool:
  """
  Whether the account could read the file, or list the folder, at path: it needs to read it,
  and to traverse the folders above it, starting at root. Symlinks must be resolved already.
  ACLs are not supported. If the server can't see the file, we don't know: nginx can't send it either.
  """
  root, path = normalize(root), normalize(path)
  parts = path[len(root):].strip('/').split('/') if path != root else []
  folders = [root] + [os.path.join(root, *parts[:i]) for i in range(1, len(parts))]
  try:
    for folder in folders:
      if not _permissions(os.stat(folder), account) & 0o1:
        return False
    st = os.stat(path)
  except OSError:
    return True
  needed = 0o5 if stat.S_ISDIR(st.st_mode) else 0o4
  return _permissions(st, account) & needed == needed


def owner_name(uid: int) -> str:
  """The name of the user with this uid, else the uid"""
  return _owner_name(uid, accounts.version())

@lru_cache(maxsize=4096)
def _owner_name(uid: int, accounts_version) -> str:
  return accounts.user_name(uid) or str(uid)


def describe(entry: os.DirEntry) -> dict:
  item = {"name": entry.name}
  try:
    is_symlink = entry.is_symlink()
    try:
      st = entry.stat() # follows symlinks
      is_broken = False
    except OSError:
      st = entry.stat(follow_symlinks=False)
      is_broken = is_symlink
  except OSError:
    item["type"] = "other"
    return item
  if is_symlink:
    try:
      item["link"] = os.readlink(entry.path)
    except OSError:
      item["link"] = ""
    if is_broken:
      item["broken"] = True
  if stat.S_ISDIR(st.st_mode):
    item["type"] = "directory"
  elif stat.S_ISREG(st.st_mode):
    item["type"] = "file"
    item["size"] = st.st_size
  else:
    item["type"] = "other"
  item["mtime"] = int(st.st_mtime)
  item["owner"] = owner_name(st.st_uid)
  item["mode"] = stat.filemode(st.st_mode)
  return item


def list_directory(path: str, max_entries: int = MAX_ENTRIES) -> dict:
  """
  Raises FileNotFoundError, NotADirectoryError or PermissionError.
  """
  entries = []
  truncated = False
  with os.scandir(path) as it:
    for entry in it:
      if len(entries) >= max_entries:
        truncated = True
        break
      entries.append(describe(entry))
  return {
    "path": path,
    "entries": entries,
    "truncated": truncated,
  }
