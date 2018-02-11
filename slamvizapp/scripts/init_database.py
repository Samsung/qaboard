#!/usr/bin/env python
"""
Initializes or updates the database using information from the filesystem.
"""
import datetime
import click
import time
from git.exc import BadName
from sqlalchemy.orm.exc import NoResultFound

from slamvizapp import repo
from slamvizapp.database import engine, Session
from slamvizapp.models import *
from slamvizapp.config import *



def print_summary():
  session = Session()
  print(f'total Recordings: {session.query(Recording).count()}')
  print(f'total CiCommits: {session.query(CiCommit).count()}')
  print(f'total SlamOutputs: {session.query(SlamOutput).count()}')


@click.command()
@click.option('--drop-all', is_flag=True)
@click.option('--loop', is_flag=True)
def init_database(drop_all, loop):
  if drop_all:
    Base.metadata.drop_all(engine)
  Base.metadata.create_all(engine)
  # this is optionnal as Recordings will be created as needed when importing CiCommits
  # init_recordings()
  init_cicommits()
  print_summary()

  while loop:
    print('sleeping...')
    # time.sleep(10)
    time.sleep(60*12)
    init_cicommits()
    print_summary()

def init_recordings():
  """
  Initializes the database with recordings.
  We don't delete the old recordings.... but we replace.
  """
  session = Session()
  for absolute_path in default_recordings_directory.rglob('*bin'):
    path= str(absolute_path.relative_to(default_recordings_directory))

    # it's a complete re-import, so I guess we should just drop the table...
    session.query(Recording).filter_by(path=path).delete()

    recording = Recording(path=path)
    session.add(recording)
    print(recording)
  session.commit()


def init_cicommits():
  """
  Initializes the database with ci commits.
  We don't delete the old recordings.... and we don't replace either.
  """
  session = Session()
  cicommits_dir = ci_directory/'commits'

  # ? should we go over all the commits on all branches?
  # ? it would be more complete, but maybe wasteful? we only care about results.

  # go over all folders and look for results
  cicommit_directories = list(cicommits_dir.glob('*__git__*'))
  cicommit_directories.reverse() # update the most recent first
  for cicommit_dir in cicommit_directories:
    commit_short_id = str(cicommit_dir)[-8:]
    try: # we get the corresponding git commit
      commit = repo.commit(commit_short_id)
    except BadName:
      # print(f'[InitDatabase] WARNING: git failed for {cicommit_dir}')
      continue

    try:
      ci_commit = session.query(CiCommit).filter_by(id=commit.hexsha).one()
    except NoResultFound:
      try: # the commit might have failed (eg no params.json available)
        ci_commit = CiCommit(commit, project='dvs/psp_swip', session=session)
      except ValueError:
          print(f'[InitDatabase] WARNING: could not create a commit for {commit.hexsha}.')
          continue
      if ci_commit is None: # something is wrong, maybe an error opening param.json
        print('[InitDatabase] WARNING: ci_commit is None')
        continue

    session.add(ci_commit)
    session.commit()

    # could_be_pending_results = datetime.datetime.now().astimezone() - ci_commit.time_of_last_slam_job < datetime.timedelta(hours=3)
    # if could_be_pending_results or not ci_commit.slam_outputs:
    if not ci_commit.slam_outputs or ci_commit.failed_slam_outputs or ci_commit.pending_slam_outputs:
      ci_commit.discover_slam_outputs(session)
      if ci_commit.pending_slam_outputs: print(ci_commit)
      session.add(ci_commit)
      session.commit()

# when we init the app, we should backfill the missing data
# - query the latest commit in the DB and look for new commits/outputs in cicommits_dir
# - sort commits by ci_date, and update those in the last hour

# when we are notified of a result
# - create a CiCommit/parameterSet if needed
# - add the results (don't forget to check if it failed)

# when git send us a webhook, we should
# - only update the git repo
# - create a CiCommit object if needed (with the correct branch if there is one!)



# to display data
# - we only query the DB
# - when needed, we fill the details with the git repo!


# find tuning data?