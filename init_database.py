#!/usr/bin/env python
"""
Initialiazes or updates the database using information from the filesystem.
SLAMVIZAPP_DATA=/etc/slamvizapp python init_database.py
"""
from git import Repo
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from slamvizapp.models import *
from slamvizapp.config import *


engine = create_engine('sqlite:///:memory:', echo=True)
Session = sessionmaker(bind=engine)


def init_db():
  Base.metadata.create_all(engine)
  # init_recordings()
  init_cicommits()

def init_recordings():
  """
  Initializes the database with recordings.
  We don't delete the old recordings.... but we replace.
  """
  session = Session()
  for absolute_path in default_recordings_directory.rglob('*bin'):
    path= str(absolute_path.relative_to(default_recordings_directory))
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

  repo = Repo(str(app_data_directory/'psp_swip'))
  cicommits_dir = ci_directory/'commits'

  # ? should we go over all the commits on all branches?
  # ? it would be more complete, but maybe wasteful? we only care about results.

  # go over all folders and look for results
  for cicommit_dir in cicommits_dir.glob('*__git__*'):
    commit_short_id = str(cicommit_dir)[-8:]
    # try:
    commit = repo.commit(commit_short_id)
    print(commit)

    # we don't touch commits that already exist, for fear of messing stuff up
    if not session.query(CiCommit).filter(id==commit.hexsha):
      ci_commit = CiCommit(commit)
      session.add(ci_commit)
      print(ci_commit)
    else:
      print('already exists')
      # FIXME: should we try to find new outputs? I guess...
    break
    # except:
    #   print(f'[error] with {cicommit_dir}')

  session.commit()

if __name__ == '__main__':
  init_db()

  session = Session()
  print(f'total recordings: {session.query(Recording).count()}')
  print(f'total ci_commits: {session.query(CiCommit).count()}')
  print(f'total SLAM outputs: {session.query(SlamOutput).count()}')

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
