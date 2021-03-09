"""
python add_storage_info.py

Usage:
- docker-compose -f docker-compose.yml -f development.yml -f sirc.yml run --no-deps backend bash
- [arthurf] python backend/scripts/add_output_data_storage.py 

- run staging
- deloy new cli
- run on prod
- migrate json->jsonb
- sql!
"""
import json
import time
import datetime

from sqlalchemy.orm.attributes import flag_modified
from sqlalchemy import text
from qaboard.utils import total_storage, save_outputs_manifest, outputs_manifest

from backend.models import Output
from backend.database import db_session, Session

db_session.autoflush = False


db_session
batch_size = 1_000


start = time.time()


def get_user(output):
  if output.output_dir.exists():
    return output.output_dir.owner()
  # TODO: fix the changed location with (output.output_dir.parent / input_path.name)
  # if output.batch.ci_commit.artifacts_dir.exists():
  #   return output.batch.ci_commit.artifacts_dir.owner()
  # TODO: 1. batch command 2. committer
  return None

def migrate():
  batch = []
  batch_size =           2_000
  # batch_size =         70000
  output_total = db_session.query(Output).filter(text("(data->'user') is null")).count()
  start_batch  = time.time()
  print(f'Without username {output_total}')

  outputs = (db_session.query(Output)
             .filter(text("(data->'user') is null"))
             .order_by(Output.created_date.desc())
             .enable_eagerloads(False) 
             .limit(10000)
  )
  updated = 0
  now = time.time()
  for idx, o in enumerate(outputs):
      # print(o)
      if o.data is None:
        o.data = {}
      # if '/' in o.batch.ci_commit.hexsha:
      #   continue

      try:
        print(o.output_dir)
        user = get_user(o)
        print(f"  User: {user}")
        # exit(0)
      except Exception as e:
        print("[Error-Skipping]", o, e)
        continue
      if not user:
        continue
      updated += 1
      batch.append({
        "id": o.id,
        "data": {
          **o.data,
          "user": user,
        }, 
      })
      if idx and idx % batch_size == 0:
          print(o)
          now = time.time()
          print(f"{idx/output_total:.1%} [{batch_size/(now - start_batch):.1f}/s] [est. total left {(now - start_batch) * ((output_total-idx)/batch_size) / 3600:.2f}h] [elapsed time: {now - start:.1f}s]")
          start_batch = now
          db_session.bulk_update_mappings(Output, batch)
          db_session.flush()
          batch = []
          # break

  print(f"DONE, now committing users [elapsed time: {now - start:.1f}s]")
  db_session.bulk_update_mappings(Output, batch)
  db_session.flush()
  db_session.commit()
  return updated



if __name__ == '__main__':
  print('Adding user info')
  while migrate():
    print('Still work to do...')
  exit(0)
