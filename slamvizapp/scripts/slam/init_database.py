#!/usr/bin/env python
"""
Initializes or updates the database using information from the filesystem.
"""
import re
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


def init_slam_database(verbose=False):
  """
  Initializes the database with ci commits.
  We don't delete the old recordings.... and we don't replace either.
  """
  # import QA's manual runs...
  init_slam_manual_runs(verbose=True)

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
  id_parser = re.compile(f'^{re_datetime}__local__{re_author}__EXPORT_{re_commit_id}(?:_{re_message})*')

  for folder in manual_runs_root.iterdir():
    if not folder.is_dir(): continue
    matches = id_parser.match(str(folder.name))
    if not matches: continue
    matches = matches.groupdict()
    commid_id = matches['commit_id']
    if commid_id=='PC': continue
    if commid_id=='Android': continue

    import_slam_manual_run(folder, commid_id, verbose=True)
    if verbose: print(folder.name)




def import_slam_manual_run(folder, commit_short_id, verbose=False):
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
  ci_commit = session.query(CiCommit).filter_by(id=commit.hexsha).one()
  # if verbose: print(f'  {ci_commit}')
  batch_android = ci_commit.get_or_create_batch('ci-android-rt')

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


# init_slam_manual_runs(verbose=True)

# manual_runs = [
#   ('2018-03-04_13-40-55__local__avis__W9_Android_RT', 'feb2963'),
#   ('2018-03-04_13-40-55__local__avis__W9_Android_RT', 'feb296353ddab8067c9b62a82c00c75299a6d173'),
#   ('2018-03-15_17-23-43__local__avis__6a37ae63_Android_RT', '6a37ae63344ec481e349ef49e15ac483a4363711'),
#   ('2018-04-08_10-26-08__local__irobot__8c049f68_DEMO_Android_RT', '8c049f684411c1f81d23aa8ee7730ed1e3464632'),
#   ('2018-05-14_17-36-57__local__avis__19dade3c_Android_RT', '19dade3c6c367d7f8cb31db216654b443f5fe03e'),
#   ('2018-01-10_10-55-36__local__avis_41e75c0f_Android_RT', '41e75c0f0c2e4d930e75c64cdcc69c45dca6d569'),
#   ('2018-05-28_12-30-16__local__avis__DEMO_Android_RT', '1359ec9f3eea20dfa8bbd0943116c8d0aa03d4ba'),
#   ('2018-05-28_18-47-34__local__avis__DEMO_Android_RT', 'f4d3f4af7f5e0e261cf0676fb48ab149d7e63d71'),
#   ('2018-05-30_09-30-29__local__avis__DEMO_Android_RT', 'db834edb4a9892e659d127402c899c0f3c398f19'),
#   ('2018-06-04_09-35-19__local__avis__DEMO_Android_RT', '9b5eff2de07d211506d0952258f05fb1f79622ff'),
# ]
# def init_slam_manual_runs(verbose=False):
#   for folder, commit_short_id in manual_runs:
#     if verbose: print(f'importing {commit_short_id} in {folder}')
#     import_slam_manual_run(folder, commit_short_id)



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

