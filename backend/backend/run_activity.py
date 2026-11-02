"""
What runs now and what ran recently ("Activity" in the web app), for users and admins: runs waiting in a queue,
running, and those that ended in the last hours or days, grouped by project, commit, batch, user, `qa batch`
command, runner, queue, platform or any job option. Also the batches started from QA-Board that will start soon.

It stays fast on big databases by reading only:
- the pending runs (is_pending): ix_outputs_active, a partial index,
- the runs that ended recently: ix_outputs_finished_at,
- the runs created recently that don't say when they ended: the index on created_date,
- the batches started from QA-Board: ix_batches_submissions.
Runs saved before QA-Board recorded when runs are queued, start and end (and runs from clients that never say) only
have their created_date: they started then, and ended `compute_time` seconds later (what `qa run` measures, in
their metrics), or then if they don't say (`estimated`). The history shows them without rewriting the outputs table.
We don't know how long they waited in a queue.

Nothing here depends on the web framework: api/activity.py is a thin layer over these functions.
"""
import datetime
from typing import Dict, List, Optional

from sqlalchemy import text

from .database import db_session


def utcnow():
  return datetime.datetime.utcnow()


def iso(date):
  return f"{date.isoformat()}Z" if date else None


hour = datetime.timedelta(hours=1)
minute = datetime.timedelta(minutes=1)
# how far back we show ended runs, and the timeline's bars
WINDOWS = {
  '1h': (hour, 5 * minute),
  '6h': (6 * hour, 15 * minute),
  '24h': (24 * hour, hour),
  '3d': (72 * hour, 3 * hour),
  '7d': (168 * hour, 6 * hour),
}
DEFAULT_WINDOW = '24h'

STATUSES = ('waiting', 'running', 'done', 'failed')
STATUS_FILTERS = {
  'all': STATUSES,
  'active': ('waiting', 'running'),
  'ended': ('done', 'failed'),
  **{status: (status,) for status in STATUSES},
}
# Pending for longer: maybe stuck, e.g. LSF killed the job before it could say so
LONG = datetime.timedelta(days=1)
# Batches started from QA-Board whose `qa batch` didn't start after this long probably never will
SUBMISSIONS_MAX_AGE = datetime.timedelta(days=3)

# A run that says it's running but isn't pending anymore ended: Batch.stop() used to leave them so
STATUS = "CASE WHEN o.is_pending AND o.is_running THEN 'running' WHEN o.is_pending THEN 'waiting' WHEN o.is_failed THEN 'failed' ELSE 'done' END"
# since when it's pending, or when it was
SINCE = "coalesce(r.started_at, r.queued_at, r.created_date)"

# How runs are grouped: the expression on outputs `o`, batches `b` and commits `c`, and its column in RUNS `r`
GROUPS = {
  'project': ("c.project_id", "project_id"),
  'commit': ("c.id", "ci_commit_id"),
  'batch': ("b.id", "batch_id"),
  'user': ("coalesce(o.data->>'user', '')", "user_name"),
  'command': ("coalesce(o.data->>'root_command_id', '')", "command_id"),
  'runner': ("coalesce(o.data->'job_options'->>'type', '')", "runner"),
  'queue': ("coalesce(o.data->'job_options'->>'queue', '')", "queue"),
  'platform': ("coalesce(o.platform, '')", "platform"),
  # any job option, e.g. LSF's project or memory: `option`
  'option': ("coalesce(o.data->'job_options'->>:option, '')", "job_option"),
  'status': (STATUS, "status"),
}
INTEGER_GROUPS = ('commit', 'batch')

# How long `qa run` says the run computed: a number of seconds in its metrics (JSON), within reason
COMPUTE_TIME = """CASE WHEN json_typeof(metrics->'compute_time') = 'number'
  THEN least(greatest((metrics->>'compute_time')::numeric, 0), 31536000)::float END"""

