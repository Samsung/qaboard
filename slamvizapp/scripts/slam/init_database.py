#!/usr/bin/env python
"""
Initializes or updates the database using information from the filesystem.
"""
import re
import datetime
import json
from pathlib import Path

from git.exc import BadName
from sqlalchemy.orm.exc import NoResultFound

from slamvizapp import repos
from slamvizapp.database import Session
from slamvizapp.models import Base, Project, CiCommit, TestInput, Batch, Output
from slamvizapp.config import default_recordings_directory, ci_directory

import slamvizapp
from slamvizapp.config import default_recordings_directory


def init_slam_database(verbose=False):
  """
  Initializes the database with ci commits.
  We don't delete the old recordings.... and we don't replace either.
  """
  # we update the database tags
  init_recordings()
  # import QA's manual runs...
  init_slam_manual_runs(verbose=True)
  return

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




manual_runs_root = Path('/net/f2/algo_archive/PTAM_Results/')

def init_slam_manual_runs(verbose=False):
  # we only import folder that match this regexp
  re_datetime = '(?P<time>[0-9]{4}-[0-9]{2}-[0-9]{2}_[0-9]{2}-[0-9]{2}-[0-9]{2})'
  re_author = '(?P<author>[A-Za-z0-9]*)'
  re_commit_id = '(?P<commit_id>[A-Za-z0-9]*)'
  re_message = '(?P<message>.*)'
  re_label = '((?P<label>[a-zA-Z0-9-]))?'
  id_parser = re.compile(f'^{re_datetime}__local__{re_author}__EXPORT{re_label}_{re_commit_id}(:?_{re_message})*')

  for folder in manual_runs_root.iterdir():
    if not folder.is_dir(): continue
    matches = id_parser.match(str(folder.name))
    # print(folder.name)
    # print(matches)
    if not matches: continue
    matches = matches.groupdict()
    commid_id = matches['commit_id']
    label = matches['label'] if matches['label'] else 'manual-android-rt'
    if commid_id=='PC': continue
    if commid_id=='Android': continue

    if verbose: print(f'{folder.name}   {label}')
    import_slam_manual_run(folder, commid_id, label, verbose=True)



def import_slam_manual_run(folder, commit_short_id, label, verbose=False):
  session = Session()
  project = Project.get_or_create(session=session, id='dvs/psp_swip')
  repo = repos[project.id]
  folder_path = manual_runs_root / folder / 'StandardConfiguration'
  if not (folder_path/'output').exists():
    folder_path = manual_runs_root / folder
    if not (folder_path/'output').exists():
      print(manual_runs_root/folder)
      raise ValueError

  commit = repo.commit(commit_short_id)
  try:
    ci_commit = session.query(CiCommit).filter_by(id=commit.hexsha).one()
  except:
    print(f'ERROR: could not find a CiCommit for {commit.hexsha}')
    return
  # if verbose: print(f'  {ci_commit}')
  batch_android = ci_commit.get_or_create_batch(label)

  output_dirs = [p.parent for p in folder_path.rglob('metrics.json')]
  # print(folder_path)
  # print(list(folder_path.rglob('metrics.json')))
  for output_dir in output_dirs:
    platform, configuration, *rel_input_path = output_dir.relative_to(folder_path/'output').parts
    rel_input_path = Path(*rel_input_path)
    rel_input_path = f'{rel_input_path}.bin'
    test_input = TestInput.get_or_create(session, database=default_recordings_directory, path=rel_input_path)
    if not test_input:
      continue

    output = Output.get_or_create(session,
                                           batch=batch_android,
                                           test_input=test_input,
                                           platform=platform.lower(),
                                           configuration=configuration,
                                           extra_parameters={},
                                          )
    output.update_metrics(output_dir/'metrics.json')
    output.output_type = 'slam/6dof'
    output.output_dir_override = str(output_dir)
    # print(output)
    session.add(output)
    session.commit()

  if verbose: print(f'  {batch_android}')


def init_recordings():
  """
  Initializes the database with recordings.
  We don't delete the old recordings.... but we replace.
  """
  session = Session()
  for absolute_path in default_recordings_directory.rglob('*bin'):
    recording_path = absolute_path.relative_to(default_recordings_directory)
    test_input = TestInput.get_or_create(session, default_recordings_directory, recording_path)

    metadata_path = absolute_path.with_suffix('.json')
    if metadata_path.exists():
      with metadata_path.open('r') as f:
        metadata = json.load(f)
      if 'tags' in metadata:
        previous_data = test_input.data if test_input.data else {}
        test_input.data = {
          **previous_data,
          'tags': metadata['tags'],
        }
    session.add(test_input)
  session.commit()

