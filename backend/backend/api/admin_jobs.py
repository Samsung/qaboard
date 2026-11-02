"""
Admin > Storage: start, follow and cancel server jobs (e.g. hard-deleting deleted runs), see their errors,
and schedule them. A thin layer over backend/jobs/queue.py, which knows nothing about Flask.
"""
import csv
import io

from flask import request, jsonify, g, Response, stream_with_context
from sqlalchemy import func
from sqlalchemy.exc import OperationalError

from backend import app, db_session
from ..models import Job, JobError, JobSchedule, Project
from ..audit import audit
from ..jobs import queue, kinds
from ..jobs import params as params_lib
from ..jobs.cron import next_run, CronError
from ..jobs.params import ParamsError
from .auth import admin_required


def body():
  data = request.get_json(silent=True)
  return data if isinstance(data, dict) else {}


def int_arg(name, default, low=0, high=None):
  try:
    value = int(request.args.get(name, default))
  except (TypeError, ValueError):
    raise ParamsError(f"`{name}` must be a number")
  value = max(low, value)
  return min(value, high) if high is not None else value


@app.errorhandler(ParamsError)
def params_error(e):
  return jsonify({"error": str(e)}), 400


def get_job_or_404(job_id):
  job = db_session.get(Job, job_id)
  if job is None:
    return None, (jsonify({"error": "This job doesn't exist."}), 404)
  return job, None


@app.route('/api/v1/admin/jobs', methods=['GET'])
@app.route('/api/v1/admin/jobs/', methods=['GET'])
@admin_required
def admin_jobs():
  limit = int_arg('limit', 50, low=1, high=200)
  query = Job.query
  if request.args.get('status'):
    statuses = request.args['status'].split(',')
    query = query.filter(Job.status.in_(statuses))
  if request.args.get('kind'):
    query = query.filter(Job.kind == request.args['kind'])
  if request.args.get('schedule'):
    query = query.filter(Job.schedule_id == int_arg('schedule', 0))
  if request.args.get('before_id'):
    query = query.filter(Job.id < int_arg('before_id', 0))
  jobs = query.order_by(Job.id.desc()).limit(limit + 1).all()
  return jsonify({
    "jobs": [queue.serialize_job(j) for j in jobs[:limit]],
    "next_before_id": jobs[limit - 1].id if len(jobs) > limit else None,
    "workers": queue.workers(),
    "kinds": kinds.LABELS,
  })


@app.route('/api/v1/admin/jobs', methods=['POST'])
@app.route('/api/v1/admin/jobs/', methods=['POST'])
@admin_required
def admin_create_job():
  data = body()
  try:
    job = queue.create(data.get('kind'), data.get('params') or {}, user=g.actor.user)
  except queue.Busy as e:
    return jsonify({"error": str(e), "job": queue.serialize_job(e.job)}), 409
  audit('job.create', 'job', job.id, kinds.LABELS.get(job.kind, job.kind), meta={"kind": job.kind, "params": job.params})
  db_session.commit()
  return jsonify(queue.serialize_job(job, with_log=True)), 201


@app.route('/api/v1/admin/jobs/estimate', methods=['POST'])
@app.route('/api/v1/admin/jobs/estimate/', methods=['POST'])
@admin_required
def admin_estimate_job():
  """How many runs a hard delete would look at. On big databases counting can be too slow: we say so."""
  data = body()
  if data.get('kind') != 'hard_delete':
    return jsonify({"error": "Only hard deletes can be estimated: start a dry run instead."}), 400
  from ..jobs import hard_delete
  params = hard_delete.validate(data.get('params') or {})
  try:
    return jsonify({**hard_delete.estimate(params), "timeout": False})
  except OperationalError as e:
    if 'statement timeout' not in str(e) and 'canceling statement' not in str(e):
      raise
    return jsonify({"total": None, "projects": {}, "timeout": True})


@app.route('/api/v1/admin/jobs/projects', methods=['GET'])
@app.route('/api/v1/admin/jobs/projects/', methods=['GET'])
@admin_required
def admin_jobs_projects():
  """The projects that patterns select, to check them before starting a job"""
  include = params_lib.globs(request.args.get('projects'), 'projects', default=['*'])
  exclude = params_lib.globs(request.args.get('exclude_projects'), 'exclude_projects')
  ids = [i for (i,) in db_session.query(Project.id).order_by(Project.id) if params_lib.matches(i, include, exclude)]
  return jsonify({"total": len(ids), "projects": ids[:200]})


@app.route('/api/v1/admin/jobs/<int:job_id>', methods=['GET'])
@app.route('/api/v1/admin/jobs/<int:job_id>/', methods=['GET'])
@admin_required
def admin_job(job_id):
  job, error = get_job_or_404(job_id)
  if error:
    return error
  return jsonify({**queue.serialize_job(job, with_log=True), "workers": queue.workers()})


