"""
python add_storage_info.py

53 * * * * cd qaboard && docker-compose -f docker-compose.yml -f development.yml -f sirc.yml exec -T backend python backend/scripts/add_output_data_storage.py  > /home/arthurf/add_storage.log 2>&1
Usage:
- docker-compose -f docker-compose.yml -f development.yml -f sirc.yml run --no-deps backend bash
- [arthurf] python backend/scripts/add_output_data_storage.py 

- run staging
- deloy new cli
- run on prod
- migrate json->jsonb
- sql!
"""
import os
import json
import time
import datetime

from sqlalchemy.orm.attributes import flag_modified
from sqlalchemy import text
from qaboard.utils import total_storage, save_outputs_manifest, outputs_manifest

from backend.models import Output
from backend.database import db_session, Session

db_session.autoflush = False

os.umask(0)

batch_size = 1_000
output_total = 1_700_000 # est.


start = time.time()


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
  batch = []
  batch_size =           500
  output_total = db_session.query(Output).filter(text("(data->'storage') is null")).count()
  start_batch  = time.time()
  print(f'Without storage {output_total}')

  outputs = (db_session.query(Output)
             .filter(text("(data->'storage') is null"))
            #  .filter(Output.is_pending==False)
            #  .filter(text("outputs.created_date < now() - '15 days'::interval"))
             .order_by(Output.created_date.desc())
            #  .limit(10000)
            #  .yield_per(batch_size)
             .enable_eagerloads(False) 
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
        if "C:\\" in str(o.output_dir):
          o.output_dir_override = o.output_dir_override.replace("\\", "/").replace("C:/netapp/algo_data", "/stage/algo_data")
          if not o.output_dir_override.startswith("/stage/algo_data"):
            continue
          else:
            db_session.add(o)
            db_session.commit()
        storage = get_storage(o)
        print(f"  Storage: {storage/1024/1024:.2f}MB at {o.output_dir}")
      except Exception as e:
        print("[Error-Skipping]", o, e)
        continue
      if storage is None:
        continue
      updated += 1
      batch.append({
        "id": o.id,
        "data": {
          **o.data,
          "storage": storage,
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

  print(f"DONE, now committing storage [elapsed time: {now - start:.1f}s]")
  db_session.bulk_update_mappings(Output, batch)
  db_session.flush()
  db_session.commit()
  return updated



if __name__ == '__main__':
  print('Adding storage info')
  while migrate():
    print('Still results to update...')
  exit(0)


  print("Starting migration")
  def query(since):
    print(since)
    return (db_session.query(Output)
            .enable_eagerloads(False)
            .filter(Output.created_date > since)
            .order_by(Output.created_date.desc())
            # .limit(batch_size)
            # .all()
            # .yield_per(batch_size)
    )

  print("Starting updates")
  most_recent = datetime.datetime.now() - datetime.timedelta(days=7)
  for idx, output in enumerate(query(most_recent)):
    if output.is_pending:
      continue
    if output.data.get('storage'):
      continue

    manifest_path = output.output_dir / 'manifest.outputs.json'
    if not manifest_path.exists():
      if not output.output_dir.exists():
        output.data['storage'] = 0
        db_session.add(output)
        flag_modified(output, "data")
        continue
      else:
        manifest = save_outputs_manifest(output.output_dir)
    else:
      with manifest_path.open() as f:
        manifest = json.load(f)
    manifest_path.chmod(0o777)

    output.data['storage'] = total_storage(manifest)
    flag_modified(output, "data")
    db_session.add(output)

    if idx % batch_size == 0:
      print(f"{idx/output_total:.1%}", output, f"{output.data['storage']/1024/1024:.01f} MB")


  db_session.commit()
