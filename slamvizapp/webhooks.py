import json
from flask import request
from sqlalchemy.orm.exc import NoResultFound

from slamvizapp import app, repo, db_session
from .models import CiCommit, SlamOutput, Recording
from .git_utils import git_pull


@app.route('/api/v1/slam_output', methods=['POST'])
def new_slam_output_webhook():
  data = request.get_json()
  if data['job_type'] != 'ci': # we do nothing for now with local runs
    print(data['output_directory'])
    return "OK"

  hexsha = request.json['git_commit_sha']
  try:
    ci_commit = CiCommit.get_or_create(session=db_session, hexsha=hexsha)
  except:
    return f"404 ERROR:\n there is an issue with your commit id ({hexsha})", 404

  recording = Recording.get_or_create(db_session, path=data['recording_path'])
  if not recording: return "KO", 404

  batch = ci_commit.get_or_create_batch(data['batch_label'])
  slam_output = SlamOutput.get_or_create(db_session,
                                         batch=batch,
                                         platform=data['platform'],
                                         configuration=data['configuration'],
                                         extra_parameters=data['extra_parameters'],
                                         recording=recording,
                                        )
  if request.json.get('is_pending', False):
    slam_output.is_pending = True
  else:
    slam_output.update_metrics()

  db_session.add(slam_output)
  db_session.commit()
  return "OK"


@app.route('/webhook/gitlab', methods=['GET', 'POST'])
def gitlab_webhook():
  """Gitlab calls this endpoint every push, it garantees we stay synced."""
  data = json.loads(request.data)
  print(data)

  git_pull()

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
          project='dvs/psp_swip',
          branch='origin/'+data['ref'][11:], #  'refs/heads/feature/Imu_preintegration'
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
