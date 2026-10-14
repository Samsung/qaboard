"""
Tests for backend/accounts.py: users' accounts from commands (e.g. `ssh host getent passwd`), refreshed daily.
"""
import os
import time
from pathlib import Path

import pytest

from backend import accounts, files


PASSWD = "\n".join([
  "root:x:0:0:root:/root:/bin/bash",
  "alice:*:1000:100:Alice:/home/alice:/bin/bash",
  "bob:*:1001:100::/home/bob:/bin/tcsh",
  "# comment",
  "broken line",
  "carol:*:notanumber:100::/home/carol:/bin/sh",
]) + "\n"
GROUP = "users:x:100:\nalgo:*:2000:alice,bob\nsecret:*:3000:alice\n"


@pytest.fixture
def commands(tmp_path, monkeypatch):
  """The accounts and groups commands print files that tests can change"""
  (tmp_path / "passwd.txt").write_text(PASSWD)
  (tmp_path / "group.txt").write_text(GROUP)
  monkeypatch.setattr(accounts, "accounts_command", f"cat {tmp_path / 'passwd.txt'}")
  monkeypatch.setattr(accounts, "groups_command", f"cat {tmp_path / 'group.txt'}")
  monkeypatch.setattr(accounts, "accounts_dir", tmp_path / "accounts")
  monkeypatch.setattr(accounts, "_state", {"accounts": accounts.EMPTY, "mtimes": None, "checked": 0.0, "refreshing": False, "failed": None})
  # the tests refresh synchronously
  monkeypatch.setattr(accounts, "_refresh_in_background", lambda: None)
  files._owner_name.cache_clear()
  files._unix_account.cache_clear()
  yield tmp_path
  files._owner_name.cache_clear()
  files._unix_account.cache_clear()


def reload():
  accounts._state["checked"] = 0.0


def test_parse_passwd():
  parsed = accounts.parse_passwd(PASSWD)
  assert sorted(parsed) == ["alice", "bob", "root"]
  assert parsed["alice"] == accounts.Account("alice", 1000, 100)


def test_parse_group():
  assert accounts.parse_group(GROUP) == {"alice": frozenset([2000, 3000]), "bob": frozenset([2000])}


def test_refresh(commands):
  assert accounts.refresh()
  reload()
  assert accounts.user_name(1001) == "bob"
  assert accounts.account("alice") == accounts.Account("alice", 1000, 100)
  assert accounts.group_ids("alice", 100) == frozenset([100, 2000, 3000])
  assert files.owner_name(1000) == "alice"
  assert files.unix_account("bob") == files.UnixAccount(uid=1001, gids=frozenset([100, 2000]))
  # unknown users fall back to the server's files, then to the uid
  assert files.owner_name(0) == "root"
  assert files.owner_name(987654) == "987654"
  assert files.unix_account("nobody-knows-me") == files.NOBODY


def test_new_users_show_up_after_a_refresh(commands):
  assert accounts.refresh()
  reload()
  assert files.owner_name(1002) == "1002"
  (commands / "passwd.txt").write_text(PASSWD + "dave:*:1002:100::/home/dave:/bin/sh\n")
  assert accounts.refresh(force=True)
  # another second, so that the file's mtime changes even on coarse filesystems
  os.utime(commands / "accounts/passwd", (time.time() + 1, time.time() + 1))
  reload()
  assert files.owner_name(1002) == "dave"


def test_ssh_banners_and_noise_are_ignored(commands, monkeypatch):
  noise = "\n".join([
    "*** Authorized users only: activity: may be monitored ***",
    "Last login: Thu Oct  8 12:00:00 2026 from 10.0.0.1",
    "WARNING: this host: reboots: Sunday",
    "",
  ])
  (commands / "passwd.txt").write_text(noise + PASSWD + noise)
  (commands / "group.txt").write_text(noise + GROUP)
  # sshd's Banner goes to stderr
  monkeypatch.setattr(accounts, "accounts_command", f"echo 'Welcome: to: the: cluster' >&2; cat {commands / 'passwd.txt'}")
  assert accounts.refresh()
  reload()
  assert sorted(accounts._load().by_name) == ["alice", "bob", "root"]
  assert accounts.group_ids("alice", 100) == frozenset([100, 2000, 3000])
  assert accounts.count_groups(noise + GROUP) == 3


def test_refresh_only_when_stale(commands):
  assert accounts.refresh()
  (commands / "passwd.txt").write_text(PASSWD + "dave:*:1002:100::/home/dave:/bin/sh\n")
  assert accounts.refresh() # recent enough: nothing to do
  assert "dave" not in (commands / "accounts/passwd").read_text()


@pytest.mark.parametrize("output", [
  "",                                          # nothing
  "alice:*:1000:100:Alice:/home/alice:/bin/bash\n", # truncated
])
def test_keeps_the_previous_accounts_if_the_output_looks_wrong(commands, output):
  assert accounts.refresh()
  (commands / "passwd.txt").write_text(output)
  assert not accounts.refresh(force=True)
  assert (commands / "accounts/passwd").read_text() == PASSWD


def test_keeps_the_previous_accounts_if_the_command_fails(commands, monkeypatch):
  assert accounts.refresh()
  monkeypatch.setattr(accounts, "accounts_command", "echo 'ssh: connect to host: timeout' >&2; exit 255")
  assert not accounts.refresh(force=True)
  assert (commands / "accounts/passwd").read_text() == PASSWD


def test_without_command(tmp_path, monkeypatch):
  monkeypatch.setattr(accounts, "accounts_command", "")
  monkeypatch.setattr(accounts, "accounts_dir", tmp_path / "accounts")
  assert accounts.refresh()
  assert not (tmp_path / "accounts").exists()
