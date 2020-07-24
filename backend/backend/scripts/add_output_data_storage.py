"""
python add_storage_info.py


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
from qaboard.utils import total_storage, save_outputs_manifest

from backend.models import Output
from backend.database import db_session, Session

db_session.autoflush = False


db_session
batch_size = 1_000
output_total = 1_700_000 # est.


start = time.time()
print('Adding storage info')


def get_storage(output):
  manifest_path = output.output_dir / 'manifest.outputs.json'
  if not manifest_path.exists():
    if not output.output_dir.exists():
      return 0
    else:
      manifest = save_outputs_manifest(output.output_dir)
  else:
    with manifest_path.open() as f:
      try:
        manifest = json.load(f)
      except: # hello corrupted file
        manifest = save_outputs_manifest(output.output_dir)
  return total_storage(manifest)


def migrate():
  batch = []
  batch_size =         500
  batch_size =         70000
  print(f'TOTAL {db_session.query(Output).count()}')
  output_total = db_session.query(Output).filter(text("(data->'storage') is null")).filter(Output.is_pending==False).count()
  start_batch  = time.time()
  print(f'without storage {output_total}')

  outputs = (db_session.query(Output)
             .filter(text("(data->'storage') is null"))
             .filter(Output.is_pending==False)
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
        storage = get_storage(o)
      except Exception as e:
        print("error", o, e)
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

  print(f"DONE, now committing configurations [elapsed time: {now - start:.1f}s]")
  db_session.bulk_update_mappings(Output, batch)
  db_session.flush()
  db_session.commit()
  return updated


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

  output.data['storage'] = total_storage(manifest)
  flag_modified(output, "data")
  db_session.add(output)

  if idx % batch_size == 0:
    print(f"{idx/output_total:.1%}", output, f"{output.data['storage']/1024/1024:.01f} MB")


db_session.commit()
