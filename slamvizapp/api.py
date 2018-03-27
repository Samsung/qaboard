# we expose a simple REST API
# https://flask-restless.readthedocs.io/en/stable/customizing.html
# for now we don't use it, but it could be convenient
import datetime
import subprocess
import json
from gitdb.exc import BadName

from flask import request, jsonify
from sqlalchemy.orm.exc import NoResultFound
# from flask_restless import APIManager
# from flask_restless.serialization import DefaultSerializer

from slamvizapp import app, repo, db_session
from .models import CiCommit
from .models.LocalMocks import LocalCommit
from .models import latest_successful_commit

from .utils import get_users_per_name
from .config import recording_groups_filepath, ci_directory


@app.route("/api/v1/recordings/groups")
def get_groups():
  with recording_groups_filepath.open() as f:
    return f.read()


@app.route("/api/v1/commit/<hexsha>/batch", methods=['POST'])
@app.route("/api/v1/commit/<hexsha>/batch", methods=['POST'])
def add_batch(hexsha):
  try:
    commit = repo.commit(hexsha)
    ci_commit = CiCommit.query.filter(CiCommit.id == commit.hexsha).one()
  except NoResultFound:
    return jsonify("Sorry, the commit id was not found"), 404

  data = request.get_json()
  if data['groups']:
    with recording_groups_filepath.open('w') as f:
      f.write(data['groups'])

  if data['selected_group']:
    ci_commit.time_of_last_batch = datetime.datetime.now().astimezone()
    db_session.add(ci_commit)
    db_session.commit()
    overwrite = '--overwrite' if data['overwrite'] == 'on' else ''
    main_branch = 'feature-parameter-tuning' # FIXME develop
    cmd = ' '.join([
        'ssh -o StrictHostKeyChecking=no arthurf@arthurf-vdi',
        # add bsub somewhere here to return quickly without waiting for finished submission
        '"',
        f'cd {ci_directory}/branches/{main_branch}/psp_swip;',
        f"setenv SAMSUNG_CI_COMMIT_DIR '{ci_commit.commit_dir}';",
        f"setenv CI_COMMIT_SHA '{ci_commit.gitcommit.hexsha}';",
        'python tools/performance-evaluation/run.py',
        f'--batch-label {data["batch_label"]}',
        f'--platform {data["platform"]}',
        f'--configuration {data["configuration"]}',
        'batch',
        f'--recording-groups-file {recording_groups_filepath}',
        f'--recording-groups {data["selected_group"]}',
        f'--tuning-search "{json.dumps(data["tuning_search"])}"'
        f'{overwrite}',
        f'--no-wait'
        '"',
    ])
    print(cmd)
    subprocess.run(cmd, shell=True, encoding='utf-8')
    return jsonify(cmd)
  return jsonify('OK')


@app.route("/api/v1/commits")
@app.route("/api/v1/commits/<path:branch>")
def get_commits(branch=None):
  max_count = int(request.args.get('count', 20))
  page = int(request.args.get('page', 0))
  committer_name = request.args.get('committer', None)

  if not branch:
    if committer_name is None:
      ci_commits = CiCommit.query\
        .order_by(CiCommit.authored_datetime.desc())\
        .limit(max_count)\
        .offset(page*max_count)
    else:
      ci_commits = CiCommit.query\
        .filter_by(committer_name=committer_name)\
        .order_by(CiCommit.authored_datetime.desc())\
        .limit(max_count)\
        .offset(page*max_count)
  else:
    commits = repo.iter_commits(branch, max_count=max_count, skip=max_count*page)
    commit_ids = [c.hexsha for c in commits]
    ci_commits = CiCommit.query\
      .filter(CiCommit.id.in_(commit_ids))\
      .order_by(CiCommit.authored_datetime.desc())

  users_db = get_users_per_name("")
  return jsonify([c.to_dict(users_db=users_db) for c in ci_commits])


@app.route("/api/v1/branches")
def list_branches():
  return jsonify([r.name for r in repo.refs if r.name.startswith('origin/')])


@app.route("/api/v1/commit")
@app.route("/api/v1/commit/")
@app.route("/api/v1/commit/<path:commit_id>")
def get_ci_commit(commit_id=None):
  if not commit_id:
    ci_commit = latest_successful_commit('origin/develop')
  else:
    try: # we try a commit from git
      commit = repo.commit(commit_id)
      ci_commit = CiCommit.query.filter(CiCommit.id == commit.hexsha).one()
    except BadName:
      ci_commit = LocalCommit(commit_id)
      try:
        ci_commit = LocalCommit(commit_id)
      except:
        return jsonify({'error': 'Sorry, we could not find the commit folder.'}), 404
    except NoResultFound:
      return jsonify({'error': 'Sorry, we could not find the commit in the database.'}), 404
    except:
      return jsonify({'error': 'Sorry, the request failed.'}), 500
    # FIXME: we should add details about the outputs...
    # FIXME: how do we get the reference commit?

  users_db = get_users_per_name("")
  return jsonify(ci_commit.to_dict(with_details=True, users_db=users_db))



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
#       'time_of_last_slam_job': self.time_of_last_slam_job,
#       'commit_dir_url': self.commit_dir_url,
#       'aggregated_metrics': self.aggregated_metrics(),
#       'failure_count': self.failure_count(),
#       'valid_slam_outputs': [o.id for o in self.valid_slam_outputs],
#     }


# manager.create_api(CiCommit,
#   methods=['GET', 'POST', 'DELETE'],
#   #   # exclude_columns=['slam_outputs'],
#   # serializer_class=CiCommitSerializer,
#   #   # includes = ['name', 'birth_date', 'computers', 'computers.vendor']
# )
# manager.create_api(Recording,
#   methods=['GET', 'POST', 'DELETE'],
# #   # results_per_page=40, # ?page=X
# )
# manager.create_api(ParametersSet,
#   methods=['GET', 'POST', 'DELETE'],
# #   # results_per_page=40,
# )
# manager.create_api(SlamOutput,
#   methods=['GET', 'POST', 'DELETE'],
# #   # results_per_page=40,
# )

# manager.init_app(app)
