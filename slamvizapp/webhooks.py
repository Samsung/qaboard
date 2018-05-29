import json
from flask import request
from sqlalchemy.orm.exc import NoResultFound

from slamvizapp import app, repos, db_session
from .models import Project, CiCommit, Output, TestInput
from .git_utils import git_pull
from .config import default_recordings_directory

@app.route('/api/v1/output', methods=['POST'])
@app.route('/api/v1/slam_output', methods=['POST'])
def new_output_webhook():
  data = request.get_json()
  if data['job_type'] != 'ci': # we do nothing for now with local runs
    print(data['output_directory'])
    return "OK"

  hexsha = request.json['git_commit_sha']
  try:
    repo = repos['dvs/psp_swip']
    ci_commit = CiCommit.get_or_create(session=db_session, hexsha=hexsha, repo=repo)
  except:
    return f"404 ERROR:\n there is an issue with your commit id ({hexsha})", 404

  test_input = TestInput.get_or_create(db_session, path=data['recording_path'], database=default_recordings_directory)
  if not test_input: return "KO", 404

  batch = ci_commit.get_or_create_batch(data['batch_label'])
  output = Output.get_or_create(db_session,
                                         batch=batch,
                                         platform=data['platform'],
                                         configuration=data['configuration'],
                                         extra_parameters=data['extra_parameters'],
                                         test_input=test_input,
                                        )
  if request.json.get('is_running', False):
    output.is_running = True
    output.is_pending = True
  elif request.json.get('is_pending', False):
    output.is_pending = True
  else:
    output.update_metrics()

  db_session.add(output)
  db_session.commit()
  return "OK"


@app.route('/webhook/gitlab', methods=['GET', 'POST'])
def gitlab_webhook():
  """Gitlab calls this endpoint every push, it garantees we stay synced."""
  # https://docs.gitlab.com/ce/user/project/integrations/webhooks.html
  data = json.loads(request.data)
  print(data)
  # dvs/psp_swip
  project_path = data['project']['path_with_namespace']
  project = Project.get_or_create(id=project_path)
  repo = repos[project_path]
  git_pull(repo)

  # we can't create a commit now as we're missing default params.json
  # we should look into the commit data etc...
  try: # no work to do if our commit is already in the database
    ci_commit = (db_session
                 .query(CiCommit)
                 .filter_by(id=data['checkout_sha'], project_id='dvs/psp_swip')
                 .one()
    )
  except NoResultFound:
    try:
      commit = repo.commit(data['checkout_sha'])
    except:
      print('WARNING: could not find the git commit')

    try: # the commit might have failed (eg no params.json available)
      ci_commit = CiCommit(
          commit,
          project=project,
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
