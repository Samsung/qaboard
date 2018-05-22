#!/usr/bin/env python
"""
Initializes or updates the database using information from the filesystem.
"""
import time
import datetime
from pathlib import Path

import click
from git.exc import BadName
from sqlalchemy.orm.exc import NoResultFound
from alembic.config import Config
from alembic import command

from slamvizapp import repos
from slamvizapp.database import engine, Session
from slamvizapp.models import Base, CiCommit, Recording, Batch, SlamOutput
from slamvizapp.config import default_recordings_directory, ci_directory

import os
import slamvizapp

def print_summary():
  session = Session()
  print(f'total Recordings: {session.query(Recording).count()}')
  print(f'total CiCommits: {session.query(CiCommit).count()}')
  print(f'total Batches: {session.query(Batch).count()}')
  print(f'total SlamOutputs: {session.query(SlamOutput).count()}')


def stamp_schema_version():
  with engine.begin() as connection:
    alembic_cfg = Config()
    alembic_cfg.set_main_option("script_location", "slamvizapp:alembic")
    path = Path(slamvizapp.__file__).parent / 'alembic.ini'
    alembic_cfg.config_file_name = str(path)
    alembic_cfg.attributes['connection'] = connection
    command.stamp(alembic_cfg, "head")

@click.command()
@click.option('--drop-all', is_flag=True)
@click.option('--loop', is_flag=True)
@click.option('--sleep', default=600)
@click.option('--verbose', is_flag=True)
def init_database(drop_all, loop, sleep, verbose):
  if drop_all:
    # for tbl in reversed(Base.metadata.sorted_tables):
    # engine.execute(tbl.delete())
    if verbose: print('dropping all data')
    Base.metadata.drop_all(engine)
  if verbose: print('creating schema...')
  Base.metadata.create_all(engine)

  stamp_schema_version()

  # Recordings will be created already when importing CiCommits
  # init_recordings()
  init_cicommits(verbose=verbose)
  print_summary()

  while loop:
    if verbose: print('sleeping...')
    time.sleep(sleep)
    init_cicommits(verbose=verbose)
    print_summary()

def init_recordings():
  """
  Initializes the database with recordings.
  We don't delete the old recordings.... but we replace.
  """
  session = Session()
  for absolute_path in default_recordings_directory.rglob('*bin'):
    path = str(absolute_path.relative_to(default_recordings_directory))

    # it's a complete re-import, so I guess we should just drop the table...
    session.query(Recording).filter_by(path=path).delete()

    recording = Recording(path=path)
    session.add(recording)
    print(recording)
  session.commit()


def init_cicommits(verbose=False):
  """
  Initializes the database with ci commits.
  We don't delete the old recordings.... and we don't replace either.
  """
  repo = repos['dvs/psp_swip']
  session = Session()
  cicommits_dir = ci_directory/'commits'

  # ? should we go over all the commits on all branches?
  # ? it would be more complete, but maybe wasteful? we only care about results.

  # go over all folders and look for results
  if verbose: print('import...')
  cicommit_directories = list(cicommits_dir.glob('*__git__*'))
  cicommit_directories.reverse() # update the most recent first
  for cicommit_dir in cicommit_directories:
    if verbose: print(cicommit_dir)
    commit_short_id = str(cicommit_dir)[-8:]
    try: # we get the corresponding git commit
      commit = repo.commit(commit_short_id)
    except BadName:
      if verbose: print(f'[InitDatabase] WARNING: git failed for {cicommit_dir}')
      continue

    try:
      ci_commit = session.query(CiCommit).filter_by(id=commit.hexsha).one()
    except NoResultFound:
      try: # the commit might have failed (eg no params.json available)
        ci_commit = CiCommit(commit, project='dvs/psp_swip')
      except ValueError:
        print(f'[InitDatabase] WARNING: could not create a commit for {commit.hexsha}.')
        continue
      if ci_commit is None: # something is wrong, maybe an error opening param.json
        print('[InitDatabase] WARNING: ci_commit is None')
        continue

    session.add(ci_commit)
    session.commit()

    ci_batch = ci_commit.ci_batch
    could_be_pending_results = datetime.datetime.now().astimezone() - ci_commit.time_of_last_batch < datetime.timedelta(hours=3)
    if not ci_batch.slam_outputs or ci_batch.failed_slam_outputs or ci_batch.pending_slam_outputs or could_be_pending_results:
      ci_batch.discover_slam_outputs(session)
      if verbose or ci_batch.pending_slam_outputs: print(ci_commit)
      session.add(ci_batch)
      session.commit()
    if verbose: print(ci_commit)
