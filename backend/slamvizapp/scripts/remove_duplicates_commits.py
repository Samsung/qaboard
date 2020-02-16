#!/usr/bin/env python
"""
This scrip fixed a race condition that caused duplicated batches
 /opt/anaconda3/bin/python /home/arthurf/qaboard/backend/slamvizapp/remove_duplicates.py --dryrun
"""
import click
from click import secho
from sqlalchemy import String, JSON
from sqlalchemy import func, and_, asc, or_
from sqlalchemy.sql import text
from sqlalchemy import cast, type_coerce
from sqlalchemy.orm.exc import NoResultFound, MultipleResultsFound


from slamvizapp.database import db_session, Session
from slamvizapp.models import Project, CiCommit, Batch, Output

from qatools.config import merge

# Testing
# ssh 
# sudo cp /home/arthurf/dvs/slamvizapp/slamvizapp/clean.py /slamvizapp/slamvizapp/
# slamvizapp_clean --dryrun


# Find duplicates:
#  ssh arthurf-vdi ; screen -r
# SELECT ci_commit_id, label, count(*) as qty FROM batches GROUP BY ci_commit_id, label HAVING count(*)> 1;
# TOCO:
# 1.  find duplicates
# 2.  Merge

# CREATE UNIQUE INDEX CONCURRENTLY _ci_commit_id__label ON batches (ci_commit_id, label);


def merge_batches(batches, db_session, dryrun):
  problems = []
  final_batch, *other_batches = list(batches)
  if not final_batch.data:
    final_batch.data = {}
  if not final_batch.data.get('commands'):
    final_batch.data['commands'] = {}
  for b in other_batches:
    if b.data and b.data.get('commands'):
      final_batch.data['commands'].update(b.data['commands'])
    for o in b.outputs:
      # Need to NOT merge if there is the same in the previous batch and older!  
      try:
        matching_output = db_session.query(Output).filter(
            and_(
                Output.batch_id == final_batch.id,
                Output.test_input_id == o.test_input.id,
                Output.platform == o.platform,
                Output.configuration == o.configuration,
                cast(Output.extra_parameters, String) == type_coerce(o.extra_parameters, JSON),
            )
        ).one()
        # print('FOUND MATCHING')
        print("  MATCHING ", matching_output.created_date, "PENDING" if matching_output.is_pending else "", matching_output.metrics)
        print("  OUTPUT   ", o.created_date, "PENDING" if o.is_pending else "", o.metrics)

        picked = 'OUTPUT' if o.created_date > matching_output.created_date else 'MATCHING'
        if not o.is_pending and matching_output.is_pending:
          picked = 'OUTPUT'
        if o.is_pending and not matching_output.is_pending:
          picked = 'MATCHING'

        if picked == 'OUTPUT':
          db_session.delete(matching_output)
          o.batch = final_batch
          print('   > PICK OUTPUT')
        else:
          db_session.delete(o)
          print('   > PICK MATCHING')
      except NoResultFound:
        o.batch = final_batch
        # print('   > ADD')
      except MultipleResultsFound:
        matching_outputs = db_session.query(Output).filter(
            and_(
                Output.batch_id == final_batch.id,
                Output.test_input_id == o.test_input.id,
                Output.platform == o.platform,
                Output.configuration == o.configuration,
                cast(Output.extra_parameters, String) == type_coerce(o.extra_parameters, JSON),
            )
        ).all()
        print('   WTF')
        # print()
        # exit(0)
        problems.append([mo.id for mo in matching_outputs])
        # for mo in matching_outputs:
        #   if mo.is_running:
        #     db_session.delete(mo)
    db_session.delete(b)
  if not dryrun:
    db_session.add(final_batch)
  if problems:
    print('oops', problems)




@click.command()
@click.option('--dryrun', is_flag=True)
def merge_duplicates(dryrun):
  # dryrun = True

  sql = "SELECT project_id, hexsha, count(*) as qty FROM ci_commits GROUP BY project_id, hexsha HAVING count(*)> 1;"
  result = db_session.execute(sql)
  duplicates = list(result)
  for project_id, hexsha, count in duplicates:
    print(project_id, hexsha, count)
  print(len(duplicates), "duplicates")


  for project_id, hexsha, count in duplicates:
    # print('----------')
    # print(f"project: {project_id}, hexsha={hexsha[:8]}, duplicates={count}")
    ci_commits = (db_session.query(CiCommit)\
                        .filter(CiCommit.project_id == project_id)\
                        .filter(CiCommit.hexsha == hexsha)\
                        .all())
    assert len(ci_commits) == count
    # print(f"  found {len(ci_commits)}, expected: {count}")
    ci_commits.sort(key=lambda c: -len(c.batches))
    # for c in ci_commits:
    #   # there are only 2 keys in data...
    #   # data = {**c.data, "qatools_metrics": None, "qatools_config": None}
    #   # if len(data) > 2:
    #   #   print(data)
    #   #   exit(0)
    #   print('duplicate:')
    #   for b  in c.batches:
    #     print("  ", b.label, len(b.outputs))
    # continue

    final_commit, *other_commits = list(ci_commits)
    for c in other_commits:
      final_commit.data = merge(c.data, final_commit.data)
      # print(final_commit.data)

      if len(c.batches):
        for batch in c.batches:
          if batch.label in [b.label for b in final_commit.batches]:
            final_batch = final_commit.get_or_create_batch(batch.label)
            print(f'MERGE batches! {final_commit.hexsha[:8]} {batch.label}   {project_id}')
            merge_batches([final_batch, batch], db_session, dryrun)
          else:
            print(f'CHANGE batch! {final_commit.hexsha[:8]} {batch.label}   {project_id}')
            batch.commit = final_commit

      if not dryrun:
        db_session.delete(c)
    if not dryrun:
        db_session.add(final_commit)
        db_session.commit()



# add unique constraint
# CREATE UNIQUE INDEX CONCURRENTLY _ci_commit_project_id__hexsha ON batches (project_id, hexsha);


if __name__ == '__main__':
    merge_duplicates()


def clean():
  merge_duplicates()
  global problems
  print(problems)
# merge_duplicates()

# --select * from outputs where (id=844700 or id=844725) and is_pending=true;
# --delete from outputs where id=842984

# -- delete from outputs where (id=844700 or id=844725) and is_pending=true;
# -- delete from outputs where id in (843967, 843957) and is_pending=true;

