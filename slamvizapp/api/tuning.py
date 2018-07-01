"""
APIs related to parameter tuning
"""
import subprocess
import json
from pathlib import Path

from flask import request, jsonify
from sqlalchemy.orm.exc import NoResultFound

from slamvizapp import app, repos, db_session
from ..models import CiCommit
from ..utils import iter_recordings
from ..config import database_directory
from ..config import shared_data_directory, ci_directory




@app.route("/api/v1/recordings/groups")
def get_groups():
  project_id = request.args.get('project', 'dvs/psp_swip')
  recording_groups_filepath = shared_data_directory / project_id / 'extra-batches.yml'
  with (recording_groups_filepath).open() as f:
    return f.read()


@app.route("/api/v1/recordings/group")
def get_group():
  project_id = request.args.get('project', 'dvs/psp_swip')
  recordings = list(iter_recordings(
    [request.args.get('name', '')],
    shared_data_directory / project_id / 'extra-batches.yml',
    database_directory[project_id]
  ))
  return jsonify({'number_of_recordings': len(recordings)})


@app.route("/api/v1/commit/<hexsha>/batch", methods=['POST'])
@app.route("/api/v1/commit/<hexsha>/batch", methods=['POST'])
def add_batch(hexsha):
  project_id = request.args.get('project', 'dvs/psp_swip')
  try:
    commit = repos[project_id].commit(hexsha)
    ci_commit = CiCommit.query.filter(CiCommit.id.startswith(commit.hexsha)).one()
  except NoResultFound:
    return jsonify("Sorry, the commit id was not found"), 404

  data = request.get_json()
  recording_groups_filepath = shared_data_directory / project_id / 'extra-batches.yml'
  if 'groups' in data:
    with recording_groups_filepath.open('w') as f:
      f.write(data['groups'])

  if data['selected_group']:
    ci_commit.time_of_last_batch = datetime.datetime.now().astimezone()
    db_session.add(ci_commit)
    db_session.commit()
    overwrite = '--overwrite' if data['overwrite'] == 'on' else ''
    main_branch = 'develop'
    # to avoid issues with quoting, we create a temporary file to describe the job
    batch_command = ' '.join([
      'python tools/performance-evaluation/run.py',
      f"--batch-label '{data['batch_label']}'",
      f"--platform '{data['platform']}'",
      f"--configuration '{data['configuration']}'",
      'batch',
      f'--recording-groups-file {recording_groups_filepath}',
      f"--recording-group '{data['selected_group']}'",
      f"--tuning-search '{json.dumps(data['tuning_search'])}'",
      f'{overwrite}',
      f'--no-wait',
      '\n',
    ])
    print(batch_command)
    use_openstf = data['android_device'].lower() == 'openstf'
    device = data['android_device']
    # if use_openstf:
    #   dependencies = f'-w ""'
    # else:
    #   dependencies = ''
    # dependencies_expression = ' && '.join([f'ended({job.name})' for job in dependencies])
    # dependencies_flag = f'-w "{dependencies_expression}"'

    device = '--overwrite' if data['overwrite'] == 'on' else ''
    project_name = project_id.split('/')[1]
    batch_script = ''.join([
      '#!/bin/bash\n',
      'bsub -q alg_q -sp 4000 ', # highest priority
      f'-o /home/arthurf/dvs/slamvizapp/data/{project_id}/lsf.log ',
      '<< EOF\n'
      f'  cd {ci_directory}/{project_id}/branches/{main_branch}/{project_name};\n',
      f"  export RESERVED_ANDROID_DEVICE='{data['android_device']}';\n" if not use_openstf else '',
      f"  export OPENSTF_STORAGE_QUOTA=12;\n" if not use_openstf else '',
      f"  export SAMSUNG_CI_COMMIT_DIR='{ci_commit.commit_dir}';\n",
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


