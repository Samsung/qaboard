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

from sqlalchemy import func, and_, asc
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
    if project_id == 'dvs/psp_swip' and not request.args.get('only_when_first_pushed_as', False):
      print(f'filtering by branch [{branch}] using git', file=sys.stderr)
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
      ci_commits = ci_commits.filter(CiCommit.id.in_(commit_ids))
    else:
      print(f'filtering by branch [{branch}] using SQL', file=sys.stderr)
      ci_commits = ci_commits.filter(CiCommit.branch == branch)

  metrics_to_aggregate = json.loads(request.args.get('metrics', '{}'))
  only_ci_batches = False if request.args.get('only_ci_batches', 'false')=='false' else True
  with_batches = ['default', 'ci-android-rt', 'manual-android-rt'] if only_ci_batches else None
  with_outputs = False if request.args.get('with_outputs', 'false')=='false' else True
  # from ..utils import profiled
  # with profiled():
  serializable_commits = [c.to_dict(with_aggregation=metrics_to_aggregate, with_batches=with_batches, with_outputs=with_outputs)
                          for c in ci_commits]
  response = make_response(ujson.dumps(serializable_commits))
  response.headers['Content-Type'] = 'application/json'
  return response

@app.route("/api/v1/project/branches")
def list_branches():
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
      return jsonify({'error': 'Sorry, we cant find any commit with results for this project.'}), 404
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
  response = make_response(ujson.dumps(ci_commit.to_dict(with_outputs=True)))
  response.headers['Content-Type'] = 'application/json'
  return response