@app.route('/api/v1/admin/jobs/<int:job_id>/cancel', methods=['POST'])
@app.route('/api/v1/admin/jobs/<int:job_id>/cancel/', methods=['POST'])
@admin_required
def admin_cancel_job(job_id):
  """`force: true`: don't wait for the worker of a running job, e.g. it's stuck reading a storage that doesn't answer"""
  job, error = get_job_or_404(job_id)
  if error:
    return error
  if job.status not in queue.ACTIVE:
    return jsonify({"error": f"This job is {job.status}: it can't be cancelled."}), 400
  force = bool(body().get('force'))
  queue.cancel(job, force=force)
  audit('job.cancel', 'job', job.id, kinds.LABELS.get(job.kind, job.kind), meta={"force": True} if force else None)
  db_session.commit()
  return jsonify(queue.serialize_job(job, with_log=True))


@app.route('/api/v1/admin/jobs/<int:job_id>/retry', methods=['POST'])
@app.route('/api/v1/admin/jobs/<int:job_id>/retry/', methods=['POST'])
@admin_required
def admin_retry_job(job_id):
  """The same job again, e.g. after fixing permissions. `dry_run: false` runs a dry run for real."""
  job, error = get_job_or_404(job_id)
  if error:
    return error
  params = dict(job.params or {})
  if 'dry_run' in body():
    params['dry_run'] = body()['dry_run']
  try:
    new_job = queue.create(job.kind, params, user=g.actor.user)
  except queue.Busy as e:
    return jsonify({"error": str(e), "job": queue.serialize_job(e.job)}), 409
  audit('job.create', 'job', new_job.id, kinds.LABELS.get(new_job.kind, new_job.kind), meta={"kind": new_job.kind, "params": new_job.params, "retry_of": job.id})
  db_session.commit()
  return jsonify(queue.serialize_job(new_job, with_log=True)), 201


def errors_query(job_id):
  query = JobError.query.filter(JobError.job_id == job_id)
  if request.args.get('kind'):
    query = query.filter(JobError.kind == request.args['kind'])
  if request.args.get('owner'):
    query = query.filter(JobError.owner == request.args['owner'])
  if request.args.get('project'):
    query = query.filter(JobError.project_id == request.args['project'])
  return query


@app.route('/api/v1/admin/jobs/<int:job_id>/errors', methods=['GET'])
@app.route('/api/v1/admin/jobs/<int:job_id>/errors/', methods=['GET'])
@admin_required
def admin_job_errors(job_id):
  """The errors, with their counts by kind, by owner and by project, to see what to fix first"""
  job, error = get_job_or_404(job_id)
  if error:
    return error
  limit, offset = int_arg('limit', 100, low=1, high=1000), int_arg('offset', 0)
  query = errors_query(job_id)
  def counts(column):
    rows = (query.with_entities(column, func.count(JobError.id)).group_by(column)
            .order_by(func.count(JobError.id).desc()).limit(20).all())
    return [{"value": value, "count": count} for value, count in rows]
  return jsonify({
    "errors": [queue.serialize_error(e) for e in query.order_by(JobError.id).offset(offset).limit(limit)],
    "total": query.count(),
    "by_kind": counts(JobError.kind),
    "by_owner": counts(JobError.owner),
    "by_project": counts(JobError.project_id),
    # more errors than we saved
    "not_saved": (job.progress or {}).get('errors_not_saved', 0),
  })


@app.route('/api/v1/admin/jobs/<int:job_id>/errors.csv', methods=['GET'])
@admin_required
def admin_job_errors_csv(job_id):
  job, error = get_job_or_404(job_id)
  if error:
    return error
  columns = ['kind', 'owner', 'path', 'message', 'project_id', 'batch_id', 'output_id', 'created_at']
  def rows():
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow(columns)
    last_id = 0
    while True:
      page = errors_query(job_id).filter(JobError.id > last_id).order_by(JobError.id).limit(5000).all()
      if not page:
        break
      last_id = page[-1].id
      for e in page:
        writer.writerow([getattr(e, c) for c in columns])
      yield buffer.getvalue()
      buffer.seek(0)
      buffer.truncate()
    yield buffer.getvalue()
  return Response(stream_with_context(rows()), mimetype='text/csv', headers={"Content-Disposition": f'attachment; filename="job-{job_id}-errors.csv"'})


# --- schedules ---

def get_schedule_or_404(schedule_id):
  schedule = db_session.get(JobSchedule, schedule_id)
  if schedule is None:
    return None, (jsonify({"error": "This schedule doesn't exist."}), 404)
  return schedule, None


