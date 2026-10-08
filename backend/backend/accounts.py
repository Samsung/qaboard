"""
The users' Unix accounts: who owns the files in the file browser, and what users can read in the folders of
QABOARD_FILES_UNIX_PERMISSIONS.

By default they come from the server's /etc/passwd and /etc/group. With a directory service (LDAP, SSSD, NIS...)
there is usually no complete file to mount. Then:
- QABOARD_ACCOUNTS_COMMAND prints the accounts, like /etc/passwd, e.g. `ssh some-host getent passwd`
- QABOARD_GROUPS_COMMAND (optional) prints the groups, like /etc/group, e.g. `ssh some-host getent group`
The backend runs them in the background when their last output is older than QABOARD_ACCOUNTS_REFRESH seconds
(default: a day), and saves it in the shared data folder: one run serves all the workers and replicas.
If a command fails, or prints much less than last time, we keep the previous output.
Accounts that the commands don't know fall back to the server's own files.
"""
import fcntl
import grp
import os
import pwd
import subprocess
import threading
import time
from pathlib import Path
from typing import Dict, FrozenSet, NamedTuple, Optional, Set

from .config import qaboard_data_shared_dir


accounts_command = os.environ.get('QABOARD_ACCOUNTS_COMMAND', '')
groups_command = os.environ.get('QABOARD_GROUPS_COMMAND', '')
refresh_interval = int(os.environ.get('QABOARD_ACCOUNTS_REFRESH', 24 * 3600))
accounts_dir = Path(os.environ.get('QABOARD_ACCOUNTS_DIR', qaboard_data_shared_dir / 'accounts'))
COMMAND_TIMEOUT = 600 # seconds
CHECK_EVERY = 30 # seconds, how often we check whether another process updated the files
RETRY_AFTER = 600 # seconds, after the commands failed


class Account(NamedTuple):
  name: str
  uid: int
  gid: int


class Accounts(NamedTuple):
  by_uid: Dict[int, Account]
  by_name: Dict[str, Account]
  groups: Dict[str, FrozenSet[int]] # user name => the groups they're a member of (besides their primary group)

EMPTY = Accounts({}, {}, {})


def parse_passwd(text: str) -> Dict[str, Account]:
  """
  The accounts in a passwd file: name:password:uid:gid:gecos:home:shell
  Other lines are ignored, e.g. banners or messages from shell startup files when the command uses ssh.
  """
  accounts = {}
  for line in text.splitlines():
    fields = line.strip().split(':')
    if len(fields) != 7 or not fields[0] or ' ' in fields[0] or line.startswith('#'):
      continue
    try:
      accounts.setdefault(fields[0], Account(fields[0], int(fields[2]), int(fields[3])))
    except ValueError:
      continue
  return accounts


def parse_group(text: str) -> Dict[str, FrozenSet[int]]:
  """{user name: gids} from a group file: name:password:gid:member1,member2"""
  memberships: Dict[str, Set[int]] = {}
  for line in text.splitlines():
    fields = line.strip().split(':')
    if len(fields) != 4 or not fields[0] or ' ' in fields[0] or line.startswith('#'):
      continue
    try:
      gid = int(fields[2])
    except ValueError:
      continue
    for member in fields[3].split(','):
      if member.strip():
        memberships.setdefault(member.strip(), set()).add(gid)
  return {name: frozenset(gids) for name, gids in memberships.items()}


def count_groups(text: str) -> int:
  count = 0
  for line in text.splitlines():
    fields = line.strip().split(':')
    if len(fields) == 4 and fields[0] and ' ' not in fields[0] and fields[2].isdigit():
      count += 1
  return count


_lock = threading.Lock()
_state = {"accounts": EMPTY, "mtimes": None, "checked": 0.0, "refreshing": False, "failed": None}


def _mtimes():
  try:
    return tuple(os.stat(accounts_dir / name).st_mtime for name in ('passwd', 'group') if (accounts_dir / name).exists())
  except OSError:
    return None


