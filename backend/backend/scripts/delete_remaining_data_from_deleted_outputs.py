"""
cd qaboard
docker-compose -f docker-compose.yml -f development.yml -f sirc.yml run --rm --user=root --no-deps -v /home/arthurf/qaboard/services/backend/passwd:/etc/passwd backend python /qaboard/backend/backend/scripts/delete_remaining_data_from_deleted_outputs.py
"""
import sys
import time
import shutil
import traceback

import click

from backend.models import Output
from backend.database import db_session, Session

from migration_utils import get_username
from backend.fs_utils import as_user
from migration_utils import rm_files_not_listed_in_manifests

dryrun = '--dry-run' in sys.argv
# Progress will be printed every batch/100
batch_size = 10_000
start = time.time()


def check_output(output):
  try:
    output_dir_exists = output.output_dir.exists()
  except:
    output_dir_exists = False
  if output_dir_exists:
    print(f"[{output.id}]", output.output_dir)
    try:
      output.delete(soft=False)
    except:
      delete = lambda o: o.delete(soft=False)
      owner = output.output_dir.owner()
      as_user(owner, delete, output)



def run_delete(min_id):
  deleted_outputs = (db_session
    .query(Output)
    .filter(Output.deleted==True)
  )
  if min_id:
    deleted_outputs = deleted_outputs.filter(Output.id >= min_id)
  deleted_outputs = (deleted_outputs
    .order_by(Output.created_date.asc())
    .enable_eagerloads(False)
  )
  output_total = deleted_outputs.count()
  click.secho(f'- outputs to check: {output_total}', bold=True, fg='blue')
  should_continue = output_total > batch_size

  start_batch  = time.time()
  updated = 0
  now = time.time()

  for idx, o in enumerate(deleted_outputs.limit(batch_size)):
      # o, batch, commit = result
      check_output(o)
      if idx and idx % batch_size/100 == 0:
          print(o)
          print(o.batch.ci_commit)
          now = time.time()
          print(f"{idx/output_total:.1%} [{batch_size/(now - start_batch):.1f}/s] [est. total left {(now - start_batch) * ((output_total-idx)/batch_size) / 3600:.2f}h] [elapsed time: {now - start:.1f}s]")
          start_batch = now
  return updated, o.id, should_continue


def main():
  # Optionnally, you can give an id to start from...
  last_id = 3457400 # None

  should_continue = True
  while should_continue:
    click.secho('Deleting...', bold=True, fg='blue')
    nb_updated, last_id, should_continue = run_delete(last_id)
    click.secho(f"nb_updated={nb_updated}, last_id={last_id}, should_continue={should_continue}", fg='blue')
  click.secho('DONE', fg='green')

main()
