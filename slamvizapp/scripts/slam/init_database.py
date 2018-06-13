#!/usr/bin/env python
"""
Initializes or updates the database using information from the filesystem.
"""
import datetime
from pathlib import Path

from git.exc import BadName
from sqlalchemy.orm.exc import NoResultFound

from slamvizapp import repos
from slamvizapp.database import Session
from slamvizapp.models import Base, Project, CiCommit, TestInput, Batch, Output
from slamvizapp.config import default_recordings_directory, ci_directory

import slamvizapp
from slamvizapp.config import default_recordings_directory
from load_manual_android_runs import init_slam_manual_runs
# TODO: we should also import the old Android runs on algo_archive/PTAM_Results


def init_slam_database(verbose=False):
  """
  Initializes the database with ci commits.
  We don't delete the old recordings.... and we don't replace either.
  """
  session = Session()
  project = Project.get_or_create(session=session, id='dvs/psp_swip')
  repo = repos[project.id]
  cicommits_dir = ci_directory/project.id/'commits'

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
        # todo: from the the timestamp, update:
        # ci_commit.time_of_last_batch = ..
        # ci_commit.ci_batch.created_date = ..
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
      discover_outputs(ci_batch, session)
      session.add(ci_batch)
      session.commit()
    if verbose: print(ci_commit)

    # also get the manual runs...
  init_slam_manual_runs()

def discover_outputs(batch, session):
  """Find outputs saved on the disk to initialize the database"""
  # FIXME: we should also look for unsuccessful runs
  #   we could look into lsf.log and parse it for recording names
  #   then check whether we have them of not...
  # we look for successful runs
  output_dirs = [p.parent for p in batch.output_dir.rglob('metrics.json')]
  for output_dir in output_dirs:
    if batch.label != 'default': raise NotImplementedError
    platform, configuration, *rel_input_path = output_dir.relative_to(batch.output_dir).parts
    # FIXME:                 , parameter_id
    rel_input_path = Path(*rel_input_path)
    rel_input_path = f'{rel_input_path}.bin'
    test_input = TestInput.get_or_create(session, database=default_recordings_directory, path=rel_input_path)
    if not test_input:
      continue

    # FIXME: we should use the actual parameters used
    # not just the default, but also configuration.json
    output = Output.get_or_create(session,
                                           batch=batch,
                                           test_input=test_input,
                                           platform=platform,
                                           configuration=configuration,
                                           extra_parameters={},
                                          )
    output.update_metrics(output_dir/'metrics.json')
    output.output_type = 'slam/6dof'
    session.add(output)
    session.commit()


# def init_recordings():
#   """
#   Initializes the database with recordings.
#   We don't delete the old recordings.... but we replace.
#   """
#   session = Session()
#   for absolute_path in default_recordings_directory.rglob('*bin'):
#     path = str(absolute_path.relative_to(default_recordings_directory))

#     # it's a complete re-import, so I guess we should just drop the table...
#     session.query(TestInput).filter_by(path=path, database=default_recordings_directory).delete()

#     test_input = TestInput(path=path)
#     session.add(test_input)
#     print(test_input)
#   session.commit()
