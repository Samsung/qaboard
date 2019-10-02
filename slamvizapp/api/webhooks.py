import sys
import json
import yaml
import traceback
import subprocess
from pathlib import Path
import datetime

from flask import request, jsonify
from sqlalchemy.orm.exc import NoResultFound
from sqlalchemy.orm.attributes import flag_modified

# from qatools.config import merge
import qatools

from slamvizapp import app, repos, db_session
from ..models import Project, CiCommit, Batch, Output, TestInput
from ..git_utils import git_pull


@app.route('/api/v1/batch/stop', methods=['POST'])
@app.route('/api/v1/batch/stop/', methods=['POST'])
def stop_batch():
  data = request.get_json()
  try:
    batch = Batch.query.filter(Batch.id == data['id']).one()
  except:
    return f"404 ERROR:\n Not found", 404
  if not batch.data and 'commands' in batch.data:
    return f"404 ERROR:\n Not commands found", 404
  stdouts = []
  kill_commands = []
  for _, command in batch.data['commands'].items():
    kill_command = f"LC_ALL=en_US.utf8 LANG=en_US.utf8 ssh -q -tt -i /home/arthurf/.ssh/ispq.id_rsa ispq@ispq-vdi bsub_su {command['user']} -I bkill -J '{command['lsf_jobs_prefix']}/*'"
    kill_commands.append(kill_command)
    print(kill_command)
    out = subprocess.run(kill_command, shell=True, encoding="utf-8", stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    try:
      out.check_returncode()
      print(out.stdout)
      stdouts.append(str(out.stdout))
    except:
      return jsonify({"error": str(out.stdout), "cmd": str(kill_command)}), 500
  return jsonify({"cmd": '\n'.join(kill_commands), "stdout": '\n\n'.join(stdouts)})


@app.route('/api/v1/commit', methods=['POST'])
@app.route('/api/v1/commit/', methods=['POST'])
def update_commit():
  data = request.get_json()
  try:
    commit = CiCommit.get_or_create(
      session=db_session,
      hexsha=request.json['git_commit_sha'],
      project_id=request.json['project'],
    )
  except:
    return f"404 ERROR:\n ({request.json['project']}): There is an issue with your commit id ({request.json['git_commit_sha']})", 404
  if not commit.data:
    commit.data = {}
  commit_data = request.json.get('data', {})
  commit.data = {**commit.data, **commit_data}
  flag_modified(commit, "data")
  if commit.deleted:
    commit.deleted = False
  db_session.add(commit)
  db_session.commit()
  return jsonify({"status": "OK"})


@app.route('/api/v1/batch', methods=['POST'])
@app.route('/api/v1/batch/', methods=['POST'])
def update_batch():
  data = request.get_json()
  try:
    ci_commit = CiCommit.get_or_create(
      session=db_session,
      hexsha=request.json['git_commit_sha'],
      project_id=request.json['project'],
    )
  except:
    return f"404 ERROR:\n ({request.json['project']}): There is an issue with your commit id ({request.json['git_commit_sha']})", 404

  batch = ci_commit.get_or_create_batch(data['batch_label'])
  if not batch.data:
    batch.data = {}
  batch_data = request.json.get('data', {})
  batch.data = {**batch.data, **batch_data}

  command = request.json.get('command')
  if command:
    batch.data["commands"] = {**batch.data.get('commands', {}), **command}
    flag_modified(batch, "data")

  is_best = 'best_iter' in batch_data and batch_data['best_iter'] != batch.data.get('best_iter')
  if is_best:
    # remove all non-optim_iteration results from the batch
    batch.outputs = [o for o in batch.outputs if o.output_type=='optim_iteration']
    db_session.add(batch)
    db_session.commit()
    # make copy of all outputs in the best batch
    best_batch = ci_commit.get_or_create_batch(f"{data['batch_label']}|iter{batch_data.get('best_iter')}")
    for o in best_batch.outputs:
      o_copy = o.copy()
      o_copy.output_dir_override = str(o.output_dir)
      o_copy.batch = batch
      db_session.add(o_copy)

  db_session.add(batch)
  db_session.commit()
  return jsonify({"status": "OK"})



@app.route('/api/v1/output', methods=['POST'])
@app.route('/api/v1/output/', methods=['POST'])
def new_output_webhook():
  """Updates the database when we get new results."""
  data = request.get_json()
  # we can only trust CI outputs to run on the exact code from the commit
  is_ci = data['job_type'] == 'ci'

  # We get a handle on the Commit object related to our new output
  try:
    ci_commit = CiCommit.get_or_create(
      session=db_session,
      hexsha=data['git_commit_sha'],
      project_id=data['project'],
    )
  except:
    return jsonify({"error": f"Could not find your commit ({data['git_commit_sha']})."}), 404

  ci_commit.project.latest_output_datetime = datetime.datetime.utcnow()
  ci_commit.latest_output_datetime = datetime.datetime.utcnow()

  # We make sure the Test on which we ran exists in the database 
  test_input_path = data.get('input_path')
  if not test_input_path:
    return jsonify({"error": "the input path was not provided"}, 400)
  test_input = TestInput.get_or_create(
    db_session,
    path=test_input_path,
    database=data.get('database', ci_commit.project.database),
  )

  # We save the basic information about our result
  batch = ci_commit.get_or_create_batch(data['batch_label'])
  if not batch.data:
    batch.data = {}
  batch.data.update({"type": data['job_type']})
  if data.get('input_metadata'):
    test_input.data['metadata'] = data['input_metadata']
    flag_modified(test_input, "data")

  output = Output.get_or_create(db_session,
                                         batch=batch,
                                         platform=data['platform'],
                                         configuration=data['configuration'],
                                         extra_parameters=data['extra_parameters'],
                                         test_input=test_input,
                                        )
  output.output_type = data.get('output_type', '')
  output.data = data.get('data', {"ci": is_ci})
  if output.deleted:
    output.deleted = False

  # We allow users to save their data in custom locations
  # at the commit and output levels
  if Path(data.get('commit_ci_dir', ci_commit.commit_dir)) != ci_commit.commit_dir:
    ci_commit.commit_dir_override = data.get('commit_ci_dir')
  if Path(data.get('output_directory', output.output_dir)) != output.output_dir:
    output.output_dir_override = data.get('output_directory')

  # We update the output's status
  output.is_running = data.get('is_running', False)
  if output.is_running:
    output.is_pending = True
  else:
    output.is_pending = data.get('is_pending', False)

  # We save the output's metrics
  if not output.is_pending:
    metrics = data.get('metrics', {})
    if not metrics: # we look for metrics.json in the output directory
      output.update_metrics()
    else:
      output.metrics = metrics
    output.is_failed = data.get('is_failed', False) or metrics.get('is_failed')

  db_session.add(output)
  db_session.commit()
  return jsonify(output.to_dict())



@app.route('/webhook/gitlab', methods=['GET', 'POST'])
def gitlab_webhook():
  """Gitlab calls this endpoint every push, it garantees we stay synced."""
  # https://docs.gitlab.com/ce/user/project/integrations/webhooks.html
  data = json.loads(request.data)
  print(data, file=sys.stderr)

  branch = data['ref'][11:] # data['ref'] => 'refs/heads/feature/Imu_preintegration'

  # Update the root project - all subprojects depend on it
  root_project_id = data['project']['path_with_namespace'] # eg => dvs/psp_swip
  root_project = Project.get_or_create(session=db_session, id=root_project_id)
  root_project.data.update({'git': data['project']})
  db_session.add(root_project)
  # https://stackoverflow.com/questions/30088089/sqlalchemy-json-typedecorator-not-saving-correctly-issues-with-session-commit
  flag_modified(root_project, "data")
  db_session.commit()
  repo = repos[root_project_id]
  git_pull(repo)

  # List all the files named "qatools.yaml" in this commit
  repo_files = repo.git.ls_tree('--name-only', '-r', data['checkout_sha']).splitlines()
  projects_config_paths = [Path(f) for f in repo_files if f.endswith('qatools.yaml')]
  for subproject_config_path in projects_config_paths:
    # Each one is a subproject
    project_id = str(root_project_id  / subproject_config_path.parent)
    # Make sure the it exists in the database, with up-to-date metadata
    project = Project.get_or_create(session=db_session, id=project_id)
    project.data.update({'git': data['project']})
    flag_modified(project, "data")
    db_session.add(project)
    db_session.commit()
    # print(project)

    try:
      ci_commit = CiCommit.get_or_create(
        session=db_session,
        hexsha=data['checkout_sha'],
        project_id=project_id,
      )
    except Exception as e:
      exc_type, exc_value, exc_traceback = sys.exc_info()
      info = ''.join(traceback.format_exception(exc_type, exc_value, exc_traceback))
      print(info, file=sys.stderr)
      return f"404 ERROR: with commit id {data['checkout_sha']} in project {project_id}: {info}", 404

    # To update the (sub)project configuration stored in the database,
    # we first need to read relevant qatools.yaml files from this commit.
    def is_relative_to(path, path_maybe_parent):
      try:
        relative_path = path.relative_to(path_maybe_parent)
        return True
      except:
        return False
    config_paths = [p for p in projects_config_paths if is_relative_to(subproject_config_path.parent, p.parent)]
    config_paths.sort()
    try:
      configs_contents = [repo.git.show(f'{ci_commit.hexsha}:{p}') for p in config_paths]
      configs = [yaml.load(c) for c in configs_contents]
      qatools_config = {}
      for c in configs:
        qatools_config = qatools.merge(c, qatools_config)
      qatools_config['project']['name'] = project_id
    except Exception as e:
      exc_type, exc_value, exc_traceback = sys.exc_info()
      info = ''.join(traceback.format_exception(exc_type, exc_value, exc_traceback))
      print(info, file=sys.stderr)
      continue

    # We store qatools's configuration twice: at the project level and at the commit level
    # - Commit-level info is important to let users easily tweak the outputs and metrics
    #   they want to see when working on their branches 
    ci_commit.data.update({'qatools_config': qatools_config})
    # - Project-level information is used as a default or when showing in the UI list of commits
    #   It is only updated when there are changes on the "reference branch" (eg master, develop...)
    #   This said, we also update project-level data when it's the first time we get a qatools config for a project
    is_initialization = 'qatools_config' not in project.data
    reference_branch = qatools_config['project'].get('reference_branch', 'master')
    is_reference = branch == reference_branch
    if is_initialization or is_reference:
      project.data.update({'qatools_config': qatools_config,})
      flag_modified(project, "data")

    metrics_path = qatools_config.get('outputs', {}).get('metrics')
    if metrics_path:
      try:
        metrics_content = repo.git.show('{}:{}'.format(ci_commit.hexsha, metrics_path))
      except:
        metrics_content = None
      if metrics_content:
        try:
          if metrics_path.endswith('yaml'):
              metrics = yaml.load(metrics_content)        
          elif metrics_path.endswith('json'):
            metrics = json.loads(metrics_content)
          ci_commit.data.update({'qatools_metrics': metrics})
          flag_modified(ci_commit, "data")
          if is_initialization or is_reference:
            project.data.update({'qatools_metrics': metrics})
            flag_modified(project, "data")
        except Exception as e: 
          exc_type, exc_value, exc_traceback = sys.exc_info()
          info = ''.join(traceback.format_exception(exc_type, exc_value, exc_traceback))
          print(info, file=sys.stderr)

    print('project.data :', project.data)
    db_session.add(ci_commit)
    db_session.add(project)
    db_session.commit()

  return "{status:'OK'}"


@app.route("/api/v1/webhook/proxy", methods=['POST'])
@app.route("/api/v1/webhook/proxy/", methods=['POST'])
def proxy_webook():
  """
  Proxy users' webhook triggers to avoid CORS issues.
  """
  from requests import Request, Session
  from requests.auth import HTTPBasicAuth

  data = request.get_json()
  data['method'] = data['method'].upper()
  if 'auth' in data:
    # we could easily support other types of authentification
    # https://2.python-requests.org/en/master/user/authentication/
    data['auth'] = HTTPBasicAuth(data['auth']['username'], data['auth']['password'])
  session = Session()
  r = Request(**data)
  r_prepped = r.prepare()

  response = session.send(r_prepped, verify=False)
  print(response.headers)
  return response.content, response.status_code