@app.route('/api/v1/admin/job-schedules', methods=['GET'])
@app.route('/api/v1/admin/job-schedules/', methods=['GET'])
@admin_required
def admin_job_schedules():
  schedules = JobSchedule.query.order_by(JobSchedule.name, JobSchedule.id).all()
  last_jobs = {j.id: j for j in Job.query.filter(Job.id.in_([s.last_job_id for s in schedules if s.last_job_id]))}
  return jsonify({"schedules": [
    {**queue.serialize_schedule(s), "last_job": queue.serialize_job(last_jobs[s.last_job_id]) if s.last_job_id in last_jobs else None}
    for s in schedules
  ], "workers": queue.workers()})


@app.route('/api/v1/admin/job-schedules/next-runs', methods=['GET'])
@app.route('/api/v1/admin/job-schedules/next-runs/', methods=['GET'])
@admin_required
def admin_job_schedule_next_runs():
  """When a cron expression would run, to check it while typing it"""
  cron, tz = request.args.get('cron', ''), request.args.get('timezone') or 'UTC'
  try:
    runs, after = [], queue.utcnow()
    for _ in range(5):
      after = next_run(cron, tz, after)
      runs.append(queue.iso(after))
  except CronError as e:
    return jsonify({"error": str(e)}), 400
  return jsonify({"next_runs": runs})


@app.route('/api/v1/admin/job-schedules', methods=['POST'])
@app.route('/api/v1/admin/job-schedules/', methods=['POST'])
@admin_required
def admin_create_job_schedule():
  data = body()
  for required in ('name', 'kind', 'cron'):
    if required not in data:
      return jsonify({"error": f"`{required}` is required"}), 400
  schedule = queue.save_schedule(JobSchedule(), {k: v for k, v in data.items() if k in ('name', 'kind', 'params', 'cron', 'timezone', 'enabled')}, user=g.actor.user)
  audit('job_schedule.create', 'job_schedule', schedule.id, schedule.name, meta=queue.serialize_schedule(schedule))
  db_session.commit()
  return jsonify(queue.serialize_schedule(schedule)), 201


@app.route('/api/v1/admin/job-schedules/<int:schedule_id>', methods=['POST'])
@app.route('/api/v1/admin/job-schedules/<int:schedule_id>/', methods=['POST'])
@admin_required
def admin_update_job_schedule(schedule_id):
  schedule, error = get_schedule_or_404(schedule_id)
  if error:
    return error
  before = queue.serialize_schedule(schedule)
  queue.save_schedule(schedule, {k: v for k, v in body().items() if k in ('name', 'kind', 'params', 'cron', 'timezone', 'enabled')}, user=g.actor.user)
  after = queue.serialize_schedule(schedule)
  keys = ('name', 'kind', 'params', 'cron', 'timezone', 'enabled')
  changes = {k: {"from": before[k], "to": after[k]} for k in keys if before[k] != after[k]}
  if changes:
    audit('job_schedule.update', 'job_schedule', schedule.id, schedule.name, changes=changes)
  db_session.commit()
  return jsonify(after)


@app.route('/api/v1/admin/job-schedules/<int:schedule_id>', methods=['DELETE'])
@app.route('/api/v1/admin/job-schedules/<int:schedule_id>/', methods=['DELETE'])
@admin_required
def admin_delete_job_schedule(schedule_id):
  schedule, error = get_schedule_or_404(schedule_id)
  if error:
    return error
  audit('job_schedule.delete', 'job_schedule', schedule.id, schedule.name, meta=queue.serialize_schedule(schedule))
  db_session.delete(schedule)
  db_session.commit()
  return jsonify({"deleted": schedule_id})


@app.route('/api/v1/admin/job-schedules/<int:schedule_id>/run', methods=['POST'])
@app.route('/api/v1/admin/job-schedules/<int:schedule_id>/run/', methods=['POST'])
@admin_required
def admin_run_job_schedule(schedule_id):
  """Runs a schedule's job now, e.g. to check it works. Its next scheduled run doesn't change."""
  schedule, error = get_schedule_or_404(schedule_id)
  if error:
    return error
  try:
    job = queue.create(schedule.kind, schedule.params, user=g.actor.user, schedule=schedule)
  except queue.Busy as e:
    return jsonify({"error": str(e), "job": queue.serialize_job(e.job)}), 409
  schedule.last_run_at, schedule.last_job_id, schedule.last_message = queue.utcnow(), job.id, None
  audit('job.create', 'job', job.id, kinds.LABELS.get(job.kind, job.kind), meta={"kind": job.kind, "params": job.params, "schedule": schedule.name})
  db_session.commit()
  return jsonify(queue.serialize_job(job, with_log=True)), 201