RUNS = """
  SELECT o.id, o.batch_id, b.label AS batch_label, c.id AS ci_commit_id, c.hexsha, c.branch, c.project_id,
         """ + STATUS + """ AS status, o.created_date, o.queued_at,
         coalesce(o.started_at, CASE WHEN o.compute_time IS NOT NULL THEN o.created_date END) AS started_at,
         CASE WHEN o.is_pending THEN NULL
              ELSE coalesce(o.finished_at, o.created_date + o.compute_time * interval '1 second', o.created_date) END AS finished_at,
         o.finished_at IS NULL AND o.is_pending IS NOT TRUE AS estimated, o.test_input_id,
         coalesce(o.platform, '') AS platform,
         coalesce(o.data->>'user', '') AS user_name,
         coalesce(o.data->>'root_command_id', '') AS command_id,
         coalesce(o.data->'job_options'->>'type', '') AS runner,
         coalesce(o.data->'job_options'->>'queue', '') AS queue,
         {option} AS job_option
  FROM (
    SELECT outputs.*, NULL::float AS compute_time FROM outputs WHERE is_pending
    UNION ALL
    SELECT outputs.*, NULL::float FROM outputs WHERE finished_at >= :since AND is_pending IS NOT TRUE
    UNION ALL
    -- older runs: they may have started before the window, and ended in it
    SELECT * FROM (
      SELECT outputs.*, """ + COMPUTE_TIME + """ AS compute_time FROM outputs
      WHERE created_date >= CAST(:since AS timestamp) - interval '1 day' AND finished_at IS NULL AND is_pending IS NOT TRUE
      OFFSET 0
    ) older WHERE created_date + coalesce(compute_time, 0) * interval '1 second' >= :since
  ) o
  JOIN batches b ON b.id = o.batch_id
  JOIN ci_commits c ON c.id = b.ci_commit_id
  WHERE {where}
"""


def like_escape(value: str) -> str:
  return value.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_')


class Filters:
  """Whose runs, in which projects, which statuses, how far back, and maybe only one group's (`group` and `key`)"""
  def __init__(self, user: Optional[str] = None, projects: Optional[List[str]] = None, allowed_projects: Optional[List[str]] = None,
               window: str = DEFAULT_WINDOW, status: str = 'all', search: Optional[str] = None, option: Optional[str] = None,
               group: Optional[str] = None, key=None, now: Optional[datetime.datetime] = None):
    if window not in WINDOWS:
      raise ValueError(f"`window` must be one of {', '.join(WINDOWS)}")
    if status not in STATUS_FILTERS:
      raise ValueError(f"`status` must be one of {', '.join(STATUS_FILTERS)}")
    if group is not None and group not in GROUPS:
      raise ValueError(f"`group` must be one of {', '.join(GROUPS)}")
    if group == 'option' and not (option or '').strip():
      raise ValueError("Which job option? `option`, e.g. queue or project")
    if group in INTEGER_GROUPS and key is not None:
      try:
        key = int(key)
      except (TypeError, ValueError):
        raise ValueError(f"`key` must be the id of a {group}")
    self.user = user
    self.projects = projects or []
    self.allowed_projects = allowed_projects  # None: all
    self.window = window
    self.status = status
    self.search = (search or '').strip() or None
    self.option = (option or '').strip() or None
    self.group = group
    self.key = key
    self.now = now or utcnow()
    self.since = self.now - WINDOWS[window][0]

  def but(self, **changes) -> 'Filters':
    values = {k: getattr(self, k) for k in ('user', 'projects', 'allowed_projects', 'window', 'status', 'search', 'option', 'group', 'key', 'now')}
    return Filters(**{**values, **changes})

  def where(self):
    """SQL conditions on outputs `o`, batches `b` and commits `c`, and their parameters"""
    conditions, params = ["TRUE"], {"since": self.since, "now": self.now, "option": self.option or ''}
    if self.user is not None:
      conditions.append("coalesce(o.data->>'user', '') = :user")
      params['user'] = self.user
    if self.projects:
      conditions.append("c.project_id = ANY(:projects)")
      params['projects'] = self.projects
    if self.allowed_projects is not None:
      conditions.append("c.project_id = ANY(:allowed_projects)")
      params['allowed_projects'] = self.allowed_projects
    if self.status != 'all':
      conditions.append(f"({STATUS}) = ANY(:statuses)")
      params['statuses'] = list(STATUS_FILTERS[self.status])
    if self.search:
      conditions.append("(c.project_id ILIKE :search ESCAPE '\\' OR c.branch ILIKE :search ESCAPE '\\' OR b.label ILIKE :search ESCAPE '\\' "
                        "OR c.hexsha LIKE :search_sha ESCAPE '\\' OR o.data->>'user' ILIKE :search ESCAPE '\\')")
      params['search'] = f"%{like_escape(self.search)}%"
      params['search_sha'] = f"{like_escape(self.search.lower())}%"
    if self.group is not None and self.key is not None:
      conditions.append(f"{GROUPS[self.group][0]} = :key")
      params['key'] = self.key
    return " AND ".join(conditions), params

  def runs_sql(self):
    where, params = self.where()
    option = "coalesce(o.data->'job_options'->>:option, '')" if self.option else "''"
    return RUNS.format(where=where, option=option), params


