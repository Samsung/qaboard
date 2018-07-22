import sys
import json
import yaml

from flask import request
from sqlalchemy.orm.exc import NoResultFound

from slamvizapp import app, repos, db_session
from ..models import Project, CiCommit, Output, TestInput
from ..git_utils import git_pull
from ..config import default_recordings_directory

@app.route('/api/v1/output', methods=['POST'])
@app.route('/api/v1/output/', methods=['POST'])
def new_output_webhook():
  data = request.get_json()
  project_id = request.json.get('project', 'dvs/psp_swip')
  if data['job_type'] != 'ci': # we do nothing for now with local runs
    print(data['output_directory'])
    return "OK"

  hexsha = request.json['git_commit_sha']
  try:
    repo = repos[project_id]
    ci_commit = CiCommit.get_or_create(session=db_session, hexsha=hexsha, repo=repo)
  except:
    return f"404 ERROR:\n there is an issue with your commit id ({hexsha})", 404

  test_input_path = request.json.get('recording_path', request.json.get('input_path'))
  if not test_input_path:
    return jsonify({"error": "the input path was not provided"}, 400)
  database = request.json.get('database', default_recordings_directory)
  test_input = TestInput.get_or_create(db_session, path=test_input_path, database=database)
  if not test_input: return "KO", 404

  batch = ci_commit.get_or_create_batch(data['batch_label'])
  output = Output.get_or_create(db_session,
                                         batch=batch,
                                         platform=data['platform'],
                                         configuration=data['configuration'],
                                         extra_parameters=data['extra_parameters'],
                                         test_input=test_input,
                                        )
  output.output_type = request.json.get('output_type', 'slam/6dof')
  output.data = request.json.get('data', {})
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
  # data['ref'] => 'refs/heads/feature/Imu_preintegration'
  branch = data['ref'][11:]
  project_path = data['project']['path_with_namespace'] # eg => dvs/psp_swip
  project = Project.get_or_create(session=db_session, id=project_path)
  project.information = {
    **project.information,
    'git': data['project'],
  }
  repo = repos[project_path]
  git_pull(repo)

  try: # no work to do if our commit is already in the database
    ci_commit = (db_session
                 .query(CiCommit)
                 .filter_by(id=data['checkout_sha'], project_id=project_path)
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
          branch=branch,
      )
      print(ci_commit, file=sys.stderr)
    except ValueError:
      print(f'WARNING: could not create a commit for {commit.hexsha}')
      return "{status:'OK'}"
    if ci_commit is None: # something is wrong, maybe an error opening param.json
      return "{status:'OK'}"

  db_session.add(ci_commit)
  db_session.commit()


  # we update the project configuration stored in the database
  try:
    qatools_config_contents = repo.git.show('{}:{}'.format(ci_commit.id, 'qatools.yaml'))
  except:
    qatools_config_contents = None
    qatools_config = None
  if qatools_config_contents:
    qatools_config = yaml.load(qatools_config_contents)

  if qatools_config:
    is_initialization = 'qatools_config' not in project.information
    try:
      is_reference = not is_initialization and branch == project.information['qatools_config']['project']['reference_branch']
    except:
      is_reference = False
    ci_commit.data = {**ci_commit.data, 'qatools_config': qatools_config}
    if is_initialization or is_reference:
      project.information = {
        **project.information,
        'qatools_config': qatools_config,
      }

  # we update the project metrics
  if 'qatools_config' in project.information:
    metrics_path = project.information['qatools_config']['outputs']['metrics']
    try:
      metrics_content = repo.git.show('{}:{}'.format(ci_commit.id, metrics_path))
    except:
      metrics_content = None

    if metrics_content:
      if metrics_path.endswith('yaml'):
          metrics = yaml.load(metrics_content)        
      elif metrics_path.endswith('json'):
        metrics = json.loads(metrics_content)
      project.information = {
        **project.information,
        'qatools_metrics': metrics,
      }

  db_session.add(project)
  db_session.commit()
  # print(project.information)
  return "{status:'OK'}"
