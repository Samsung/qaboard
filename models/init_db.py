from git import Repo
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from recording import Recording
from config import *

engine = create_engine('sqlite:///:memory:', echo=True)
Session = sessionmaker(bind=engine)


def init_db():
  # init_recordings()
  init_cicommits()


def init_recordings():
  Recording.metadata.create_all(engine)
  session = Session()

  for absolute_path in default_recordings_directory.rglob('*bin'):
    path= str(absolute_path.relative_to(default_recordings_directory))
    recording = Recording(path=path)
    session.add(recording)
    print(recording)
  session.commit()



def init_cicommits():
  repo = Repo(str(app_data_directory/'psp_swip'))
  cicommits_dir = ci_directory/'commits'

  # ? go over all the commits on all branches?
  # .. more complete, but maybe wasteful?

  # > go over all folders and look for results? maybe more
  for cicommit_dir in cicommits_dir.glob('*__git__*'):
    commit_short_id = str(cicommit_dir)[-8:]
    try:
      ci_commit = repo.commit(commit_short_id)
    except:
      print(f'[error] with {cicommit_dir}')
if __name__ == '__main__':
  init_db()


# when we init the app, we should backfill the missing data
# - query the latest commit in the DB and look for new commits/outputs in cicommits_dir
# - sort commits by ci_date, and update those in the last hour

# when we are notified of a result
# - create a CiCommit/parameterSet if needed 
# - add the results

# when git send us a webhook, we should
# - only update the git repo



# to display data
# - we only query the DB
# - when needed, we fill the details with the git repo!