def totals(filters: Filters) -> dict:
  """How many runs wait, run, ended and failed: whatever the status filter"""
  runs, params = filters.but(status='all').runs_sql()
  row = db_session.execute(text(f"""
    WITH r AS ({runs})
    SELECT count(*) FILTER (WHERE status = 'waiting'), count(*) FILTER (WHERE status = 'running'),
           count(*) FILTER (WHERE status = 'done'), count(*) FILTER (WHERE status = 'failed'),
           count(DISTINCT user_name) FILTER (WHERE status IN ('waiting', 'running')),
           count(DISTINCT project_id) FILTER (WHERE status IN ('waiting', 'running')),
           count(DISTINCT batch_id) FILTER (WHERE status IN ('waiting', 'running')),
           min({SINCE}) FILTER (WHERE status IN ('waiting', 'running')),
           count(*) FILTER (WHERE status IN ('waiting', 'running') AND {SINCE} < :long_ago)
    FROM r"""), {**params, "long_ago": filters.now - LONG}).one()
  return {
    "waiting": row[0], "running": row[1], "done": row[2], "failed": row[3],
    "active_users": row[4], "active_projects": row[5], "active_batches": row[6],
    "active_since": iso(row[7]), "long_active": row[8],
  }


def active_before(filters: Filters, before: datetime.datetime) -> int:
  """How many runs have been pending since before then"""
  runs, params = filters.but(status='active').runs_sql()
  return db_session.execute(text(f"WITH r AS ({runs}) SELECT count(*) FROM r WHERE {SINCE} < :before"), {**params, "before": before}).scalar()


def breakdown(filters: Filters, group: str, limit=8) -> list:
  """The groups with the most active runs, e.g. the projects or the users that load the cluster the most"""
  runs, params = filters.but(status='all').runs_sql()
  column = GROUPS[group][1]
  rows = db_session.execute(text(f"""
    WITH r AS ({runs})
    SELECT r.{column}, count(*) FILTER (WHERE status = 'waiting'), count(*) FILTER (WHERE status = 'running'),
           count(*) FILTER (WHERE status IN ('done', 'failed')), count(*) FILTER (WHERE status = 'failed')
    FROM r GROUP BY 1
    ORDER BY count(*) FILTER (WHERE status IN ('waiting', 'running')) DESC, count(*) DESC, 1 LIMIT :limit"""), {**params, "limit": limit}).all()
  return [{"key": k, "waiting": w, "running": r, "ended": e, "failed": f} for k, w, r, e, f in rows]


def timeline(filters: Filters) -> dict:
  """
  For each bar of the window: how many runs were waiting and running at some point, and how many ended.
  Runs pending since before the window count from its start.
  """
  window, step = WINDOWS[filters.window]
  nb = int(window / step)
  runs, params = filters.but(status='all').runs_sql()
  params = {**params, "step": step.total_seconds(), "nb": nb}
  bar = lambda date: f"floor(extract(epoch FROM ({date}) - :since) / :step)::int"
  intervals = db_session.execute(text(f"""
    WITH r AS ({runs}),
    intervals AS (
      SELECT 'waiting' AS kind,
             CASE WHEN status = 'waiting' THEN coalesce(queued_at, created_date) ELSE queued_at END AS start,
             CASE WHEN status = 'waiting' THEN :now ELSE coalesce(started_at, finished_at) END AS stop
      FROM r
      UNION ALL
      SELECT 'running',
             CASE WHEN status = 'running' THEN coalesce(started_at, queued_at, created_date) ELSE started_at END,
             CASE WHEN status = 'running' THEN :now ELSE finished_at END
      FROM r
    ),
    bars AS (
      SELECT kind, greatest(0, {bar('start')}) AS first, least(:nb - 1, {bar('stop')}) AS last
      FROM intervals WHERE start IS NOT NULL AND stop IS NOT NULL AND stop >= :since
    )
    SELECT kind, bar, sum(change) FROM (
      SELECT kind, first AS bar, 1 AS change FROM bars WHERE last >= first
      UNION ALL
      SELECT kind, last + 1, -1 FROM bars WHERE last >= first AND last + 1 < :nb
    ) changes GROUP BY kind, bar"""), params).all()
  ended = db_session.execute(text(f"""
    WITH r AS ({runs})
    SELECT status, least(:nb - 1, {bar('finished_at')}), count(*) FROM r
    WHERE status IN ('done', 'failed') AND finished_at >= :since GROUP BY 1, 2"""), params).all()
  bars = [{"at": iso(filters.since + i * step), "waiting": 0, "running": 0, "done": 0, "failed": 0} for i in range(nb)]
  changes = {}
  for kind, index, change in intervals:
    changes.setdefault(kind, [0] * nb)[index] += int(change)
  for kind, values in changes.items():
    count = 0
    for index, change in enumerate(values):
      count += change
      bars[index][kind] = count
  for status, index, count in ended:
    bars[index][status] = count
  return {"step_seconds": int(step.total_seconds()), "bars": bars}


