"""
Access data related to Projects.
"""
import pytz
import json
import datetime

import ujson
from flask import request, jsonify, make_response

from sqlalchemy import func, and_, asc, or_
from sqlalchemy.orm import selectinload

from sqlalchemy.orm.attributes import flag_modified
from sqlalchemy.sql import label

from backend import app, db_session
from ..models import Project, CiCommit, Batch, Output
from ..utils import profiled


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

  with_outputs = False if request.args.get('with_outputs', 'false')=='false' else True
  ci_commits = db_session.query(CiCommit)
  if True: # with_outputs: do this when we pre-aggregated counts of Outputs per status...
    ci_commits = ci_commits.options(selectinload(CiCommit.batches).selectinload(Batch.outputs))
  else:
    ci_commits = ci_commits.options(selectinload(CiCommit.batches))
  ci_commits = (ci_commits
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
  if project_id.startswith("CDE-Users/HW_ALG"): # too many results to be fast...
    with_aggregation = {}

  with_batches = None
  batch = request.args.get('batch', None)
  if batch:
    with_batches = [batch]
  else:
    only_ci_batches = False if request.args.get('only_ci_batches', 'false')=='false' else True
    if only_ci_batches:
      with_batches = ['default']
  serializable_commits = []
  # with profiled():
  for c in ci_commits.limit(1000):
    if not c.batches:
      continue
    serializable_commits.append(c.to_dict(
      with_aggregation=metrics_to_aggregate,
      with_batches=with_batches,
      with_outputs=with_outputs
    ))
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



