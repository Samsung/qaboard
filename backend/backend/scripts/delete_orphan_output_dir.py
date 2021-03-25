"""
docker-compose -f docker-compose.yml -f development.yml -f sirc.yml run --user=root --rm --no-deps -v /home/arthurf/qaboard/services/backend/passwd:/etc/passwd -e QABOARD_DATA_GIT_DIR=/home/arthurf -e MIGRATION_PROJECT backend python /qaboard/backend/backend/scripts/delete_orphan_output_dir.py
"""
import os
import sys
import shutil
from pathlib import Path

from backend.models import Output
from backend.database import db_session, Session
from backend.fs_utils import as_user, rm_empty_parents, rmtree




root = Path("/algo/HP1/outputs")
# root = Path("/algo/HM6/outputs/omera/CDE-Users/HW_ALG/81/96978392ec9c86/CIS/tests/products/HM6/output")
root = Path("/algo/CIS/outputs/sircdevops")

# output_dir_file = "run.json"
# output_dir_file = "kiwi_log.txt"
output_dir_file = "manifest.outputs.json"

def delete(output_dir: Path):
    for path in output_dir.iterdir():
        if path.name == output_dir_file:
            continue
        owner = path.owner()
        def _delete(path):
            if path.is_dir():
                shutil.rmtree(path)
            else:
                path.unlink()
        try:
            _delete(path)
        except:
            as_user(owner, _delete, path)
    as_user((output_dir / output_dir_file).owner(), lambda p: p.unlink(), output_dir / output_dir_file)
    # it causes the glob to fail...
    # rm_empty_parents(path)

directories = list(root.rglob(output_dir_file))
print(f"{len(directories)} directories will be checked")
errors = []
for run_json in directories:
    output_dir = run_json.parent
    output = None
    try:
        output = db_session.query(Output).filter(Output.output_dir_override==str(output_dir)).one_or_none()
    except Exception as e:
        print("ERROR:", output_dir)
        print(e)
    if not output:
        print(f"? {output_dir}")
        try:
            rmtree(output_dir)
        except:
            errors.append(output_dir)
for error in errors:
    print(error)

# in algo/hm6/omera still more that what should be...
# find /algo/HM6/outputs -name omera > omera.txt

# ? data folder / version