SORTS = {
  'active': "running + waiting DESC, latest DESC",
  'oldest': "active_since ASC NULLS LAST, latest DESC",
  'latest': "latest DESC",
  'runs': "runs DESC, latest DESC",
  'failed': "failed DESC, latest DESC",
}


def items(filters: Filters, group='batch', sort='active', limit=50, offset=0) -> dict:
  """Runs grouped by `group`: how many wait, run, ended or failed, since when, by whom, and how long they take"""
  if group not in GROUPS:
    raise ValueError(f"`group` must be one of {', '.join(GROUPS)}")
  column = GROUPS[group][1]
  runs, params = filters.runs_sql()
  query = f"""
    WITH r AS ({runs})
    SELECT r.{column} AS key, count(*) AS runs,
           count(*) FILTER (WHERE status = 'waiting') AS waiting, count(*) FILTER (WHERE status = 'running') AS running,
           count(*) FILTER (WHERE status = 'done') AS done, count(*) FILTER (WHERE status = 'failed') AS failed,
           min({SINCE}) FILTER (WHERE status IN ('waiting', 'running')) AS active_since,
           max(coalesce(r.finished_at, r.started_at, r.queued_at, r.created_date)) AS latest,
           min(r.project_id) AS project_id, count(DISTINCT r.project_id) AS nb_projects,
           min(r.ci_commit_id) AS ci_commit_id, min(r.hexsha) AS hexsha, min(r.branch) AS branch, count(DISTINCT r.ci_commit_id) AS commits,
           min(r.batch_id) AS batch_id, min(r.batch_label) AS batch_label, count(DISTINCT r.batch_id) AS batches,
           (array_agg(DISTINCT r.batch_label))[1:6] AS labels,
           (array_agg(DISTINCT r.user_name))[1:4] AS users, count(DISTINCT r.user_name) AS nb_users,
           (array_agg(DISTINCT r.runner) FILTER (WHERE r.runner <> ''))[1:3] AS runners,
           (array_agg(DISTINCT r.queue) FILTER (WHERE r.queue <> ''))[1:3] AS queues,
           avg(extract(epoch FROM r.finished_at - r.started_at)) FILTER (WHERE status IN ('done', 'failed') AND r.started_at IS NOT NULL) AS run_seconds,
           avg(extract(epoch FROM coalesce(r.started_at, :now) - r.queued_at)) FILTER (WHERE r.queued_at IS NOT NULL AND (r.started_at IS NOT NULL OR status = 'waiting')) AS wait_seconds
    FROM r GROUP BY r.{column}"""
  total = db_session.execute(text(f"SELECT count(*) FROM ({query}) g"), params).scalar()
  # ORDER BY can't compute with the columns' names: in a subquery it can
  rows = db_session.execute(text(f"SELECT * FROM ({query}) g ORDER BY {SORTS.get(sort, SORTS['active'])}, key LIMIT :limit OFFSET :offset"),
                            {**params, "limit": limit, "offset": offset}).mappings().all()
  answer = []
  for row in rows:
    item = {k: iso(v) if isinstance(v, datetime.datetime) else v for k, v in row.items()}
    for k in ('run_seconds', 'wait_seconds'):
      item[k] = round(float(item[k])) if item[k] is not None else None
    answer.append(item)
  if group == 'command':
    add_commands(answer)
  return {"items": answer, "total": total, "group": group}


