# we expose a simple REST API
# https://flask-restless.readthedocs.io/en/stable/customizing.html
# for now we don't use it, but it could be convenient
import sys
import datetime
import pytz
import subprocess
import json
from pathlib import Path
from gitdb.exc import BadName

from flask import request, jsonify
from sqlalchemy import func, and_, asc
from sqlalchemy.orm.exc import NoResultFound
from sqlalchemy.sql import label

# from flask_restless import APIManager
# from flask_restless.serialization import DefaultSerializer

from slamvizapp import app, repos, db_session
from .models import Project, CiCommit
from .models.LocalMocks import LocalCommit
from .models import latest_successful_commit

from .utils import iter_recordings
from .config import recording_groups_filepath, ci_directory


slam_metrics_to_aggregate = {
    # metric_name: threshold_good
    'translation_rmse': 0.01,
    'translation_aape': 0.01,
    'translation_drift_pc': 0.01,
    'rotation_mean': 1.5,
    'rotation_mean_when_good': 1.5,
    'translation_aape_when_good': 0.01,
    'frac_tracking_state_good': .99,
    # 'compute_time_vs_realtime': 1, # FIXME: it's not an attribute so the call will fail
}

@app.route("/api/v1/recordings/groups")
def get_groups():
  with recording_groups_filepath.open() as f:
    return f.read()

@app.route("/api/v1/recordings/group")
def get_group():
  name = request.args.get('name', '')
  recordings = list(iter_recordings([name], recording_groups_filepath))
  return jsonify({'number_of_recordings': len(recordings)})

@app.route("/api/v1/commit/<hexsha>/batch", methods=['POST'])
@app.route("/api/v1/commit/<hexsha>/batch", methods=['POST'])
def add_batch(hexsha):
  try:
    commit = repos['dvs/psp_swip'].commit(hexsha)
    ci_commit = CiCommit.query.filter(CiCommit.id == commit.hexsha).one()
  except NoResultFound:
    return jsonify("Sorry, the commit id was not found"), 404

  data = request.get_json()
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
    device = '--overwrite' if data['overwrite'] == 'on' else ''
    batch_script = ''.join([
      '#!/bin/bash\n',
      'bsub -q alg_q -sp 4000 ', # highest priority
      '-o /home/arthurf/dvs/slamvizapp/data/lsf.log ',
      '<< EOF\n'
      f'  cd {ci_directory}/dvs/psp_swip/branches/{main_branch}/psp_swip;\n',
      f"  export RESERVED_ANDROID_DEVICE='{data['android_device']}';\n" if data['android_device'].lower() != 'openstf' else '',
      f"  export SAMSUNG_CI_COMMIT_DIR='{ci_commit.commit_dir}';\n",
      f"  export GITLAB_USER_LOGIN='{data['user']}';\n" if data['user'] != 'arthurf' else '',
      f"  export CI_COMMIT_SHA='{ci_commit.gitcommit.hexsha}';\n",
      batch_command,
      'EOF',
    ])
    print(batch_script)
    now = datetime.datetime.now().timestamp()
    batch_script_filepath = Path(f'/home/arthurf/dvs/slamvizapp/data/batches/{ci_commit.gitcommit.hexsha}_{now}.sh')
    with batch_script_filepath.open('w') as f:
      f.write(batch_script)
    cmd = f'ssh -o StrictHostKeyChecking=no arthurf@planet31 bash {batch_script_filepath}',
    print(cmd)
    subprocess.run(cmd, shell=True, encoding='utf-8')
    return jsonify({'command': batch_script})
  return jsonify('OK')



to_datetime = lambda s: timezone.localize(datetime.datetime.strptime(s, '%Y-%m-%dT%H:%M:%S.%fZ'))
timezone = pytz.timezone("Asia/Tel_Aviv")

