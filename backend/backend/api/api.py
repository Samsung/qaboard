"""
Access data related to Projects.
"""
import os
import pytz
import json
import datetime

import ujson
from flask import request, jsonify, make_response

from sqlalchemy import func, and_, asc, or_, text
from sqlalchemy.orm import selectinload

from sqlalchemy.orm.attributes import flag_modified
from sqlalchemy.sql import label

# Like the CLI: ENV > secrets > site package (e.g. qaboard-site-sirc) > default
from qaboard.compat import mappings as _path_mappings

from backend import app, db_session
from ..models import Project, CiCommit, Batch, Output, batches_stats
from ..utils import profiled
from ..config import git_server
from ..search import parse_query, commits_search_filter, escape_like
from .auth import is_authorized_user, get_current_user

to_datetime = lambda s: timezone.localize(datetime.datetime.strptime(s, '%Y-%m-%dT%H:%M:%S.%fZ'))
timezone = pytz.timezone("utc")


def _parse_json_env(key, default):
    raw = os.environ.get(key, default)
    try:
        return json.loads(raw)
    except (json.JSONDecodeError, ValueError):
        return json.loads(default)

_image_servers = _parse_json_env('QABOARD_IMAGE_SERVERS', '{"default": "/iiif/2/"}')


@app.route("/api/v1/config")
def get_site_config():
    """Return runtime site configuration for the frontend."""
    from ..git_hosts import git_hosts
    sample_rate = os.environ.get('SENTRY_TRACES_SAMPLE_RATE', '1.0')
    try:
        sample_rate = float(sample_rate)
    except (ValueError, TypeError):
        sample_rate = 1.0

    return jsonify({
        "image_servers": _image_servers,
        "login_type": os.environ.get('QABOARD_LOGIN_TYPE', 'LOCAL'),
        "login_required": bool(os.environ.get('QABOARD_LOGIN_REQUIRED', '')),
        "sentry_dsn": os.environ.get('SENTRY_DSN'),
        "posthog_api_key": os.environ.get('POSTHOG_API_KEY'),
        "posthog_host": os.environ.get('POSTHOG_HOST'),
        "path_mappings": _path_mappings,
        # The docs served by this server at /docs/ match its version. Can be e.g. https://samsung.github.io/qaboard/
        "docs_root": os.environ.get('QABOARD_DOCS_ROOT', '/'),
        "avatar_url_template": os.environ.get('QABOARD_AVATAR_URL'),
        "sentry_traces_sample_rate": sample_rate,
        # Fallback web URL for git links, when a project doesn't define project.url in qaboard.yaml
        "git_web_url": git_hosts.default.url,
        # The git hosts we know, to link to projects whose data doesn't say where they are hosted: [{type, url, name}]
        "git_hosts": git_hosts.public(),
        # Optional link to a storage quota dashboard, with {user_name} and {project} placeholders
        "quota_url_template": os.environ.get('QABOARD_QUOTA_URL_TEMPLATE'),
        # Where users report issues
        "support_url": os.environ.get('QABOARD_SUPPORT_URL', 'https://github.com/Samsung/qaboard/issues'),
    })


@app.route("/api/v1/health")
def health():
    """
    Readiness check used by docker healthchecks, the rolling deploy script and kubernetes probes.
    We only check the database: without it nothing works. Redis is a cache, we work without it.
    """
    try:
        db_session.execute(text("SELECT 1"))
    except Exception as e:
        return jsonify({"status": "error", "database": str(e)}), 503
    return jsonify({"status": "ok"})


# Without ?limit=, we answer with at most this many commits
max_commits = 1000


def int_arg(name, default=None, min_value=0, max_value=None):
  """An integer from the query string, or ValueError"""
  value = request.args.get(name)
  if value is None or value == '':
    return default
  value = int(value)
  if value < min_value:
    raise ValueError(f"{name} must be >= {min_value}")
  return min(value, max_value) if max_value is not None else value


