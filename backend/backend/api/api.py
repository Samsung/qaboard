"""
Simple REST API to list the objects in our database.
"""
import sys
import datetime
import pytz
import subprocess
import json
from pathlib import Path

import ujson
from gitdb.exc import BadName
from flask import request, jsonify, make_response, redirect

from sqlalchemy import func, and_, asc, or_
from sqlalchemy.orm import joinedload, selectinload
from sqlalchemy.orm.exc import NoResultFound, MultipleResultsFound
from sqlalchemy.orm.attributes import flag_modified
from sqlalchemy.sql import label

from backend import app, db_session
from ..models import Project, CiCommit, Batch, Output
from ..models import latest_successful_commit



to_datetime = lambda s: timezone.localize(datetime.datetime.strptime(s, '%Y-%m-%dT%H:%M:%S.%fZ'))
timezone = pytz.timezone("utc")


@app.route("/api/v1/commits")
@app.route("/api/v1/commits/")
@app.route("/api/v1/commits/<path:branch>")
def get_commits(branch=None):
  project_id = request.args['project']

  to_date_s = request.args.get('to', None)
  now_localized = timezone.localize(datetime.datetime.now())

  to_date = to_datetime(to_date_s) if to_date_s else now_localized
  # We only care about days, and this makes sure we smooth out TZ issues
  # It's likely unnecessary...
  to_date = to_date + datetime.timedelta(hours=3)

  from_date_s = request.args.get('from', None)
  from_date = to_datetime(from_date_s) if from_date_s else (now_localized - datetime.timedelta(days=4))
  ci_commits = (db_session
                  .query(func.max(CiCommit.authored_datetime))
                  .filter(CiCommit.project_id == project_id)
                )
  if branch:
    branch = branch.replace('origin/', '')
    ci_commits = ci_commits.filter(or_(CiCommit.branch == branch, CiCommit.branch == f'origin/{branch}'))
  committer_name = request.args.get('committer', None)
  if committer_name:
    ci_commits = ci_commits.filter_by(committer_name=committer_name)

  latest_authored_datetime = ci_commits.scalar()
  if not latest_authored_datetime:
  	return jsonify([])
  from_date = min(latest_authored_datetime - (to_date - from_date), from_date)
  from_date = from_date - datetime.timedelta(hours=3) # timezones as above


  ci_commits = (db_session
                .query(CiCommit)
                .options(selectinload(CiCommit.batches).selectinload(Batch.outputs))
                .filter(
                  CiCommit.authored_datetime >= from_date,
                  CiCommit.authored_datetime <= to_date,
                  CiCommit.project_id == project_id,
                )
                .order_by(CiCommit.authored_datetime.desc())
               )

  if committer_name:
    ci_commits = ci_commits.filter_by(committer_name=committer_name)
  if branch:
    ci_commits = ci_commits.filter(or_(CiCommit.branch == branch, CiCommit.branch == f'origin/{branch}'))


  metrics_to_aggregate = json.loads(request.args.get('metrics', '{}'))
  with_batches = None
  batch = request.args.get('batch', None)
  if batch:
    with_batches = [batch]
  else:
    only_ci_batches = False if request.args.get('only_ci_batches', 'false')=='false' else True
    if only_ci_batches:
      with_batches = ['default']
  with_outputs = False if request.args.get('with_outputs', 'false')=='false' else True
  # from ..utils import profiled
  # with profiled():
  serializable_commits = [c.to_dict(with_aggregation=metrics_to_aggregate, with_batches=with_batches, with_outputs=with_outputs)
                          for c in ci_commits]
  response = make_response(ujson.dumps(serializable_commits))
  response.headers['Content-Type'] = 'application/json'
  return response

@app.route("/api/v1/project/branches")
def get_branches():
  """Returns a list of that project's branches"""
  project_id = request.args.get('project')
  branches = (db_session
              .query(CiCommit.branch)
              .filter(CiCommit.project_id==project_id)
              .distinct()
              .order_by(CiCommit.branch)
             )
  return jsonify([b[0] for b in branches])



@app.route("/api/v1/projects")
def get_projects():
  projects = (db_session
              .query(
                Project.id,
                Project.data,
                Project.latest_output_datetime,
                label('latest_commit_datetime', func.max(CiCommit.authored_datetime)),
                label('total_commits', func.count(CiCommit.id)),
              )
              .join(CiCommit)
              .group_by(Project.id)
              .order_by(asc(func.lower(Project.id)))
              .all()
             )
  projects = {
    project_id: {
      # TODO: drop qatools_metrics from each project
      # TODO: drop qatools_config
      'data': data,
      'latest_output_datetime': latest_output_datetime.isoformat() if latest_output_datetime else None, # isoformat not necessary?
      'latest_commit_datetime': latest_commit_datetime.isoformat(),
      'total_commits': total_commits,
    } for project_id, data, latest_output_datetime, latest_commit_datetime, total_commits in projects }
  response = make_response(ujson.dumps(projects))
  response.headers['Content-Type'] = 'application/json'
  return response

@app.route("/api/v1/project")
def get_project():
  project_id = request.args['project']
  project = (Project
               .query.filter(
                 Project.id==project_id,
               )
               .one()
              )
  return jsonify(project.data)


@app.route("/api/v1/output/<output_id>", methods=['GET', 'DELETE'])
@app.route("/api/v1/output/<output_id>/", methods=['GET', 'DELETE'])
def crud_output(output_id):
  output = Output.query.filter(Output.id==output_id).one()
  if request.method == 'GET':
    return jsonify(output.to_dict())
  if request.method == 'DELETE':
    if output.is_pending:
      return {"error": "Please wait for the Output to finish running before deleting it"}, 500
    output.delete(soft=False)
    db_session.delete(output)
    db_session.commit()
    return {"status": "OK"}


@app.route("/api/v1/output/<output_id>/manifest", methods=['GET'])
@app.route("/api/v1/output/<output_id>/manifest/", methods=['GET'])
def get_output_manifest(output_id):
  output = Output.query.filter(Output.id==output_id).one()
  if output.is_running or request.args.get('refresh'):
    manifest = output.update_manifest(compute_hashes=False)
    return jsonify(manifest)
  else:
    return redirect(f"{output.output_dir_url}/manifest.outputs.json", code=302)
    




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
                   .one()
                  )
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
