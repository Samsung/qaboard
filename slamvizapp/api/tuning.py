"""
APIs related to parameter tuning
"""
import subprocess
import json
import datetime
from pathlib import Path

from flask import request, jsonify
from sqlalchemy.orm.exc import NoResultFound

from slamvizapp import app, repos, db_session
from ..models import CiCommit, Project
from ..utils import iter_recordings
from ..config import shared_data_directory




@app.route("/api/v1/recordings/groups")
def get_groups():
  project_id = request.args.get('project', 'dvs/psp_swip')
  recording_groups_filepath = shared_data_directory / project_id / 'extra-batches.yml'
  try:
    with (recording_groups_filepath).open('r') as f:
      return f.read()
  except:
    return ''

@app.route("/api/v1/recordings/group")
def get_group():
  project_id = request.args.get('project', 'dvs/psp_swip')
  project = Project.get_or_create(session=db_session, id=project_id)
  recording_groups_filepath = shared_data_directory / project_id / 'extra-batches.yml'
  try:
    is_legacy_project = project_id in ['dvs/psp_swip', 'tof/swip_tof']
    if is_legacy_project:
      recordings = list(iter_recordings(
        [request.args.get('name', '')],
        recording_groups_filepath,
        project.database
      ))
    else:
      import qatools.utils
      test = [request.args.get('name', '')]
      recordings = list(qatools.utils.iter_recordings(
        project.information['qatools_config'],
        [request.args.get('name', '')],
        recording_groups_filepath,
        project.database,
        project.information['qatools_config']['inputs']['configuration'],  
      ))
    return jsonify({'number_of_recordings': len(recordings)})
  except:
    return jsonify({'number_of_recordings': 0})    


@app.route("/api/v1/commit/<hexsha>/batch", methods=['POST'])
@app.route("/api/v1/commit/<hexsha>/batch", methods=['POST'])
def add_batch(hexsha):
  project_id = request.args.get('project', 'dvs/psp_swip')
  try:
    commit = repos[project_id].commit(hexsha)
    ci_commit = (CiCommit
                 .query.filter(
                   CiCommit.project_id==project_id,
                   CiCommit.id.startswith(hexsha),
                 )
                 .one()
                )
  except NoResultFound:
    return jsonify("Sorry, the commit id was not found"), 404

  is_legacy_project = project_id in ['dvs/psp_swip', 'tof/swip_tof']
  if 'qatools_config' not in ci_commit.project.information and not is_legacy_project:
    return jsonify("Please configure `qatools first`"), 404


  data = request.get_json()
  recording_groups_filepath = shared_data_directory / project_id / 'extra-batches.yml'
  if 'groups' in data:
    recording_groups_filepath.parent.mkdir(parents=True, exist_ok=True)
    with recording_groups_filepath.open('w') as f:
      f.write(data['groups'])

  if data['selected_group']:
    ci_commit.time_of_last_batch = datetime.datetime.now().astimezone()
    db_session.add(ci_commit)
    db_session.commit()

    overwrite = '--overwrite' if data['overwrite'] == 'on' else ''
    # to avoid issues with quoting, we create a temporary file to describe the job
    if is_legacy_project:
      batch_command = ' '.join([
        'python tools/performance-evaluation/run.py',
        f"--platform '{data['platform']}'",
        f"--configuration '{data['configuration']}'",
        f"--batch-label '{data['batch_label']}'",
        'batch',
        f'--recording-groups-file {recording_groups_filepath}',
        f"--recording-group '{data['selected_group']}'",
        f"--tuning-search '{json.dumps(data['tuning_search'])}'",
        f'{overwrite}',
        f'--no-wait',
        '\n',
      ])
      working_directory = ci_commit.project.ci_directory / project_id / 'branches' / 'develop' / project_id.split('/')[1]
    else:
      batch_command = ' '.join([
        'qa',
        f"--platform '{data['platform']}'",
        f"--configuration '{data['configuration']}'",
        f"--batch-label '{data['batch_label']}'",
        'batch',
        f'--groups-file {recording_groups_filepath}',
        f"--group '{data['selected_group']}'",
        f"--tuning-search '{json.dumps(data['tuning_search'])}'",
        f'{overwrite}',
        f'--no-wait',
        '\n',
      ])
      config = ci_commit.project.information['qatools_config']
      working_directory = Path(config['ci_root']['linux']) / config['project']['name'] / 'commits' / f'{ci_commit.authored_date}__git__{ci_commit.id[:8]}'
    print(working_directory)
    print(batch_command)

    queue = 'alg_q' if is_legacy_project else ci_commit.project.information['qatools_config']['lsf']['fast_queue']
    # openstf is our device farm
    use_openstf = data['android_device'].lower() == 'openstf'
    batch_script = ''.join([
      '#!/bin/bash\n',
      f'bsub -q {queue} -sp 4000 ', # highest priority
      f'-o /home/arthurf/dvs/slamvizapp/data/{project_id}/lsf.log ',
      '<< EOF\n'
      f'  cd {working_directory};\n',
      # android options
      f"  export RESERVED_ANDROID_DEVICE='{data['android_device']}';\n" if not use_openstf else '',
      f"  export OPENSTF_STORAGE_QUOTA=12;\n" if not use_openstf else '',
      f"  export {'SAMSUNG_CI_COMMIT_DIR' if is_legacy_project else 'QATOOLS_CI_COMMIT_DIR'}='{ci_commit.commit_dir}';\n",
      f"  export GITLAB_USER_LOGIN='{data['user']}';\n" if data['user'] != 'arthurf' else '',
      f"  export CI_COMMIT_SHA='{ci_commit.gitcommit.hexsha}';\n",
      batch_command,
      'EOF',
    ])
    print(batch_script)
    now = datetime.datetime.now().timestamp()
    batch_script_directory = Path(f'/home/arthurf/dvs/slamvizapp/data/batches/{project_id}')
    batch_script_directory.mkdir(exist_ok=True, parents=True)
    batch_script_filepath = batch_script_directory/f'{ci_commit.gitcommit.hexsha}_{now}.sh'
    with batch_script_filepath.open('w') as f:
      f.write(batch_script)
    cmd = f'ssh -o StrictHostKeyChecking=no arthurf@planet31 bash {batch_script_filepath}',
    print(cmd)
    subprocess.run(cmd, shell=True, encoding='utf-8')
    return jsonify({'command': batch_script})
  return jsonify('OK')


