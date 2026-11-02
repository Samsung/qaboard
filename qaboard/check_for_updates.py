"""
Checks if an update is available, if yes prints a warning message to stderr.
To avoid introducing extra latency, we only check daily.

FIXME: users not connected to our internal network will pay a 1s timeout every time.

Sites can override where we look for the latest version (QABOARD_LATEST_VERSION_URL, a PyPI JSON API URL
or a file with `version = "x.y.z"`) and the upgrade command we suggest (QABOARD_UPGRADE_COMMAND).
"""
import os
import re
import json
import datetime

import click


def latest_qaboard_version():
  # Everybody install their own local version of qaboard,
  # at a different place on Windows, Linux...
  # We simple need a way to let them know they are using an old version
  import requests
  from .site_config import site_config
  url = site_config('QABOARD_LATEST_VERSION_URL', 'https://pypi.org/pypi/qaboard/json')
  try:
    r = requests.get(url, timeout=1)
    r.raise_for_status()
  except Exception as e:
    click.secho(f'WARNING: Unable to find latest qaboard version', fg='yellow', bold=True, err=True)
    click.secho(str(e), fg='yellow', err=True)
    return None
  try:
    return r.json()['info']['version']
  except Exception:
    pass
  for l in r.text.split('\n'):
    version = re.match(r'.*version\s*=\s*["\']([0-9]+\.[0-9]+\.[0-9]+)["\'].*', l)
    if version:
      return version.group(1)


def version_key(version: str):
  """
  What we compare versions with, or None if we can't understand it.
  Pre-releases and dev versions (1.2.3rc1, 1.2.3.dev4+g1234) come before their release, post-releases (1.2.3.post1) after.
  """
  match = re.match(r'v?(\d+(?:\.\d+)*)(.*)', version.strip())
  if not match:
    return None
  release = [int(n) for n in match.group(1).split('.')]
  while len(release) > 1 and release[-1] == 0: # 1.2 is 1.2.0
    release.pop()
  suffix = match.group(2).split('+')[0].lstrip('.-_').lower()
  rank = 2 if suffix.startswith('post') else 1 if not suffix else 0
  return (release, rank)


def check_for_updates():
  if 'QA_NO_CHECK_FOR_UPDATES' in os.environ:
    return
  # qaboard user configuration and related files is saved in standard locations
  from .site_config import user_config_dir
  qaboard_config_dir = user_config_dir()
  try:
    # it also holds logins (hosts.yaml)
    qaboard_config_dir.mkdir(mode=0o700, parents=True, exist_ok=True)
  except OSError: # e.g. a read-only home directory
    return

  # We cache the latest version found 
  qaboard_latest_update = qaboard_config_dir / 'latest-version'
  if qaboard_latest_update.exists():
    try:
      with qaboard_latest_update.open() as f:
        latest = json.load(f)
    except Exception: # eg CI starts multiple `qa` runs, and corruption from concurrent writes on an NFS drive...
      try:
        qaboard_latest_update.unlink()
      except Exception:
        pass
      latest = None
  else:
    latest = None

  # Check for a latest version at most daily
  now = datetime.datetime.now()
  seconds_since_last_check = (now - datetime.datetime.fromtimestamp(latest['when_checked'])).total_seconds() if latest else None
  if not latest or seconds_since_last_check > 3600 * 24:
    latest_version = latest_qaboard_version()
    if latest_version:
      with qaboard_latest_update.open('w') as f:
        json.dump({"version": latest_version, "when_checked": now.timestamp()}, f)
  else:
    latest_version = latest['version']


  from qaboard import __version__ as current_version
  if latest_version and current_version != 'unknown':
    current_key, latest_key = version_key(current_version), version_key(latest_version)
    newer_version_available = current_key is not None and latest_key is not None and current_key < latest_key
    if newer_version_available:
      click.secho(f'[INFO] A new version of qaboard is available! Upgrade to {latest_version}:', fg='yellow', bold=True, err=True)
      from .site_config import site_config
      upgrade_command = site_config('QABOARD_UPGRADE_COMMAND', 'pip install --upgrade qaboard')
      click.secho(f'       $ {upgrade_command}', fg='yellow', err=True)
