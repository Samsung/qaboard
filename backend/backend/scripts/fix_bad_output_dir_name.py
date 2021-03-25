#!/usr/bin/env python
"""
Fix stuff.
docker-compose -f docker-compose.yml -f development.yml -f sirc.yml run --rm --no-deps -v /home/arthurf/qaboard/services/backend/passwd:/etc/passwd -e QABOARD_DATA_GIT_DIR=/home/arthurf backend python /qaboard/backend/backend/scripts/fix_bad_output_dir_name.py
"""
import os
import sys
import time
import shutil
import traceback
from pathlib import Path

import click
import requests
from sqlalchemy.orm.attributes import flag_modified
from sqlalchemy import text

from backend.models import Project, CiCommit, Batch, Output
from backend.database import db_session, Session

from migration_utils import get_username


# Progress will be printed every batch/100
batch_size = 10_000
start = time.time()


# TODO
# ? go over all deleted outputs
#     make sure deleted, delete parents


def migrate_output(output):
  if output.output_dir.exists():
    return

  tentative_output_dir = output.output_dir.parent / Path(output.test_input.path).with_suffix('').name
  if not tentative_output_dir.exists():
    click.secho(f"  ? {output.output_dir_override}")
    click.secho(f"       {output}")
    click.secho(f"       {output.test_input}")
    return

  output.output_dir_override = str(tentative_output_dir)
  output.data["user"] = tentative_output_dir.owner()
  click.secho(f"  ✔ {output.data['user']} {output.output_dir_override}", fg='green')
  # exit(0)


  flag_modified(output, "data")
  db_session.add(output)
  db_session.commit()
  # click.secho("  🆗", fg='green')
  # exit(0)


def migrate(min_id):
  # it's an aweful join...
  all_outputs = (db_session
    .query(Output)
  )
  if min_id:
    all_outputs = all_outputs.filter(Output.id >= min_id)
  outputs = (all_outputs
    # .filter(text("(outputs.data->'migrated') is null"))
    .filter(text("outputs.output_dir_override is not null"))
    .filter(text("outputs.output_dir_override like '/algo%'"))
    # .filter(text("outputs.created_date < now() - '15 days'::interval"))
    # .filter(text("output_dir_override like '/stage/algo_data/ci/CDE-Users/HW_ALG/%/CIS/output%'"))
    # .filter(Output.is_pending==False)
    # .filter(Output.deleted==False)
    .order_by(Output.created_date.asc())
    .enable_eagerloads(False)
  )
  click.secho(f'- outputs total: {all_outputs.count()}', bold=True, fg='blue')
  output_total = outputs.count()
  click.secho(f'- outputs to migrate: {output_total}', bold=True, fg='blue')
  should_continue = output_total > batch_size
  start_batch  = time.time()
  updated = 0
  now = time.time()

  if not output_total:
    for result in all_outputs.limit(1):
      o = result
      # o, batch, commit = result
      print(o)
      print(o.output_dir)
    return updated, None, should_continue

  for idx, result in enumerate(outputs.limit(batch_size)):
      o = result
      # print(o, batch, commit)
      if o.data is None:
        o.data = {}
      ## legacy outputs from the previous CI
      # if '/' in o.batch.ci_commit.hexsha:
      #   continue

      migrate_output(o)
      if idx and idx % batch_size/100 == 0:
          print(o)
          print(o.batch.ci_commit)
          now = time.time()
          print(f"{idx/output_total:.1%} [{batch_size/(now - start_batch):.1f}/s] [est. total left {(now - start_batch) * ((output_total-idx)/batch_size) / 3600:.2f}h] [elapsed time: {now - start:.1f}s]")
          start_batch = now
  return updated, o.id, should_continue


def main():
  # Optionnally, you can give an id to start from...
  # it helps if there are many non-migrated runs that fail because of whatever and
  # you don't want to wait until the migration fails to migrate them again!
  last_id = None #1245250 # None

  should_continue = True
  while should_continue:
    click.secho('Migrating...', bold=True, fg='blue')
    nb_updated, last_id, should_continue = migrate(last_id)
    click.secho(f"nb_updated={nb_updated}, last_id={last_id}, should_continue={should_continue}", fg='blue')
  click.secho('DONE', fg='green')

main()
