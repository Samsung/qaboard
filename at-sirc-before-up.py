#!/usr/bin/env python
"""
Run this before calling `docker-compose up` at SIRC.

At SIRC we rely on auto-mounted volumes. Attempting to mount them before they are bound leads to "too many levels of symbolic links errors".
"""
from pathlib import Path
import yaml


sirc_config_path = Path(__file__).parent / 'sirc.yml'
with sirc_config_path.open() as f:
    sirc_config = yaml.load(f)
volumes = sirc_config['services']['proxy']['volumes']
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
            for dd in d.iterdir():
                print(f". . {dd}")
                # print(dd)
            ...
        except Exception as e:
            print(e)