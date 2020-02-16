#!/usr/bin/env python
"""
This scrip fixed a race condition that caused duplicated batches
 /opt/anaconda3/bin/python /home/arthurf/qaboard/backend/backend/remove_duplicates.py --dryrun
"""
import click
from click import secho
from sqlalchemy import func, and_, asc, or_
from sqlalchemy.sql import text

from backend.database import db_session, Session
from backend.models import Project, CiCommit, Batch, Output

# Testing
# ssh 
# sudo cp /home/arthurf/dvs/backend/backend/clean.py /backend/backend/
# backend_clean --dryrun


# Find duplicates:
#  ssh arthurf-vdi ; screen -r
# SELECT ci_commit_id, label, count(*) as qty FROM batches GROUP BY ci_commit_id, label HAVING count(*)> 1;
SELECT database, path, count(*) as qty FROM test_inputs GROUP BY database, path HAVING count(*)> 1;
# TOCO:
# 1.  find duplicates
# 2.  Merge

# CREATE UNIQUE INDEX CONCURRENTLY _ci_commit_id__label ON batches (ci_commit_id, label);


@click.command()
# @click.option('--commit-id', 'commit_id')
# @click.option('--label')
@click.option('--dryrun', is_flag=True)
def merge_duplicates(dryrun):
  # batches = (db_session.query(Batch)\
  #                     .filter(CiCommit.id == commit_id, Batch.label == label)\
  #                     .all())
  sql = "SELECT ci_commit_id, label, count(*) as qty FROM batches GROUP BY ci_commit_id, label HAVING count(*)> 1;"
  result = db_session.execute(sql)
  duplicates = list(result)
  # for commit_id, label, count in duplicates:
  #   print(commit_id, label, count)
  print(len(duplicates), "duplicates")

  for commit_id, label, count in duplicates:
    print(f"commit_id: {commit_id}, label={label}, count={count}")
    # .filter(and_(CiCommit.id == commit_id, Batch.label == label))\
    batches = (db_session.query(Batch)\
                        .join(CiCommit)\
                        .filter(Batch.label == label)\
                        .filter(CiCommit.id == commit_id)\
                        .all())
    print(f"  found {len(batches)}, expected: {count}")
    for b in batches:
      print("  ", b, b.label, b.ci_commit.id)
      print("  ", b.ci_commit, b.ci_commit.project)
      print('--')
    assert len(batches) == count
  
    final_batch, *other_batches = list(batches)
    if not final_batch.data:
      final_batch.data = {}
    if not final_batch.data.get('commands'):
      final_batch.data['commands'] = {}
    print('BEFORE', final_batch.data['commands'])

    for b in other_batches:
      if b.data and b.data.get('commands'):
        final_batch.data['commands'].update(b.data['commands'])
      for o in b.outputs:
          o.batch = final_batch
      db_session.delete(b)
    print('AFTER', final_batch.data['commands'])

    if not dryrun:
      db_session.add(final_batch)
      db_session.commit()

if __name__ == '__main__':
    merge_duplicates()

# merge_duplicates()

