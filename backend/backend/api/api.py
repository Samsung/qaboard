"""
Access data related to Projects.
"""
import os
import re
import pytz
import json
import datetime

import ujson
from flask import request, jsonify, make_response, g

from sqlalchemy import func, and_, asc, text
from sqlalchemy.orm import selectinload

from sqlalchemy.sql import label

# Like the CLI: ENV > secrets > site package (e.g. qaboard-site-sirc) > default
from qaboard.compat import mappings as _path_mappings
from qaboard.sentry_utils import traces_sample_rate

from backend import app, db_session
from ..models import Project, CiCommit, Batch, Output, ProjectView, batches_stats
from ..config import skip_metrics_aggregation
from ..search import parse_query, commits_search_filter, escape_like
from ..metrics_aggregation import parse_metrics_arg
from .auth import is_authorized_user, get_current_user, forbidden_project
from ..mine import identity_of, commit_is_mine, batch_is_mine, batch_is_not_mine, batch_origin_in, parse_origins, SCOPES, BATCH_SCOPES
from ..notifications.mail import email_enabled
from ..settings import setting, sandbox_html

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
    return jsonify({
        "image_servers": _image_servers,
        "login_type": os.environ.get('QABOARD_LOGIN_TYPE', 'LOCAL'),
        # login_required: the name before settings were also stored in the database
        "login_required": setting('auth.require_sign_in'),
        "require_sign_in": setting('auth.require_sign_in'),
        "local_signup": setting('auth.local_signup'),
        # how `qa` authenticates the results it sends: off, warn or token
        "ingest_auth": setting('ingest.auth'),
        # what the web app offers when users create tokens
        "tokens": {"default_lifetime_days": setting('tokens.default_lifetime_days'), "max_lifetime_days": setting('tokens.max_lifetime_days')},
        # The web app can report to its own Sentry project (where its source maps are uploaded)
        "sentry_dsn": os.environ.get('SENTRY_FRONTEND_DSN') or os.environ.get('SENTRY_DSN'),
        "sentry_environment": os.environ.get('SENTRY_ENVIRONMENT') or 'production',
        "sentry_traces_sample_rate": traces_sample_rate(0.2),
        # "stream" sends spans as they end: it needs a recent Sentry server
        "sentry_trace_lifecycle": os.environ.get('SENTRY_FRONTEND_TRACE_LIFECYCLE') or 'static',
        "posthog_api_key": os.environ.get('POSTHOG_API_KEY'),
        "posthog_host": os.environ.get('POSTHOG_HOST'),
        "path_mappings": _path_mappings,
        # The docs served by this server at /docs/ match its version. Can be e.g. https://samsung.github.io/qaboard/
        "docs_root": os.environ.get('QABOARD_DOCS_ROOT', '/'),
        "avatar_url_template": os.environ.get('QABOARD_AVATAR_URL'),
        # Fallback web URL for git links, when a project doesn't define project.url in qaboard.yaml
        "git_web_url": git_hosts.default.url,
        # The git hosts we know, to link to projects whose data doesn't say where they are hosted: [{type, url, name}]
        "git_hosts": git_hosts.public(),
        # Where users report issues
        "support_url": os.environ.get('QABOARD_SUPPORT_URL', 'https://github.com/Samsung/qaboard/issues'),
        # Shown to users who can't log in, e.g. which credentials to use
        "login_hint": os.environ.get('QABOARD_LOGIN_HINT'),
        # Where users install WebCDE, which opens runs whose outputs have a cde.sh
        "webcde_installer": os.environ.get('QABOARD_WEBCDE_INSTALLER'),
        # Users can ask for an email when the batches they start end
        "email_notifications": email_enabled(),
        # The runs' HTML runs apart from the app (its scripts in an origin of their own): see website/docs/viewers.mdx
        "sandbox_html": sandbox_html(),
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
  - ?scope=mine: only the commits I wrote or have batches in (backend/mine.py). ?origin=webapp,local: only commits
    with batches from there, and only those batches.
  """
  project_id = request.args['project']

  if not is_authorized_user(None, project_id):
    return forbidden_project(project_id)

  try:
    limit = int_arg('limit', min_value=1, max_value=max_commits)
    # bigger offsets would overflow postgres' bigint
    offset = int_arg('offset', default=0, max_value=10**12)
  except ValueError as e:
    return jsonify({"error": f"Invalid pagination: {e}"}), 400
  try:
    metrics_to_aggregate = parse_metrics_arg(request.args.get('metrics'))
  except ValueError as e:
    return jsonify({"error": f"{e}"}), 400
  search_terms = parse_query(request.args.get('q', ''))
  try:
    identity, origins = scope_and_origins()
  except ValueError as e:
    return jsonify({"error": f"{e}"}), 400
  except PermissionError as e:
    return jsonify({"error": f"{e}", "reason": "sign_in_required"}), 401

  if branch:
    branch = branch.replace('origin/', '')
  committer_name = request.args.get('committer', None)
  def in_scope(query):
    query = query.filter(CiCommit.project_id == project_id)
    if branch:
      query = query.filter(CiCommit.branch.in_([branch, f'origin/{branch}']))
    if committer_name:
      query = query.filter(CiCommit.committer_name == committer_name)
    if identity:
      query = query.filter(commit_is_mine(identity))
    if origins:
      query = query.filter(CiCommit.batches.any(batch_origin_in(origins)))
    return query

  to_date_s = request.args.get('to', None)
  from_date_s = request.args.get('from', None)
  try:
    from_date_arg = to_datetime(from_date_s) if from_date_s else None
    to_date_arg = to_datetime(to_date_s) if to_date_s else None
  except ValueError as e:
    return jsonify({"error": f"Invalid date range, use e.g. 2026-09-01T00:00:00.000Z: {e}"}), 400
  # in UTC, like the dates: the server's time zone doesn't matter
  now = datetime.datetime.now(datetime.timezone.utc)
  # We only care about days, and this makes sure we smooth out TZ issues
  # It's likely unnecessary...
  to_date = (to_date_arg or now) + datetime.timedelta(hours=3)
  if search_terms:
    # Searches look at the whole history, unless asked otherwise
    from_date = from_date_arg - datetime.timedelta(hours=3) if from_date_arg else None
    to_date = to_date if to_date_arg else None
  else:
    from_date = from_date_arg or (now - datetime.timedelta(days=4))
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
  if origins:
    batches = batches.and_(batch_origin_in(origins))
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

  # QABOARD_SKIP_METRICS_AGGREGATION: projects with too many runs for it to be fast
  if project_id.startswith(skip_metrics_aggregation):
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


def scope_and_origins(scopes=SCOPES):
  """?scope=mine|all and ?origin=webapp,local,ci: (identity or None, origins or None). Raises ValueError for bad values."""
  scope = request.args.get('scope') or 'all'
  if scope not in scopes:
    raise ValueError(f"Unknown scope {scope!r}: use {' or '.join(scopes)}")
  origins = parse_origins(request.args.get('origin'))
  identity = None
  if scope in ('mine', 'others'):
    identity = identity_of(g.actor.user)
    if identity is None:
      raise PermissionError("Sign in to see your commits and batches.")
  return identity, origins


@app.route("/api/v1/commit-counts")
@app.route("/api/v1/commit-counts/")
def get_commits_counts():
  """
  How many commits with results the lists would show, for each scope: {"all", "mine", "without_ci"}.
  `mine` is null for anonymous users. Same parameters as /api/v1/commits: project, branch, committer, from, to
  (by default the last 30 days: counts are never over the whole history).
  """
  project_id = request.args['project']
  if not is_authorized_user(None, project_id):
    return forbidden_project(project_id)
  try:
    now = timezone.localize(datetime.datetime.now())
    to_date = (to_datetime(request.args['to']) if request.args.get('to') else now) + datetime.timedelta(hours=3)
    from_date = (to_datetime(request.args['from']) if request.args.get('from') else now - datetime.timedelta(days=30)) - datetime.timedelta(hours=3)
  except ValueError as e:
    return jsonify({"error": f"Invalid dates: {e}"}), 400
  query = db_session.query(CiCommit.id).filter(CiCommit.project_id == project_id, CiCommit.batches.any())
  branch = (request.args.get('branch') or '').replace('origin/', '')
  if branch:
    query = query.filter(CiCommit.branch.in_([branch, f'origin/{branch}']))
  if request.args.get('committer'):
    query = query.filter(CiCommit.committer_name == request.args['committer'])
  query = query.filter(CiCommit.authored_datetime >= from_date, CiCommit.authored_datetime <= to_date)
  identity = identity_of(g.actor.user)
  return jsonify({
    "all": query.count(),
    "mine": query.filter(commit_is_mine(identity)).count() if identity else None,
    "without_ci": query.filter(CiCommit.batches.any(batch_origin_in(['webapp', 'local']))).count(),
  })


@app.route("/api/v1/batches")
@app.route("/api/v1/batches/")
def get_batches():
  """
  Batches, the latest first (by their latest run), with their commit: what users ran, rather than commits.
  - ?project=: a project's, ?projects=a,b,c: those of several (we skip those the user can't read),
    else in every project the user can read (then ?scope=mine is required).
  - ?scope=mine|others|all, ?origin=webapp,local,ci (backend/mine.py), ?branch=
  - ?status=pending: with runs that wait or run, failed: with failed runs. ?since_days=7: with runs in the last days.
  - ?metrics={"name": target}: aggregate those metrics over each batch's runs, like /api/v1/commits.
    ?metrics=default: each project's default metric (qaboard.yaml), its name is the batch's `default_metric`,
    its definition `default_metric_info` (label, unit...): lists across projects don't fetch each project
  - Pages: ?limit= (default 50) &offset=. The X-Has-More header says if there are more.
  """
  project_id = request.args.get('project')
  if project_id and not is_authorized_user(None, project_id):
    return forbidden_project(project_id)
  project_ids = [p.strip() for p in (request.args.get('projects') or '').split(',') if p.strip()]
  try:
    if project_id and project_ids:
      raise ValueError("Give either ?project= or ?projects=")
    if len(project_ids) > 200:
      raise ValueError("Ask for at most 200 projects")
    identity, origins = scope_and_origins(BATCH_SCOPES)
    limit = int_arg('limit', default=50, min_value=1, max_value=200)
    # lists are scrolled, not paged: deep offsets would only be slow
    offset = int_arg('offset', default=0, max_value=10000)
    since_days = int_arg('since_days', min_value=1, max_value=3650)
    status = request.args.get('status') or None
    if status not in (None, 'pending', 'failed'):
      raise ValueError(f"Unknown status {status!r}: use pending or failed")
    default_metrics = request.args.get('metrics') == 'default'
    metrics_to_aggregate = {} if default_metrics else json.loads(request.args.get('metrics', '{}'))
  except PermissionError as e:
    return jsonify({"error": f"{e}", "reason": "sign_in_required"}), 401
  except ValueError as e:  # also bad JSON
    return jsonify({"error": f"{e}"}), 400
  if not project_id and not project_ids and not (identity and request.args.get('scope') == 'mine'):
    return jsonify({"error": "Give a ?project=, or ask for your batches with ?scope=mine"}), 400
  if any(p.startswith(skip_metrics_aggregation) for p in ([project_id] if project_id else project_ids)):
    metrics_to_aggregate, default_metrics = {}, False
  if status:
    # they look at the batches' runs: only recent batches (by default the last 30 days, at most 90)
    since_days = min(since_days or 30, 90)
  if project_ids:
    project_ids = [p for p in dict.fromkeys(project_ids) if is_authorized_user(None, p)]
    if not project_ids:
      return batches_response([], has_more=False)

  query = (db_session.query(Batch)
           .join(CiCommit, Batch.ci_commit_id == CiCommit.id)
           .options(selectinload(Batch.ci_commit))
          )
  if project_id:
    query = query.filter(CiCommit.project_id == project_id)
  if project_ids:
    query = query.filter(CiCommit.project_id.in_(project_ids))
  if identity:
    query = query.filter(batch_is_not_mine(identity) if request.args.get('scope') == 'others' else batch_is_mine(identity))
  if origins:
    query = query.filter(batch_origin_in(origins))
  branch = (request.args.get('branch') or '').replace('origin/', '')
  if branch:
    query = query.filter(CiCommit.branch.in_([branch, f'origin/{branch}']))
  if since_days:
    # naive UTC, like the batches' dates
    query = query.filter(Batch.latest_output_datetime >= datetime.datetime.utcnow() - datetime.timedelta(days=since_days))
  if status == 'pending':
    query = query.filter(Batch.outputs.any(Output.is_pending == True))  # noqa: E712
  elif status == 'failed':
    query = query.filter(Batch.outputs.any(and_(Output.is_failed == True, Output.deleted.isnot(True))))  # noqa: E712
  query = query.order_by(Batch.latest_output_datetime.desc().nulls_last(), Batch.id.desc())

  if project_id or project_ids:
    batches = query.offset(offset).limit(limit + 1).all()
    has_more = len(batches) > limit
  else:
    # Across projects, we skip those the user can't read anymore (their own batches: there aren't many)
    readable = {}
    def can_read(project):
      if project not in readable:
        readable[project] = is_authorized_user(None, project)
      return readable[project]
    batches, read, chunk, exhausted = [], 0, offset + limit + 1, False
    for _ in range(10):  # users who lost access to many projects get shorter pages rather than slow ones
      page = query.offset(read).limit(chunk).all()
      read += len(page)
      batches.extend(b for b in page if can_read(b.ci_commit.project_id))
      exhausted = len(page) < chunk
      if exhausted or len(batches) > offset + limit:
        break
    batches = batches[offset:]
    # we may have stopped before the end
    has_more = len(batches) > limit or not exhausted
  batches = batches[:limit]

  from ..models.Batch import no_stats
  default_metric = {}
  if default_metrics:
    # one aggregation per default metric: projects often share theirs
    projects = {b.ci_commit.project_id for b in batches if not b.ci_commit.project_id.startswith(skip_metrics_aggregation)}
    metrics = Project.data['qatools_metrics']
    rows = (db_session
            .query(Project.id, metrics['default_metric'].astext, metrics['available_metrics'])
            .filter(Project.id.in_(projects))) if projects else []
    names, definitions = {}, {}
    for id, name, available in rows:
      names[id] = name
      # how to show it: its label, unit, scale...
      definitions[id] = (available or {}).get(name) if name and isinstance(available, dict) else None
    default_metric = {b.id: names[b.ci_commit.project_id] for b in batches if names.get(b.ci_commit.project_id)}
    stats = {}
    for name in set(default_metric.values()):
      stats.update(batches_stats(db_session, [id for id, n in default_metric.items() if n == name], {name: 0}))
    stats.update(batches_stats(db_session, [b.id for b in batches if b.id not in default_metric]))
  else:
    stats = batches_stats(db_session, [b.id for b in batches], metrics_to_aggregate)
  def serialize(batch):
    commit = batch.ci_commit
    return {
      **batch.to_dict(db_session, with_aggregation=metrics_to_aggregate, stats=stats.get(batch.id, no_stats)),
      'project': commit.project_id,
      'commit': {
        'id': commit.hexsha,
        'branch': re.sub('^origin/', '', commit.branch) if commit.branch else '',
        'message': commit.message,
        'committer_name': commit.committer_name,
        'authored_datetime': commit.authored_datetime.isoformat() if commit.authored_datetime else None,
      },
      **({
        'default_metric': default_metric.get(batch.id),
        'default_metric_info': definitions.get(commit.project_id) if batch.id in default_metric else None,
      } if default_metrics else {}),
    }
  return batches_response([serialize(b) for b in batches], has_more)


def batches_response(batches, has_more):
  response = make_response(ujson.dumps(batches))
  response.headers['Content-Type'] = 'application/json'
  response.headers['X-Has-More'] = 'true' if has_more else 'false'
  response.headers['Access-Control-Expose-Headers'] = 'X-Has-More'
  return response


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
    return forbidden_project(project_id)

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


activity_days = 30
quiet_after_days = 90
human_origins = ('webapp', 'local')


# Everyone's part of projects_usage, for a minute: every Explore and home page load asks for it
_usage_cache = {'at': None, 'value': None}
usage_cache_seconds = 60


def global_usage():
  """{project: (latest human activity, batches per day, viewers)}, the same for every user"""
  now = datetime.datetime.utcnow()
  if _usage_cache['at'] and (now - _usage_cache['at']).total_seconds() < usage_cache_seconds:
    return _usage_cache['value']
  # batches' dates are naive UTC (api/outputs.py)
  first_day = (now - datetime.timedelta(days=activity_days - 1)).date()
  # Only what quiet projects need: the index finds the recent batches, whatever the size of the history
  human = dict(db_session
               .query(CiCommit.project_id, func.max(Batch.latest_output_datetime))
               .join(Batch, Batch.ci_commit_id == CiCommit.id)
               .filter(Batch.origin.in_(human_origins), Batch.latest_output_datetime >= now - datetime.timedelta(days=quiet_after_days))
               .group_by(CiCommit.project_id))
  day = func.date(Batch.latest_output_datetime)
  activity = {}
  for project_id, batch_day, count in (db_session
                                       .query(CiCommit.project_id, day, func.count())
                                       .join(Batch, Batch.ci_commit_id == CiCommit.id)
                                       .filter(Batch.latest_output_datetime >= first_day)
                                       .group_by(CiCommit.project_id, day)):
    index = (batch_day - first_day).days
    if 0 <= index < activity_days:
      activity.setdefault(project_id, [0] * activity_days)[index] = count
  views = dict(db_session
               .query(ProjectView.project_id, func.count(func.distinct(ProjectView.user_id)))
               .filter(ProjectView.last_viewed_at >= now - datetime.timedelta(days=quiet_after_days))
               .group_by(ProjectView.project_id))
  value = (human, activity, views)
  _usage_cache.update(at=now, value=value)
  return value


def projects_usage(user_id=None, identity=None):
  """For each project: its human activity, its batches per day, its viewers, and mine (see get_projects)"""
  now = datetime.datetime.utcnow()
  human, activity, views = global_usage()
  my_views = dict(db_session
                  .query(ProjectView.project_id, ProjectView.last_viewed_at)
                  .filter(ProjectView.user_id == user_id)) if user_id is not None else {}
  # my latest batch, or commit (both indexed by user, by email)
  mine = {}
  if identity is not None:
    since = now - datetime.timedelta(days=quiet_after_days)
    my_batches = (db_session
                  .query(CiCommit.project_id, func.max(Batch.latest_output_datetime))
                  .join(Batch, Batch.ci_commit_id == CiCommit.id)
                  .filter(batch_is_mine(identity), Batch.latest_output_datetime >= since)
                  .group_by(CiCommit.project_id))
    my_commits = (db_session
                  .query(CiCommit.project_id, func.max(CiCommit.authored_datetime))
                  .filter(CiCommit.author_email.in_(sorted(identity.emails)), CiCommit.authored_datetime >= since)
                  .group_by(CiCommit.project_id)) if identity.emails else []
    for project_id, date in [*my_batches, *my_commits]:
      # commits' dates are aware, batches' naive UTC
      date = date.astimezone(datetime.timezone.utc).replace(tzinfo=None) if date and date.tzinfo else date
      if date and (project_id not in mine or date > mine[project_id]):
        mine[project_id] = date
  def iso(date):
    return date.isoformat() if date else None
  return lambda project_id: {
    'latest_human_activity': iso(human.get(project_id)),
    'activity': activity.get(project_id),
    'views_90d': views.get(project_id, 0),
    'my_last_view': iso(my_views.get(project_id)),
    **({'my_latest_activity': iso(mine.get(project_id))} if identity is not None else {}),
  }

@app.route("/api/v1/projects")
def get_projects():
  """
  The projects with commits, with their latest commit date and number of commits.
  With ?summary=true, we only give what lists of projects need from their data (git info, qaboard.yaml's project section):
  it's much smaller. Use /api/v1/project for the rest.

  Explore also needs to know which projects people use (webapp/src/explore/):
  - latest_human_activity: when a batch from the web app or someone's terminal last got a run in the last 90 days
    (the CI's don't count), else null,
  - activity: how many batches got runs on each of the last 30 days (UTC), oldest first. null without any,
  - views_90d: how many users viewed it in the last 90 days, my_last_view: when I did (signed-in users).
  - my_latest_activity: my latest batch or commit in the last 90 days, the home page's "Your projects" (signed-in users).
  One grouped query each: sites have hundreds of projects.
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
  signed_in = user_info.get('is_authenticated')
  usage = projects_usage(user_info.get('user_id') if signed_in else None, identity_of(g.actor.user) if signed_in else None)
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
      data.pop('milestones', None)
      if "qatools_metrics" in data:
        del data['qatools_metrics']
      if "qatools_config" in data:
        data['qatools_config'] = {"project": data['qatools_config'].get("project", {})}
    response[project_id] = {
      'data': data,
      'latest_output_datetime': latest_output_datetime.isoformat() if latest_output_datetime else None, # isoformat not necessary?
      'latest_commit_datetime': latest_commit_datetime.isoformat(),
      'total_commits': total_commits,
      **usage(project_id),
    }
  response = make_response(ujson.dumps(response))
  response.headers['Content-Type'] = 'application/json'
  return response


@app.route("/api/v1/project")
def get_project():
  project_id = request.args['project']
  if not is_authorized_user(None, project_id):
    return forbidden_project(project_id)
  project = Project.query.filter(Project.id == project_id).one_or_none()
  if project is None:
    return jsonify({"error": f"There is no project {project_id}."}), 404

  # Milestones from older versions, kept for rollbacks: they are in their own table, see /api/v1/milestones
  return jsonify({k: v for k, v in project.data.items() if k != 'milestones'})


# Views are counted at most once an hour per user and project: enough to tell projects people look at
view_throttle = datetime.timedelta(hours=1)

@app.route("/api/v1/project/view", methods=['POST'])
def post_project_view():
  """Signed-in users opened a project page (Explore, "recently viewed"). Signed-out visitors aren't counted."""
  body = request.get_json(silent=True) or {}
  project_id = body.get('project')
  if not isinstance(project_id, str) or not project_id:
    return jsonify({"error": "Which project? Send {\"project\": <id>}."}), 400
  user_info = get_current_user(to_jsonify=False)
  if not user_info.get('is_authenticated') or user_info.get('kind') == 'service':
    return '', 204
  if not is_authorized_user(user_info, project_id):
    return forbidden_project(project_id)
  if db_session.get(Project, project_id) is None:
    return jsonify({"error": f"There is no project {project_id}."}), 404

  from sqlalchemy.dialects.postgresql import insert
  now = datetime.datetime.utcnow()
  upsert = insert(ProjectView).values(user_id=user_info['user_id'], project_id=project_id, last_viewed_at=now, views=1)
  db_session.execute(upsert.on_conflict_do_update(
    constraint='uq_project_views_user_project',
    set_={'last_viewed_at': now, 'views': ProjectView.views + 1},
    where=ProjectView.last_viewed_at < now - view_throttle,
  ))
  db_session.commit()
  return '', 204