def add_commands(items: list) -> None:
  """What `qa batch` commands ran: their command line, when, and their CI job, from batch.data.commands"""
  pairs = [(i['batch_id'], i['key']) for i in items if i['key']]
  if not pairs:
    return
  rows = db_session.execute(text("""
    SELECT x.command_id, b.data->'commands'->x.command_id
    FROM unnest(CAST(:batch_ids AS integer[]), CAST(:command_ids AS text[])) AS x(batch_id, command_id)
    JOIN batches b ON b.id = x.batch_id
  """), {"batch_ids": [p[0] for p in pairs], "command_ids": [p[1] for p in pairs]}).all()
  commands = {command_id: command for command_id, command in rows if isinstance(command, dict)}
  for item in items:
    command = commands.get(item['key'])
    if not command:
      continue
    argv = command.get('argv')
    item['command'] = {
      "argv": ' '.join(str(a) for a in argv)[:500] if isinstance(argv, list) else None,
      "created_at": command.get('command_created_at_datetime'),
      "runner": command.get('runner'),
      "user": command.get('user'),
      "job_url": command.get('job_url'),
    }


STATUS_ORDER = "CASE r.status WHEN 'running' THEN 0 WHEN 'waiting' THEN 1 WHEN 'failed' THEN 2 ELSE 3 END"


def runs(filters: Filters, limit=50, offset=0) -> dict:
  """The runs themselves: what they ran, where, since when. Running and waiting first, then the latest."""
  sql, params = filters.runs_sql()
  query = f"""
    WITH r AS ({sql})
    SELECT r.*, t.path AS input_path, t.database AS input_database, o.configurations, o.extra_parameters,
           o.data->'job_options' AS job_options, o.data->>'failed_reason' AS failed_reason
    FROM r JOIN outputs o ON o.id = r.id LEFT JOIN test_inputs t ON t.id = r.test_input_id"""
  total = db_session.execute(text(f"WITH r AS ({sql}) SELECT count(*) FROM r"), params).scalar()
  rows = db_session.execute(text(f"{query} ORDER BY {STATUS_ORDER}, coalesce(r.finished_at, r.started_at, r.queued_at, r.created_date) DESC, r.id DESC LIMIT :limit OFFSET :offset"),
                            {**params, "limit": limit, "offset": offset}).mappings().all()
  dirs = output_dir_urls([r['id'] for r in rows])
  answer = []
  for row in rows:
    run = {k: iso(v) if isinstance(v, datetime.datetime) else v for k, v in row.items() if k not in ('test_input_id', 'job_option')}
    job_options = row['job_options'] if isinstance(row['job_options'], dict) else {}
    # what users chose, not what qa sets for itself
    run['job_options'] = {k: v for k, v in job_options.items() if k not in ('command_id', 'cwd', 'batch_dir', 'bridge')}
    run['output_dir_url'] = dirs.get(row['id'])
    answer.append(run)
  return {"runs": answer, "total": total}


def output_dir_urls(ids: List[int]) -> Dict[int, str]:
  """Where the runs' files are, to open their logs"""
  if not ids:
    return {}
  from sqlalchemy.orm import joinedload
  from qaboard.api import dir_to_url
  from .models import Output, Batch
  urls = {}
  outputs = Output.query.filter(Output.id.in_(ids)).options(joinedload(Output.batch).joinedload(Batch.ci_commit)).all()
  for output in outputs:
    try:
      urls[output.id] = dir_to_url(output.output_dir)
    except Exception as e:
      print(f"WARNING: no folder for run {output.id}: {e}")
  return urls