@app.route("/api/v1/commits")
@app.route("/api/v1/commits/")
@app.route("/api/v1/commits/<path:branch>")
def get_commits(branch=None):
  """
  The commits with results of a project, newest first, as a list.
  - By default, those in the date range ?from=&to=, or the last days with commits.
  - Only a branch's: /api/v1/commits/<branch>, or a committer's: ?committer=
  - ?q=: search the whole history, see backend/search.py. The date range applies only if from/to are given.
  - Pages: ?limit=&offset=. The X-Has-More header says if there are more.
  - ?metrics={"name": target}: aggregate those metrics over each batch's outputs
  - ?with_outputs=true: include the batches' outputs. ?batch=label or ?only_ci_batches=true: only those batches.
  """
  project_id = request.args['project']

  if not is_authorized_user(None, project_id):
    return f"Forbidden: You don't have permission to access this project", 403

  try:
    limit = int_arg('limit', min_value=1, max_value=max_commits)
    # bigger offsets would overflow postgres' bigint
    offset = int_arg('offset', default=0, max_value=10**12)
  except ValueError as e:
    return jsonify({"error": f"Invalid pagination: {e}"}), 400
  search_terms = parse_query(request.args.get('q', ''))

  if branch:
    branch = branch.replace('origin/', '')
  committer_name = request.args.get('committer', None)
  def in_scope(query):
    query = query.filter(CiCommit.project_id == project_id)
    if branch:
      query = query.filter(CiCommit.branch.in_([branch, f'origin/{branch}']))
    if committer_name:
      query = query.filter(CiCommit.committer_name == committer_name)
    return query

  to_date_s = request.args.get('to', None)
  from_date_s = request.args.get('from', None)
  now_localized = timezone.localize(datetime.datetime.now())
  # We only care about days, and this makes sure we smooth out TZ issues
  # It's likely unnecessary...
  to_date = (to_datetime(to_date_s) if to_date_s else now_localized) + datetime.timedelta(hours=3)
  if search_terms:
    # Searches look at the whole history, unless asked otherwise
    from_date = to_datetime(from_date_s) - datetime.timedelta(hours=3) if from_date_s else None
    to_date = to_date if to_date_s else None
  else:
    from_date = to_datetime(from_date_s) if from_date_s else (now_localized - datetime.timedelta(days=4))
    latest_authored_datetime = in_scope(db_session.query(func.max(CiCommit.authored_datetime))).scalar()
    if not latest_authored_datetime:
      return commits_response([], has_more=False if limit else None)
    # If there are no recent commits, we show the latest ones
    from_date = min(latest_authored_datetime - (to_date - from_date), from_date)
    from_date = from_date - datetime.timedelta(hours=3) # timezones as above

  with_batches = None
  batch = request.args.get('batch', None)
  if batch:
    with_batches = [batch]
  else:
    only_ci_batches = False if request.args.get('only_ci_batches', 'false')=='false' else True
    if only_ci_batches:
      with_batches = ['default']

  with_outputs = False if request.args.get('with_outputs', 'false')=='false' else True
  ci_commits = db_session.query(CiCommit)
  # We only load the batches we show
  batches = CiCommit.batches.and_(Batch.label.in_(with_batches)) if with_batches else CiCommit.batches
  if with_outputs:
    ci_commits = ci_commits.options(selectinload(batches).selectinload(Batch.outputs))
  else:
    ci_commits = ci_commits.options(selectinload(batches))
  ci_commits = (in_scope(ci_commits)
    # only commits with results
    .filter(CiCommit.batches.any())
    # the id makes pages stable when commits have the same date
    .order_by(CiCommit.authored_datetime.desc(), CiCommit.id.desc())
  )
  if from_date:
    ci_commits = ci_commits.filter(CiCommit.authored_datetime >= from_date)
  if to_date:
    ci_commits = ci_commits.filter(CiCommit.authored_datetime <= to_date)
  if search_terms:
    ci_commits = ci_commits.filter(commits_search_filter(search_terms))
  # one more to know if there are more
  ci_commits = ci_commits.offset(offset).limit(limit + 1 if limit else max_commits)

  metrics_to_aggregate = json.loads(request.args.get('metrics', '{}'))
  if project_id.startswith("CDE-Users/HW_ALG") or project_id.startswith("aqua/"): # too many results to be fast...
    metrics_to_aggregate = {}

  commits = ci_commits.all()
  has_more = len(commits) > limit if limit else None
  commits = commits[:limit] if limit else commits
  batch_ids = [b.id for c in commits for b in c.batches]
  # One query for the counts of outputs and aggregated metrics of all batches
  stats = batches_stats(db_session, batch_ids, metrics_to_aggregate)
  cache = {}
  serializable_commits = [c.to_dict(
      db_session,
      with_aggregation=metrics_to_aggregate,
      with_batches=with_batches,
      with_outputs=with_outputs,
      batch_stats=stats,
      cache=cache,
    )
    for c in commits
  ]
  return commits_response(serializable_commits, has_more)


