import sys
import json
import yaml

from flask import request
from sqlalchemy.orm.exc import NoResultFound

from slamvizapp import app, repos, db_session
from ..models import Project, CiCommit, Output, TestInput
from ..git_utils import git_pull



@app.route('/api/v1/output', methods=['POST'])
@app.route('/api/v1/output/', methods=['POST'])
def new_output_webhook():
  """Updates the database when we get new results."""
  data = request.get_json()
  # For now, we do nothing with local runs
  if data['job_type'] != 'ci':
    print(data['output_directory'])
    return "OK"

  # We get a handle on the Commit object related to our new output
  try:
    ci_commit = CiCommit.get_or_create(
      session=db_session,
      hexsha=request.json['git_commit_sha'],
      repo=repos[request.json.get('project', 'dvs/psp_swip')],
    )
  except:
    return f"404 ERROR:\n there is an issue with your commit id ({request.json['git_commit_sha']})", 404

  # The output belongs to this batch of outputs
  batch = ci_commit.get_or_create_batch(data['batch_label'])

  # We make sure the Test on which we ran exists in the database 
  test_input_path = request.json.get('recording_path', request.json.get('input_path'))
  if not test_input_path:
    return jsonify({"error": "the input path was not provided"}, 400)
  test_input = TestInput.get_or_create(
    db_session,
    path=test_input_path,
    database=request.json.get('database', ci_commit.project.database),
  )
  if not test_input: return "KO", 404

  # We save the basic information about our result
  output = Output.get_or_create(db_session,
                                         batch=batch,
                                         platform=data['platform'],
                                         configuration=data['configuration'],
                                         extra_parameters=data['extra_parameters'],
                                         test_input=test_input,
                                        )
  output.output_type = request.json.get('output_type', 'slam/6dof')
  output.data = request.json.get('data', {})

  # We allow users to save their data in custom locations
  # at the commit and output levels
  if Path(request.json.get('commit_ci_dir', ci_commit.commit_dir)) != ci_commit.commit_dir:
    ci_commit.commit_dir_override = request.json.get('commit_ci_dir')
  if Path(request.json.get('output_directory', output.output_dir)) != output.output_dir:
    output.output_dir_override = request.json.get('output_directory')

  # We update the output's status
  output.is_running = request.json.get('is_running', False)
  if output.is_running:
    output.is_pending = True
  else:
    output.is_pending = request.json.get('is_pending', False)

  # We save the output's metrics
  if not output.is_pending:
    metrics = request.json.get('metrics', {})
    if not metrics: # we look for metrics.json in the output directory
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
    **(project.information if project.information else {}),
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
      print(f'WARNING: ci_commit is None for {commit.hexsha}')
      return "{status:'OK'}"

  db_session.add(ci_commit)
  db_session.commit()


  # we update the project configuration stored in the database
  # using the information found in this commit's qatools.yaml
  try:
    qatools_config_contents = repo.git.show('{}:{}'.format(ci_commit.id, 'qatools.yaml'))
  except:
    qatools_config_contents = None
    qatools_config = None
  if qatools_config_contents:
    qatools_config = yaml.load(qatools_config_contents)

  if qatools_config:
    print('Found qatools.yaml')
    is_initialization = 'qatools_config' not in project.information
    try:
      is_reference = not is_initialization and branch == qatools_config['project']['reference_branch']
    except:
      is_reference = False
    ci_commit.data = {**(ci_commit.data if ci_commit.data else {}), 'qatools_config': qatools_config}
    if is_initialization or is_reference:
      project.information = {
        **(project.information if project.information else {}),
        'qatools_config': qatools_config,
      }

  # we update the project metrics
  if 'qatools_config' in project.information:
    metrics_path = project.information['qatools_config']['outputs']['metrics']
    print(f'found metrics at {metrics_path}')
    try:
      metrics_content = repo.git.show('{}:{}'.format(ci_commit.id, metrics_path))
    except:
      metrics_content = None

    if metrics_content:
      if metrics_path.endswith('yaml'):
          metrics = yaml.load(metrics_content)        
      elif metrics_path.endswith('json'):
        metrics = json.loads(metrics_content)
      # print(metrics)
      project.information = {
        **(project.information if project.information else {}),
        'qatools_metrics': metrics,
      }
      # print(project.information)

  db_session.add(project)
  db_session.commit()
  print(project.information)
  return "{status:'OK'}"
