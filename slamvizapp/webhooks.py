import json
from flask import request
from sqlalchemy.orm.exc import NoResultFound

from slamvizapp import app, repo, db_session
from .models import CiCommit
from .git_utils import git_pull
from .config import *


@app.route('/webhook/slam_output', methods=['POST'])
def new_slam_output_webhook():
  print(request.form)
  if request.form['job_type'] != 'ci':
    print(request.form['base_output_directory'])
    return "OK" # we do nothing for now with local runs

  try:
    hexsha = request.form['git_commit_sha']
    commit = repo.commit(hexsha)
  except:
    return f"404 ERROR:\n there is an issue with your commit id ({hexsha})", 404

  try:
    ci_commit = db_session.query(CiCommit).filter_by(id=commit.hexsha).one()
  except NoResultFound:
    try:
      ci_commit = CiCommit(commit, project='dvs/psp_swip', session=db_session)
      db_session.add(ci_commit)
      db_session.commit()
    except ValueError:
      print(f'WARNING: could not create a commit for {commit.hexsha}')
      return '404', 404
    if ci_commit is None: # something is wrong, maybe an error opening param.json
      return '404', 404

  ci_commit.discover_slam_outputs(db_session)
  db_session.add(ci_commit)
  db_session.commit()
  return "OK"


@app.route('/webhook/gitlab', methods=['GET', 'POST'])
def gitlab_webhook():
  """Gitlab calls this endpoint every push, it garantees we stay synced."""
  data = json.loads(request.data)
  print(data)

  git_pull()
  return '{status: "OK"}'

  # we can't create a commit now as we're missing default params.json
  # we should look into the commit data etc...
  try: # no work to do if our commit is already in the database
    ci_commit = db_session.query(CiCommit).filter_by(id=data['checkout_sha']).one()
  except NoResultFound:
    try:
      commit = repo.commit(data['checkout_sha'])
    except:
      print('WARNING: could not find the git commit')

    try: # the commit might have failed (eg no params.json available)
      ci_commit = CiCommit(
        commit,
        branch='origin/'+data['ref'][7:],
        project='dvs/psp_swip',
        session=db_session
      )
      print(ci_commit)
    except ValueError:
      print(f'WARNING: could not create a commit for {commit.hexsha}')
      return "{status:'OK'}"
    if ci_commit is None: # something is wrong, maybe an error opening param.json
      return "{status:'OK'}"
  db_session.add(ci_commit)
  db_session.commit()
  return "{status:'OK'}"


