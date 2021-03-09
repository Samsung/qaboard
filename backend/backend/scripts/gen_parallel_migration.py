#!/usr/bin/env python
"""
Usage:
  cd qaboard
  ./backend/backend/scripts/gen_parallel_migration.py CDE-Users/HW_ALG/CIS 10
  ./backend/backend/scripts/gen_parallel_migration.py --all 10
  bash migration/start.sh

Needs a server to sync user quotas..
- python backend/backend/scripts/user_storage_server.py
- update the server location in migrate.py with QUOTA_SERVER

Note:
- Best not run this on the production server, just in case
"""
import os
import sys
from pathlib import Path


def gen_script(project, parallel_jobs, start=False):
  yamls = "-f docker-compose.yml -f development.yml -f sirc.yml"
  start_script = ""
  migration_dir = Path('migration')
  migration_dir.mkdir(exist_ok=True)

  for i in range(parallel_jobs):
    project_name = project.split('/')[-1]
    logs = migration_dir / f"{project_name}-{i:02}.txt"
    script = migration_dir / f"{project_name}-{i:02}.sh"
    with script.open('w') as f:
      f.write(f"""#!/bin/bash
set -x
export MIGRATION_PROJECT={project}
export MIGRATION_JOBS={parallel_jobs}
export MIGRATION_INDEX={i}

# Avoid "Too many levels of symbolic links" errors
./at-sirc-before-up.py --shallow > /dev/null

docker-compose {yamls} pull backend
docker-compose {yamls} run --rm --user=root --no-deps -v /home/arthurf/qaboard/services/backend/passwd:/etc/passwd -e QABOARD_DATA_GIT_DIR=/home/arthurf -e MIGRATION_PROJECT -e MIGRATION_INDEX -e MIGRATION_JOBS backend /qaboard/backend/backend/scripts/migrate.py
# docker-compose {yamls} down -v
""")
    command = f" bsub -q alg_isp_q -P migration -o {logs} bash {script}"
    start_script += f"{command}\n"

  start_script_path = migration_dir / f"{project_name}-start.sh"
  with start_script_path.open('w') as f:
      f.write(start_script)
  start_command = f"bash {start_script_path}"
  print("# To start the migration, run:")
  print(start_command)
  os.system(start_command)


if len(sys.argv) < 2:
  print("ERROR: Usage is gen_parallel_migration.py $project [nb_parallel_jobs=1]")
  sys.exit(1)
parallel_jobs = int(sys.argv[2]) if len(sys.argv) > 2 else 1

project  = sys.argv[1]
if project != "--all":
  gen_script(project, parallel_jobs=parallel_jobs)
else:
  # import requests
  # projects = requests.get("https://qa/api/v1/projects", verify=False).json()
  projects = [
    # "CDE-Users/HW_ALG/CIS/tests/products/HM2", 8T 38k .
    # "CDE-Users/HW_ALG/CIS/tests/products/HM3", 18T 126k
    # "CDE-Users/HW_ALG/CIS/tests/products/HP1", 13T 57k
    # "CDE-Users/HW_ALG/PSP_2x", 3.8T 270k .
    # "CDE-Users/HW_ALG/PSP_2x/tests/products/ASPv43", 1T 20k     .
    # "LSC/Calibration",
    # "tof/swip_tof",
    # "tof/python_isp_chain",
    # "dvs/SIRC-VINS",
  ]
  for project in projects:
    if "HW_ALG" in project:
      print(f"Migrating {project}")
      gen_script(project, parallel_jobs=parallel_jobs, start=True)
