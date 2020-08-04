"""
python add_storage_info.py

# python ./backend/scripts/save_all_directories.py
"""
import json
import time
import datetime

from sqlalchemy.orm.attributes import flag_modified
from sqlalchemy import text
from qaboard.utils import total_storage, save_outputs_manifest

from backend.models import Output, Batch, CiCommit
from backend.database import db_session, Session

db_session.autoflush = False


# Update all past outputs with dir over

start = time.time()


def migrate():
  batch = []
  batch_size =   500
  # batch_size = 1_000
  # batch_size = 70_000
  print(f'TOTAL {db_session.query(Output).count()}')
  output_total = db_session.query(Output).filter(text("output_dir_override is null")).count()
  start_batch  = time.time()
  print(f'without overrides: {output_total}')

  outputs = (db_session.query(Output)
             .filter(text("output_dir_override is null"))
             .order_by(Output.created_date.desc())
             .limit(100000)
            #  .yield_per(batch_size)
            #  .enable_eagerloads(False)
  )
  updated = 0
  now = time.time()
  for idx, o in enumerate(outputs):
      # print(f"{o.output_dir_override} => {o.output_dir}")
      # o.output_dir_override = str(o.output_dir)
      try:
        output_dir = o.output_dir
      except Exception as e:
        if not( "poc" in o.batch.ci_commit.project.id or "arthur" in o.batch.ci_commit.project.id) :
          print(f"WTF {o.batch.ci_commit} in {o.batch.ci_commit.project}")
          print(e)
        continue
      updated += 1
      batch.append({
        "id": o.id,
        "output_dir_override": str(output_dir),
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

print('Adding output directories')
# while migrate():
#   print('Updating...')



def migrate_batch():
  batch = []
  batch_size =   500
  print(f'TOTAL {db_session.query(Batch).count()}')
  total = db_session.query(Batch).filter(text("batch_dir_override is null")).count()
  start_batch  = time.time()
  print(f'without overrides: {total}')

  batches = (db_session.query(Batch)
             .filter(text("batch_dir_override is null"))
             .order_by(Batch.created_date.desc())
             .limit(20000)
            #  .yield_per(batch_size)
            #  .enable_eagerloads(False)
  )
  updated = 0
  now = time.time()
  for idx, b in enumerate(batches):
      try:
        batch_dir = b.batch_dir
      except Exception as e:
        if not( "poc" in b.ci_commit.project.id or "arthur" in b.ci_commit.project.id) :
          print(f"WTF {b.ci_commit} in {b.ci_commit.project}")
          print(e)
        continue
      # print(f"{b.batch_dir_override} => {batch_dir}")
      # exit(0)
      updated += 1
      batch.append({
        "id": b.id,
        "batch_dir_override": str(batch_dir),
      })
      if idx and idx % batch_size == 0:
          print(b)
          now = time.time()
          print(f"{idx/total:.1%} [{batch_size/(now - start_batch):.1f}/s] [est. total left {(now - start_batch) * ((total-idx)/batch_size) / 3600:.2f}h] [elapsed time: {now - start:.1f}s]")
          start_batch = now
          db_session.bulk_update_mappings(Batch, batch)
          db_session.flush()
          batch = []
          # break

  print(f"DONE, now committing configurations [elapsed time: {now - start:.1f}s]")
  db_session.bulk_update_mappings(Batch, batch)
  db_session.flush()
  db_session.commit()
  return updated

print('Adding batch directories')
while migrate_batch():
  print('Updating...')







def migrate_commits():
  batch = []
  batch_size =   500
  total = db_session.query(CiCommit).filter(text("commit_dir_override is null")).count()
  start_batch  = time.time()
  print(f'without overrides: {total}')

  commits = (db_session.query(CiCommit)
             .filter(text("commit_dir_override is null"))
             .order_by(CiCommit.authored_datetime.desc())
             .limit(20000)
  )
  updated = 0
  now = time.time()
  for idx, c in enumerate(commits):
      try:
        artifacts_dir = c.artifacts_dir
      except Exception as e:
        if not( "poc" in c.project.id or "arthur" in c.project.id) :
          print(f"WTF {c} in {c.project}")
          print(e)
        continue
      # print(f"{c.commit_dir_override} => {artifacts_dir}")
      # continue
      # exit(0)

      updated += 1
      batch.append({
        "id": c.id,
        "commit_dir_override": str(artifacts_dir),
      })
      if idx and idx % batch_size == 0:
          print(c)
          now = time.time()
          print(f"{idx/total:.1%} [{batch_size/(now - start_batch):.1f}/s] [est. total left {(now - start_batch) * ((total-idx)/batch_size) / 3600:.2f}h] [elapsed time: {now - start:.1f}s]")
          start_batch = now
          db_session.bulk_update_mappings(Batch, batch)
          db_session.flush()
          batch = []
          # break

  print(f"DONE, now committing configurations [elapsed time: {now - start:.1f}s]")
  db_session.bulk_update_mappings(CiCommit, batch)
  db_session.flush()
  db_session.commit()
  return updated

print('Adding commits directories')
while migrate_commits():
  print('Updating...')
