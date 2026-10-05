#!/usr/bin/env python
"""
Run this before calling `docker compose up` at SIRC.

At SIRC we rely on auto-mounted volumes. Attempting to mount them before they are bound leads to "too many levels of symbolic links errors".

It's slow: with --if-stale (used by deployments/deploy.py), it does nothing if it already ran on this host
since the last reboot and in the last day.
"""
import os
import sys
import time
from pathlib import Path
import yaml


MAX_AGE = 24 * 3600
# Per host (/tmp is local) and per user (others can't overwrite our file)
stamp = Path(f"/tmp/qaboard-at-sirc-before-up.{os.getuid()}.stamp")

def boot_time() -> float:
    with open("/proc/stat") as f:
        for line in f:
            if line.startswith("btime "):
                return float(line.split()[1])
    return time.time()  # unknown: never skip

if '--if-stale' in sys.argv:
    try:
        last_run = stamp.stat().st_mtime
    except OSError:
        last_run = 0
    if last_run > boot_time() and time.time() - last_run < MAX_AGE:
        print(f"Skipped: already ran at {time.ctime(last_run)}, since the last reboot. Run without --if-stale to force.", file=sys.stderr)
        sys.exit(0)


sirc_config_path = Path(__file__).parent / 'deployments' / 'sirc' / 'sirc.yml'
with sirc_config_path.open() as f:
    sirc_config = yaml.safe_load(f)
volumes = sirc_config['services']['proxy']['volumes']
volumes.append("/home:/home")
volumes = [Path(v.split(':')[0]) for v in volumes]

for v in volumes:
    if "dockermounts" in str(v):
        continue
    print(v)
    if v.is_file():
        continue
    for d in v.iterdir():
        print(f". {d}")
        if d.is_file():
            continue
        try:
            if '--shallow' in sys.argv:
                continue
            for dd in d.iterdir():
                print(f". . {dd}")
                # print(dd)
            ...
        except Exception as e:
            print(e)

try:
    stamp.touch()
except OSError as e:
    print(f"WARNING: could not write {stamp}: {e}", file=sys.stderr)
