import json

from gitdb.exc import BadName
import ujson
from flask import request, jsonify, make_response

from sqlalchemy.orm import joinedload
from sqlalchemy.orm.exc import NoResultFound
from sqlalchemy.orm.attributes import flag_modified

from backend import app, db_session
from ..models import Project, CiCommit, latest_successful_commit, Batch



@app.route("/api/v1/commit", methods=['GET', 'POST'])
@app.route("/api/v1/commit/", methods=['GET', 'POST'])
@app.route("/api/v1/commit/<path:commit_id>", methods=['GET', 'POST'])
def api_ci_commit(commit_id=None):
  if request.method == 'POST':
    hexsha = request.json.get('commit_sha', request.json['git_commit_sha']) if not commit_id else commit_id
    try:
      commit = CiCommit.get_or_create(
        session=db_session,
        hexsha=hexsha,
        project_id=request.json['project'],
        data=request.json,
      )
    except:
      return f"404 ERROR:\n ({request.json['project']}): There is an issue with your commit id ({request.json['git_commit_sha']})", 404
    if not commit.data:
      commit.data = {}
    # Clients can store any metadata with each commit.
    # We've been using it to store code quality metrics per subproject in our monorepo,
    # Then we use other tools (e.g. metabase) to create dashboards.
    commit_data = request.json.get('data', {})
    commit.data = {**commit.data, **commit_data}
    flag_modified(commit, "data")
    if commit.deleted:
      commit.deleted = False
    db_session.add(commit)
    db_session.commit()
    return jsonify({"status": "OK"})


  project_id = request.args['project']
  if not commit_id:
    commit_id = request.args.get('commit', None)
    try:
      project = Project.query.filter(Project.id==project_id).one()
      default_branch = project.data['qatools_config']['project']['reference_branch']
    except:
      default_branch = 'master'
    branch = request.args.get('branch', default_branch)
    ci_commit = latest_successful_commit(db_session, project_id=project_id, branch=branch, batch_label=request.args.get('batch'))
    if not ci_commit:
      return jsonify({'error': f'Sorry, we cant find any commit with results for the {project_id} on {branch}.'}), 404
  else:
    try:
      ci_commit = (db_session
                   .query(CiCommit)
                   .options(
                     joinedload(CiCommit.batches).
                     joinedload(Batch.outputs)
                    )
                   .filter(
                     CiCommit.project_id==project_id,
                     CiCommit.hexsha.startswith(commit_id),
                   )
                   .all()
                  )
      # fixme: some commits appear twice, one with a short hash...
      # http://alginfra1:6001/CDE-Users/HW_ALG/CIS/tests/products/HM3/commit/2861963a2216816252660bfdd2d9f459ae80b547?reference=ae720d287&batch=default&filter=01_S5KRM1_Nona_12BIT_OUTD02_6576x4992_EIT1.40ms_AGx1_DGx1.ra&selected_views=bit_accuracy
      # for commit in ci_commit:
      #   print(commit, commit.hexsha)
      ci_commit = ci_commit[0]
    except NoResultFound:
      try:
        # TODO: This is a valid use case for having read-rights to the repo,
        #       we can identify a commit by the tag/branch
        #       To replace this without read rights, we should listen for push events and build a database
        project = Project.query.filter(Project.id==project_id).one()
        commit = project.repo.tags[commit_id].commit
        try:
          commit = project.repo.commit(commit_id)
        except:
          try:
            commit = project.repo.refs[commit_id].commit
          except:
            commit = project.repo.tags[commit_id].commit
        ci_commit = CiCommit(commit, project=project)
        db_session.add(ci_commit)
        db_session.commit()
      except:
        return jsonify({'error': f'Sorry, we could not find any data on commit {commit_id} in project {project_id}.'}), 404
    except BadName:
      return jsonify({f'error': f'Sorry, we could not understand the commid ID {commit_id} for project {project_id}.'}), 404
    except Exception as e:
      raise(e)
      return jsonify({'error': 'Sorry, the request failed.'}), 500

  batch = request.args.get('batch', None)
  with_batches = [batch] if batch else None # by default we show all batches
  with_aggregation = json.loads(request.args.get('metrics', '{}'))
  response = make_response(ujson.dumps(ci_commit.to_dict(with_aggregation, with_batches=with_batches, with_outputs=True)))
  response.headers['Content-Type'] = 'application/json'
  return response


@app.route("/api/v1/commit/save-artifacts/", methods=['POST'])
@app.route("/api/v1/commit/save-artifacts", methods=['POST'])
def commit_save_artifacts():
  hexsha = request.json.get('hexsha')
  try:
      ci_commits = (db_session
                   .query(CiCommit)
                   .filter(
                     CiCommit.hexsha == hexsha,
                   )
                  )
  except:
    return f"404 ERROR:\n ({request.json['project']}): There is an issue with your commit id ({hexsha})", 404
  for ci_commit in ci_commits.all():
    if not request.json['project'].startswith(ci_commit.project_id):
      print(f'skip {ci_commit.project_id}')
      continue
    print(f"[save-artifacts] {ci_commit}")
    # FIXME: in the clean crontab we remove commits without runs
    # if we rely on artifacts from a subproject without runs, it will cause issues... 
    # we should use the git info to find the qatools.yaml
    ci_commit.save_artifacts()
    if ci_commit.deleted:
      ci_commit.deleted = False
      db_session.add(ci_commit)
      db_session.commit()
  return 'OK'