def starting_soon(filters: Filters, limit=100) -> list:
  """
  Batches started from QA-Board (batch.data.submissions) whose `qa batch` didn't start yet, e.g. its LSF job is queued.
  Once `qa batch` starts, it saves its command in batch.data.commands, and its runs are pending.
  """
  conditions, params = ["TRUE"], {"since": filters.now - SUBMISSIONS_MAX_AGE, "limit": limit}
  if filters.user is not None:
    conditions.append("s.value->>'user' = :user")
    params['user'] = filters.user
  if filters.projects:
    conditions.append("c.project_id = ANY(:projects)")
    params['projects'] = filters.projects
  if filters.allowed_projects is not None:
    conditions.append("c.project_id = ANY(:allowed_projects)")
    params['allowed_projects'] = filters.allowed_projects
  if filters.search:
    conditions.append("(c.project_id ILIKE :search ESCAPE '\\' OR c.branch ILIKE :search ESCAPE '\\' OR b.label ILIKE :search ESCAPE '\\' "
                      "OR c.hexsha LIKE :search_sha ESCAPE '\\' OR s.value->>'user' ILIKE :search ESCAPE '\\')")
    params['search'] = f"%{like_escape(filters.search)}%"
    params['search_sha'] = f"{like_escape(filters.search.lower())}%"
  rows = db_session.execute(text(f"""
    SELECT b.id AS batch_id, b.label AS batch_label, c.id AS ci_commit_id, c.hexsha, c.branch, c.project_id, s.value AS submission
    FROM batches b
    JOIN ci_commits c ON c.id = b.ci_commit_id
    CROSS JOIN LATERAL jsonb_each(CASE WHEN jsonb_typeof(b.data->'submissions') = 'object' THEN b.data->'submissions' ELSE '{{}}'::jsonb END) s
    WHERE b.data ? 'submissions'
      AND s.value->>'status' IN ('submitting', 'submitted')
      AND NOT (coalesce(b.data->'commands', '{{}}'::jsonb) ? s.key)
      AND s.value->>'created_at' >= :since_iso
      AND {' AND '.join(conditions)}
    ORDER BY s.value->>'created_at' DESC LIMIT :limit"""), {**params, "since_iso": params['since'].isoformat()}).mappings().all()
  from .models.Batch import with_log_dir_url
  answer = []
  for row in rows:
    submission = with_log_dir_url(row['submission'])
    answer.append({
      **{k: submission.get(k) for k in ('id', 'created_at', 'user', 'runner', 'status', 'lsf_job_id', 'queue', 'batch', 'log_dir_url', 'exit_code', 'error')},
      **{k: row[k] for k in ('batch_id', 'batch_label', 'ci_commit_id', 'hexsha', 'branch', 'project_id')},
    })
  return answer


def fail_runs(filters: Filters, reason: str, before: Optional[datetime.datetime] = None, ids: Optional[List[int]] = None, dry_run=False) -> dict:
  """
  Marks pending runs as failed, e.g. those whose job died without saying so. Their jobs aren't stopped: if one
  still runs, it saves its results when it ends. `before`: only those pending since before then.
  Returns how many, per project, and their ids.
  """
  runs_sql, params = filters.but(status='active').runs_sql()
  conditions = [f"{SINCE} < :before"] if before else []
  if ids is not None:
    conditions.append("r.id = ANY(:ids)")
  rows = db_session.execute(text(f"WITH r AS ({runs_sql}) SELECT r.id, r.batch_id, r.project_id, r.command_id FROM r WHERE {' AND '.join(conditions) or 'TRUE'}"),
                            {**params, "before": before, "ids": ids or []}).all()
  by_project = {}
  for _, _, project_id, _ in rows:
    by_project[project_id] = by_project.get(project_id, 0) + 1
  answer = {"runs": len(rows), "batches": len({r[1] for r in rows}), "projects": by_project,
            "ids": [r[0] for r in rows], "commands": sorted({r[3] for r in rows if r[3]})}
  if dry_run or not rows:
    return answer
  db_session.execute(text("""
    UPDATE outputs SET is_pending = false, is_running = false, is_failed = true, finished_at = :now,
           data = (coalesce(data::jsonb, '{}'::jsonb) || jsonb_build_object('failed_reason', CAST(:reason AS text)))::json
    WHERE id = ANY(:ids) AND is_pending"""), {"ids": answer['ids'], "now": utcnow(), "reason": reason})
  db_session.commit()
  cancel_notifications(answer['commands'], reason)
  return answer


def cancel_notifications(command_ids: List[str], reason: str) -> None:
  """The emails users asked for when their batch ends: we don't send them for runs that we marked as failed"""
  from .notifications.batches import cancel_batch_notification, has_pending_runs
  for command_id in command_ids:
    try:
      if not db_session.execute(has_pending_runs, {"command_id": command_id}).first():
        cancel_batch_notification(db_session, command_id, reason)
    except Exception as e:
      db_session.rollback()
      print(f"WARNING: could not cancel the notification of {command_id}: {e}")
