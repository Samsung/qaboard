import sys
import json
import yaml
import traceback
from pathlib import Path

from flask import request
from sqlalchemy.orm.exc import NoResultFound
from sqlalchemy.orm.attributes import flag_modified    

# from qatools.config import merge
import qatools

from slamvizapp import app, repos, db_session
from ..models import Project, CiCommit, Output, TestInput
from ..git_utils import git_pull


@app.route('/api/v1/batch', methods=['POST'])
@app.route('/api/v1/batch/', methods=['POST'])
def update_batch():
  data = request.get_json()
  try:
    ci_commit = CiCommit.get_or_create(
      session=db_session,
      hexsha=request.json['git_commit_sha'],
      project_id=request.json.get('project', 'dvs/psp_swip'),
    )
  except:
    return f"404 ERROR:\n there is an issue with your commit id ({request.json['git_commit_sha']})", 404

  batch = ci_commit.get_or_create_batch(data['batch_label'])
  batch_data = request.json.get('data', {})
  is_best = 'best_iter' in batch_data and batch_data['best_iter'] != batch.data.get('best_iter')
  batch.data = {**batch.data, **batch_data}

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
  return "OK"



@app.route('/api/v1/output', methods=['POST'])
@app.route('/api/v1/output/', methods=['POST'])
def new_output_webhook():
  """Updates the database when we get new results."""
  data = request.get_json()
  # For now, we do nothing with local runs
  if data['job_type'] != 'ci':
    print(data['output_directory'], file=sys.stderr)
    return "OK"

  # We get a handle on the Commit object related to our new output
  try:
    ci_commit = CiCommit.get_or_create(
      session=db_session,
      hexsha=data['git_commit_sha'],
      project_id=data.get('project', 'dvs/psp_swip'),
    )
  except:
    return f"404 ERROR:\n there is an issue with your commit id ({data['git_commit_sha']})", 404

  # The output belongs to this batch of outputs
  batch = ci_commit.get_or_create_batch(data['batch_label'])

  # We make sure the Test on which we ran exists in the database 
  test_input_path = data.get('recording_path', data.get('input_path'))
  if not test_input_path:
    return jsonify({"error": "the input path was not provided"}, 400)
  test_input = TestInput.get_or_create(
    db_session,
    path=test_input_path,
    database=data.get('database', ci_commit.project.database),
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
  output.output_type = data.get('output_type', 'slam/6dof')
  output.data = data.get('data', {})

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
  return "OK"



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
    db_session.add(project)
    db_session.commit()
    print(project)

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
    config_paths = [p for p in projects_config_paths if p >= subproject_config_path]
    config_paths.sort()
    try:
      configs_contents = [repo.git.show(f'{ci_commit.hexsha}:{p}') for p in config_paths]
      configs = [yaml.load(c) for c in configs_contents]
      qatools_config = qatools.merge(configs)
      qatools_config['project']['name'] = project_id
      print('qatools_config :', qatools_config)
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
      print('updating project-level qatools_config')
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
