
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
from flask import request, jsonify, make_response

from sqlalchemy import func, and_, asc, or_
from sqlalchemy.orm import joinedload
from sqlalchemy.orm.exc import NoResultFound
from sqlalchemy.sql import label

from slamvizapp import app, repos, db_session
from ..models import Project, CiCommit
from ..models.LocalMocks import LocalCommit
from ..models import latest_successful_commit



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
  from_date = to_datetime(from_date_s) if from_date_s else (now_localized - datetime.timedelta(days=4))
  latest_authored_datetime = db_session.query(func.max(CiCommit.authored_datetime)).scalar()
  from_date = min(latest_authored_datetime - (to_date - from_date), from_date)
  print(f'Listing commits from [{from_date}] to [{to_date}]', file=sys.stderr)

  ci_commits = (db_session
                .query(CiCommit)
                .options(joinedload(CiCommit.batches))
                .filter(
                  CiCommit.project_id == project_id,
                  CiCommit.authored_datetime <= to_date,
                  CiCommit.authored_datetime >= from_date
                )
                .order_by(CiCommit.authored_datetime.desc())
               )

  committer_name = request.args.get('committer', None)
  if committer_name:
    ci_commits = ci_commits.filter_by(committer_name=committer_name)

  if branch:
      print(f'filtering by branch [{branch}] using SQL', file=sys.stderr)
      branch = branch.replace('origin/', '')
      ci_commits = ci_commits.filter(or_(CiCommit.branch == branch, CiCommit.branch == f'origin/{branch}'))

  metrics_to_aggregate = json.loads(request.args.get('metrics', '{}'))
  batch = request.args.get('batch', None)
  with_batches = None
  if batch:
    with_batches = [batch]
  else:
    only_ci_batches = False if request.args.get('only_ci_batches', 'false')=='false' else True
    if only_ci_batches:
      with_batches = ['default', 'ci-android-rt', 'manual-android-rt']
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
      # TODO: drop qatools_config
      # TODO: drop qatools_metrics
      'information': information,
      'latest_commit_datetime': latest_commit_datetime,
      'total_commits': total_commits,
    } for project_id, information, latest_commit_datetime, total_commits  in projects })

@app.route("/api/v1/project")
def get_project():
  project_id = request.args.get('project', 'dvs/psp_swip')
  project = (Project
               .query.filter(
                 Project.id==project_id,
               )
               .one()
              )
  return jsonify(project.information)


@app.route("/api/v1/commit")
@app.route("/api/v1/commit/")
@app.route("/api/v1/commit/<path:commit_id>")
def get_ci_commit(commit_id=None):
  project_id = request.args.get('project', 'dvs/psp_swip')
  if not commit_id:
    commit_id = request.args.get('commit', None)

  if not commit_id:
    try:
      project = Project.query.filter(Project.id==project_id).one()
      default_branch = project.information['qatools_config']['project']['reference_branch']
    except:
      default_branch = 'develop'
    branch = request.args.get('branch', default_branch)
    ci_commit = latest_successful_commit(db_session, project_id=project_id, branch=branch)
    if not ci_commit:
      return jsonify({'error': f'Sorry, we cant find any commit with results for this project on {branch}.'}), 404
  else:
    try: # we try a commit from git
      if project_id == 'dvs/psp_swip':
        repo = repos[project_id]
        commit = repo.commit(commit_id)
        ci_commit = CiCommit.query.filter(CiCommit.id.startswith(commit.hexsha)).one()
      else:
        ci_commit = (CiCommit
                     .query.filter(
                       CiCommit.project_id==project_id,
                       CiCommit.id.startswith(commit_id),
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

  # we allow searching in the commit folder for artifacts via globbing
  # it's useful to eg inspect the available configurations
  artifacts = request.args.get('artifacts', False)
  if artifacts:
    try:
      globbing = ci_commit.project.information['qatools_config']['artifacts'][artifacts]['glob']
    except: # for legacy projects...
      globbing = '*.json'
    commit_dir = ci_commit.commit_dir
    files =  [str(f.relative_to(commit_dir)) for f in commit_dir.glob(globbing)]
    return jsonify(files)

  response = make_response(ujson.dumps(ci_commit.to_dict(with_outputs=True)))
  response.headers['Content-Type'] = 'application/json'
  return response