@app.route("/api/v1/commits")
@app.route("/api/v1/commits/")
@app.route("/api/v1/commits/<path:branch>")
def get_commits(branch=None):
  project_id = request.args.get('project', 'dvs/psp_swip')

  to_date_s = request.args.get('to', None)
  now_localized = timezone.localize(datetime.datetime.now())

  to_date = to_datetime(to_date_s) if to_date_s else now_localized
  to_date = to_date + datetime.timedelta(hours=3) # fix timezones hahaha

  from_date_s = request.args.get('from', None)
  from_date = to_datetime(from_date_s) if from_date_s else (now_localized - datetime.timedelta(hours=3))
  latest_ci_commit = (db_session
                      .query(CiCommit)
                      .filter(CiCommit.project_id==project_id)
                      .order_by(CiCommit.authored_datetime.desc())
                      .first()
                     )
  # latest_ci_commit = db_session.query(func.max(CiCommit.authored_datetime))
  from_date = min(latest_ci_commit.authored_datetime - (to_date - from_date), from_date)

  committer_name = request.args.get('committer', None)

  if not branch:
    if committer_name is None:
      ci_commits = (db_session
                    .query(CiCommit)
                    .filter(
                      CiCommit.project_id == project_id,
                      CiCommit.authored_datetime <= to_date,
                      CiCommit.authored_datetime >= from_date
                    )
                    .order_by(CiCommit.authored_datetime.desc())
                   )
    else:
      ci_commits = (CiCommit
                    .query
                    .filter_by(committer_name=committer_name)
                    .filter(
                      CiCommit.project_id == project_id,
                      CiCommit.authored_datetime <= to_date,
                      CiCommit.authored_datetime >= from_date,
                    )
                    .order_by(CiCommit.authored_datetime.desc())
                   )

  else:
    if project_id == 'dvs/psp_swip' and not request.args.get('only_when_first_pushed_as', False):
      commits = []
      page = 0
      earliest_commit = None
      new_commits = []
      while page==0 or earliest_commit.authored_datetime >= from_date:
        repo = repos[project_id]
        new_commits = list(repo.iter_commits(branch, max_count=20, skip=20*page))
        if not new_commits: break
        earliest_commit = new_commits[-1]
        page = page + 1
        commits = commits + new_commits

      is_in_range = lambda c: c.authored_datetime >= from_date and c.authored_datetime <= to_date
      commit_ids = [c.hexsha for c in commits if is_in_range(c)]
      ci_commits = (CiCommit
                    .query
                    .filter(CiCommit.id.in_(commit_ids))
                    .order_by(CiCommit.authored_datetime.desc())
                   )
    else:
      ci_commits = (db_session
                    .query(CiCommit)
                    .filter(
                      CiCommit.project_id == project_id,
                      CiCommit.branch == branch,
                      CiCommit.authored_datetime <= to_date,
                      CiCommit.authored_datetime >= from_date
                    )
                    .order_by(CiCommit.authored_datetime.desc())
                   )

  metrics_to_aggregate = json.loads(request.args.get('metrics', '{}'))
  only_ci_batches = False if request.args.get('only_ci_batches', 'false')=='false' else True
  with_batches = ['default', 'ci-android-rt'] if only_ci_batches else None
  with_outputs = False if request.args.get('with_outputs', 'false')=='false' else True
  return jsonify([c.to_dict(with_aggregation=metrics_to_aggregate, with_batches=with_batches, with_outputs=with_outputs) for c in ci_commits])


@app.route("/api/v1/project/branches")
def list_branches():
  """Returns a list of that project's branches"""
  project_id = request.args.get('project')

  # TODO: seperate git-based projects, and the rest..?
  if project_id=='dvs/psp_swip':
    repo = repos[project_id]
    return jsonify([r.name for r in repo.refs if r.name.startswith('origin/')])

  branches = (db_session
              .query(CiCommit.branch)
              .filter(CiCommit.project_id==project_id)
              .distinct()
              .order_by(CiCommit.branch)
             )
  return jsonify([b[0] for b in branches])



