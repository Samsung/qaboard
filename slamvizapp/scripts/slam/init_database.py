#!/usr/bin/env python
"""
Initializes or updates the database using information from the filesystem.
"""
import time
import datetime
from pathlib import Path

from git.exc import BadName
from sqlalchemy.orm.exc import NoResultFound

from slamvizapp import repos
from slamvizapp.database import Session
from slamvizapp.models import Base, CiCommit, Recording, Batch, Output
from slamvizapp.config import default_recordings_directory, ci_directory

import slamvizapp


# TODO: we should also import the old Android runs on algo_archive/PTAM_Results


def init_slam_database(verbose=False):
  """
  Initializes the database with ci commits.
  We don't delete the old recordings.... and we don't replace either.
  """
  project = 'dvs/psp_swip'
  repo = repos[project]
  session = Session()
  cicommits_dir = ci_directory/project/'commits'

  # ? should we go over all the commits on all branches?
  # ? it would be more complete, but maybe wasteful? we only care about results.

  # go over all folders and look for results
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
        print('[InitDatabase] creating a commit')
        ci_commit = CiCommit(commit, project=project)
      except ValueError:
        print(f'[InitDatabase] WARNING: could not create a commit for {commit.hexsha}.')
        continue
      if ci_commit is None: # something is wrong
        print('[InitDatabase] WARNING: ci_commit is None')
        continue

    session.add(ci_commit)
    session.commit()

    ci_batch = ci_commit.ci_batch
    could_be_pending_results = datetime.datetime.now().astimezone() - ci_commit.time_of_last_batch < datetime.timedelta(hours=3)
    has_pending = len([o for o in ci_batch.outputs if o.is_pending])
    has_failed = len([o for o in ci_batch.outputs if o.is_failed])
    # if not ci_batch.outputs or has_pending or has_failed or could_be_pending_results:
    if not ci_batch.outputs or could_be_pending_results:
      ci_batch.discover_outputs(session)
      session.add(ci_batch)
      session.commit()
    if verbose: print(ci_commit)



# def init_recordings():
#   """
#   Initializes the database with recordings.
#   We don't delete the old recordings.... but we replace.
#   """
#   session = Session()
#   for absolute_path in default_recordings_directory.rglob('*bin'):
#     path = str(absolute_path.relative_to(default_recordings_directory))

#     # it's a complete re-import, so I guess we should just drop the table...
#     session.query(Recording).filter_by(path=path).delete()

#     recording = Recording(path=path)
#     session.add(recording)
#     print(recording)
#   session.commit()
