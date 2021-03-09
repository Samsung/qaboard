"""
Usage:
- docker-compose -f docker-compose.yml -f development.yml -f sirc.yml run --no-deps backend bash
- [arthurf] python backend/scripts/fix-nobody-manifest.py
"""
import os
import json
import time
import datetime
from pathlib import Path

from sqlalchemy.orm.attributes import flag_modified
from sqlalchemy import text
from qaboard.utils import total_storage, save_outputs_manifest, outputs_manifest

from backend.models import Output
from backend.database import db_session, Session

db_session.autoflush = False

os.umask(0)



def get_storage(output):
  manifest_path = output.output_dir / 'manifest.outputs.json'
  if not output.output_dir.exists():
    return 0
  try:
    with manifest_path.open() as f:
      manifest = json.load(f)
  except: # e.g. if the manifest does not exist, if it is corrupted...
    manifest = outputs_manifest(output.output_dir)
  try:
    with manifest_path.open('w') as f:
      json.dump(manifest, f, indent=2)
  except Exception as e:
    print(f"[WARNING] Could not write the manifest: {e}")
  finally:
    return total_storage(manifest)


def migrate():
  outputs = (db_session.query(Output)
             .filter(text("outputs.created_date > now() - '2 days'::interval"))
             .order_by(Output.created_date.desc())
             .enable_eagerloads(False) 
  )
  updated = 0
  now = time.time()
  for idx, o in enumerate(outputs):
    #   try:
    manifest_path = o.output_dir / 'manifest.outputs.json'
    if 'C:\\' in str(manifest_path):
      continue
    if not manifest_path.exists() or manifest_path.owner() == 'nobody' or manifest_path.owner() == 'arthurf':
        print(o.id, o.output_dir)
        if manifest_path.exists():
            manifest_path.unlink()
        storage = get_storage(o)
        o.data['storage'] = storage
        db_session.add(o)
        flag_modified(o, "data")
        db_session.commit()
    #   except Exception as e:
    #     print("[Error-Skipping]", o, e)
    #     continue


  return updated


if __name__ == '__main__':
  while migrate():
    print('Still results to update...')