@app.route("/api/v1/projects")
def list_projects():
  # projects = db_session.query(Project).all()
  projects = (db_session
              .query(
                Project.id,
                Project.information,
                label('latest_commit_datetime', func.max(CiCommit.authored_datetime)),
                label('total_commits', func.count(CiCommit.id)),
              )
              .join(CiCommit)
              .group_by(Project.id)
              .order_by(asc(func.lower(Project.id)))
              .all()
             )
  return jsonify({
    project_id: {
      'information': information,
      'latest_commit_datetime': latest_commit_datetime,
      'total_commits': total_commits,
    } for project_id, information, latest_commit_datetime, total_commits  in projects })


@app.route("/api/v1/commit")
@app.route("/api/v1/commit/")
@app.route("/api/v1/commit/<path:commit_id>")
def get_ci_commit(commit_id=None):
  project_id = request.args.get('project', 'dvs/psp_swip')
  if not commit_id:
    commit_id = request.args.get('commit', None)

  if not commit_id:
    branch = request.args.get('branch', 'origin/develop')
    ci_commit = latest_successful_commit(db_session, project_id=project_id, branch=branch)
    if not ci_commit:
      return jsonify({'error': 'Sorry, we cant find a suitable commit.'}), 404
  else:
    try: # we try a commit from git
      if project_id == 'dvs/psp_swip':
        repo = repos[project_id]
        commit = repo.commit(commit_id)
        ci_commit = CiCommit.query.filter(CiCommit.id == commit.hexsha).one()
      else:
        ci_commit = (CiCommit
                     .query.filter(
                      CiCommit.project_id==project_id,
                      CiCommit.id == commit_id,
                     )
                     .one()
                    )
    except BadName:
      try:
        ci_commit = LocalCommit(commit_id)
      except:
        return jsonify({'error': 'Sorry, we could not find the commit folder.'}), 404
    except NoResultFound:
      return jsonify({'error': 'Sorry, we could not find the commit in the database.'}), 404
    except Exception as e:
      raise(e)
      return jsonify({'error': 'Sorry, the request failed.'}), 500
    # FIXME: we should add details about the outputs...
    # FIXME: how do we get the reference commit?
  return jsonify(ci_commit.to_dict(with_outputs=True))



# def add_cors_headers(response):
#     response.headers['Access-Control-Allow-Origin'] = '*'
#     response.headers['Access-Control-Allow-Credentials'] = 'true'
#     return response

# manager = APIManager(session=db_session, url_prefix='/api/v1')

 # https://flask-restless.readthedocs.io/en/latest/serialization.html
# class CiCommitSerializer(DefaultSerializer):
#   def serialize(self):
#     return {
#       'id': self.id,
#       'branch': self.branch,
#       'message': self.gitcommit.message,
#       'authored_datetime': self.authored_datetime,
#       'time_of_last_batch': self.time_of_last_batch,
#       'commit_dir_url': self.commit_dir_url,
#       'aggregated_metrics': self.aggregated_metrics(),
#       'failure_count': self.failure_count(),
#       'valid_outputs': [o.id for o in self.valid_outputs],
#     }


# manager.create_api(CiCommit,
#   methods=['GET', 'POST', 'DELETE'],
#   #   # exclude_columns=['outputs'],
#   # serializer_class=CiCommitSerializer,
#   #   # includes = ['name', 'birth_date', 'computers', 'computers.vendor']
# )
# manager.create_api(TestInput,
#   methods=['GET', 'POST', 'DELETE'],
# #   # results_per_page=40, # ?page=X
# )
# manager.create_api(ParametersSet,
#   methods=['GET', 'POST', 'DELETE'],
# #   # results_per_page=40,
# )
# manager.create_api(Output,
#   methods=['GET', 'POST', 'DELETE'],
# #   # results_per_page=40,
# )

# manager.init_app(app)