def commits_response(commits, has_more=None):
  response = make_response(ujson.dumps(commits))
  response.headers['Content-Type'] = 'application/json'
  if has_more is not None:
    response.headers['X-Has-More'] = 'true' if has_more else 'false'
    response.headers['Access-Control-Expose-Headers'] = 'X-Has-More'
  return response


@app.route("/api/v1/project/branches")
def get_branches():
  """
  Returns a list of that project's branches, by default all of them sorted by name.
  With ?q= (only branches containing that text) or ?limit=, the most recently active branches come first.
  """
  project_id = request.args.get('project')
  if not is_authorized_user(None, project_id):
    return f"Forbidden: You don't have permission to access this project", 403

  search = request.args.get('q')
  try:
    limit = int_arg('limit', min_value=1, max_value=max_commits)
  except ValueError as e:
    return jsonify({"error": f"Invalid limit: {e}"}), 400

  if search is None and limit is None:
    branches = (db_session
                .query(CiCommit.branch)
                .filter(CiCommit.project_id==project_id)
                .distinct()
                .order_by(CiCommit.branch)
               )
    # Commits from clients that don't know their branch have none
    return jsonify([b[0] for b in branches.yield_per(1000) if b[0]])

  name = func.regexp_replace(CiCommit.branch, '^origin/', '')
  latest = func.max(CiCommit.authored_datetime)
  branches = (db_session
              .query(name, latest)
              .filter(CiCommit.project_id==project_id, CiCommit.branch.isnot(None))
             )
  if search:
    # what we show: names without origin/
    branches = branches.filter(name.ilike(f'%{escape_like(search)}%', escape='\\'))
  branches = branches.group_by(name).order_by(latest.desc().nulls_last(), name).limit(limit or 50)
  return jsonify([b for b, _ in branches])



# What lists of projects need from Project.data.git (often a whole GitLab/GitHub webhook payload)
summary_git_keys = ('name', 'description', 'web_url', 'html_url', 'avatar_url', 'path_with_namespace', 'full_name', 'default_branch', 'hosting_type', 'host')


@app.route("/api/v1/projects")
def get_projects():
  """
  The projects with commits, with their latest commit date and number of commits.
  With ?summary=true, we only give what lists of projects need from their data (git info, qaboard.yaml's project section):
  it's much smaller. Use /api/v1/project for the rest.
  """
  summary = request.args.get('summary', 'false') != 'false'
  commits = (db_session
             .query(
               CiCommit.project_id,
               label('latest_commit_datetime', func.max(CiCommit.authored_datetime)),
               label('total_commits', func.count()),
             )
             .group_by(CiCommit.project_id)
             .subquery()
            )
  if summary:
    data_columns = [Project.data['git'], Project.data['qatools_config']['project'], Project.data['legacy'], Project.data['latest_output_datetime']]
  else:
    data_columns = [Project.data]
  projects = (db_session
              .query(
                Project.id,
                Project.latest_output_datetime,
                commits.c.latest_commit_datetime,
                commits.c.total_commits,
                *data_columns,
              )
              .join(commits, commits.c.project_id == Project.id)
              .order_by(asc(func.lower(Project.id)))
             )
  user_info = get_current_user(to_jsonify=False)
  response = {}
  for project_id, latest_output_datetime, latest_commit_datetime, total_commits, *data in projects.yield_per(1000):
    if not is_authorized_user(user_info, project_id):
      continue

    if summary:
      git, qatools_config_project, legacy, data_latest_output_datetime = data
      data = {}
      if git is not None:
        data['git'] = {k: git[k] for k in summary_git_keys if k in git}
      if qatools_config_project is not None:
        data['qatools_config'] = {'project': qatools_config_project}
      if legacy is not None:
        data['legacy'] = legacy
      if data_latest_output_datetime is not None:
        data['latest_output_datetime'] = data_latest_output_datetime
    else:
      data = data[0]
      if "qatools_metrics" in data:
        del data['qatools_metrics']
      if "qatools_config" in data:
        data['qatools_config'] = {"project": data['qatools_config'].get("project", {})}
    response[project_id] = {
      'data': data,
      'latest_output_datetime': latest_output_datetime.isoformat() if latest_output_datetime else None, # isoformat not necessary?
      'latest_commit_datetime': latest_commit_datetime.isoformat(),
      'total_commits': total_commits,
    }
  response = make_response(ujson.dumps(response))
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

  if not is_authorized_user(None, project_id): 
    return f"Forbidden: You don't have permission to access this project", 403

  return jsonify(project.data)