def _load() -> Accounts:
  """The accounts from the commands' last output, re-read when it changes."""
  now = time.monotonic()
  if now - _state["checked"] < CHECK_EVERY:
    return _state["accounts"]
  _state["checked"] = now
  mtimes = _mtimes()
  if mtimes != _state["mtimes"]:
    by_name, groups = {}, {}
    try:
      by_name = parse_passwd((accounts_dir / 'passwd').read_text(errors='replace'))
      if (accounts_dir / 'group').exists():
        groups = parse_group((accounts_dir / 'group').read_text(errors='replace'))
    except OSError:
      pass
    by_uid: Dict[int, Account] = {}
    for account in by_name.values():
      by_uid.setdefault(account.uid, account)
    _state.update(accounts=Accounts(by_uid, by_name, groups), mtimes=mtimes)
  if accounts_command:
    _refresh_in_background()
  return _state["accounts"]


def version():
  """Changes when the accounts change, to invalidate caches."""
  _load()
  return _state["mtimes"]


def is_stale(path: Path) -> bool:
  try:
    return time.time() - path.stat().st_mtime > refresh_interval
  except OSError:
    return True


def _run(command: str) -> str:
  out = subprocess.run(command, shell=True, capture_output=True, encoding='utf-8', errors='replace', timeout=COMMAND_TIMEOUT)
  if out.returncode != 0:
    raise RuntimeError(f"exit code {out.returncode}: {out.stderr.strip()[-500:]}")
  return out.stdout


def _save(name: str, text: str, count: int, previous_count: int):
  # A truncated output (network issue...) would make users lose access to their files
  if count == 0 or count < previous_count / 2:
    raise RuntimeError(f"only {count} entries, vs {previous_count} last time")
  tmp = accounts_dir / f'.{name}.tmp'
  tmp.write_text(text)
  os.replace(tmp, accounts_dir / name)


def refresh(force=False) -> bool:
  """
  Runs the commands and saves their output, unless another process does it, or it's recent enough.
  False if the commands failed.
  """
  if not accounts_command:
    return True
  accounts_dir.mkdir(parents=True, exist_ok=True)
  with open(accounts_dir / '.lock', 'w') as lock:
    try:
      fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except OSError:
      return True # another worker or replica is at it
    if not force and not is_stale(accounts_dir / 'passwd'):
      return True
    started = time.time()
    try:
      previous = len(parse_passwd((accounts_dir / 'passwd').read_text(errors='replace'))) if (accounts_dir / 'passwd').exists() else 0
      text = _run(accounts_command)
      _save('passwd', text, len(parse_passwd(text)), previous)
      if groups_command:
        previous = count_groups((accounts_dir / 'group').read_text(errors='replace')) if (accounts_dir / 'group').exists() else 0
        text = _run(groups_command)
        _save('group', text, count_groups(text), previous)
      print(f"[accounts] updated in {time.time() - started:.1f}s")
    except Exception as e:
      print(f"[accounts] ERROR: could not update the accounts, we keep the previous ones: {e}")
      return False
  _state["checked"] = 0.0
  return True


def _refresh_in_background():
  if not is_stale(accounts_dir / 'passwd'):
    return
  if _state["failed"] is not None and time.monotonic() - _state["failed"] < RETRY_AFTER:
    return
  with _lock:
    if _state["refreshing"]:
      return
    _state["refreshing"] = True
  def target():
    try:
      _state["failed"] = None if refresh() else time.monotonic()
    finally:
      _state["refreshing"] = False
  threading.Thread(target=target, name="accounts-refresh", daemon=True).start()


def user_name(uid: int) -> Optional[str]:
  """The name of the account with this uid, None if unknown"""
  account = _load().by_uid.get(uid)
  if account:
    return account.name
  try:
    return pwd.getpwuid(uid).pw_name
  except KeyError:
    return None


def account(name: str) -> Optional[Account]:
  account = _load().by_name.get(name)
  if account:
    return account
  try:
    entry = pwd.getpwnam(name)
  except KeyError:
    return None
  return Account(name, entry.pw_uid, entry.pw_gid)


def group_ids(name: str, gid: int) -> FrozenSet[int]:
  """The groups of a user: their primary group, and those they are a member of"""
  accounts = _load()
  if name in accounts.by_name and groups_command:
    return frozenset([gid, *accounts.groups.get(name, ())])
  try:
    return frozenset(os.getgrouplist(name, gid))
  except OSError:
    return frozenset([gid, *(g.gr_gid for g in grp.getgrall() if name in g.gr_mem)])
