"""
Reading the audit log: what its actions mean, a project's history for its members, and the filters and exports the
admin panel shares with it (api/admin.py). Recording events is backend/audit.py, the actions backend/audit_actions.py.
"""
import io
import csv
import json
import datetime

from flask import request, jsonify, g, Response
from sqlalchemy import or_

from backend import app
from ..models import AuditEvent
from ..audit import serialize as serialize_event
from ..audit_actions import ACTIONS, CATEGORIES, PROJECT_ACTIONS
from ..access import authorize, denied
from ..access.grants import AccessError, clean_path
from ..search import escape_like
from .auth import login_required


# Rows in a CSV or JSON Lines export: older events need narrower dates
MAX_EXPORT = 100_000
EXPORT_COLUMNS = ('id', 'created_at', 'action', 'actor_kind', 'actor_label', 'actor_user_id', 'actor_token_id', 'ip',
                  'user_agent', 'target_type', 'target_id', 'target_label', 'project_id', 'changes', 'meta')
# What projects' members don't see: where admins' and users' requests come from
PRIVATE_FIELDS = ('ip', 'user_agent')


class FilterError(ValueError):
  pass


def parse_date(name):
  value = request.args.get(name)
  if not value:
    return None
  try:
    date = datetime.datetime.fromisoformat(value.replace('Z', '+00:00'))
  except ValueError:
    raise FilterError(f"`{name}` is an ISO 8601 date, like 2026-11-21 or 2026-11-21T08:00:00Z")
  # events are stored in naive UTC
  if date.tzinfo is not None:
    date = date.astimezone(datetime.timezone.utc).replace(tzinfo=None)
  return date


def filtered(query):
  """The filters in the request's arguments: action (or its prefix, e.g. "token"), category, actor, target, dates"""
  args = request.args
  if args.get('action'):
    action = args['action']
    query = query.filter(or_(AuditEvent.action == action, AuditEvent.action.like(f"{escape_like(action)}.%", escape='\\')))
  if args.get('category'):
    actions = [name for name, a in ACTIONS.items() if a.category == args['category']]
    query = query.filter(AuditEvent.action.in_(actions))
  if args.get('actor'):
    # part of the user name, any case: "alic" finds alice
    query = query.filter(AuditEvent.actor_label.ilike(f"%{escape_like(args['actor'])}%", escape='\\'))
  if args.get('target_type'):
    query = query.filter(AuditEvent.target_type == args['target_type'])
  if args.get('target_id'):
    query = query.filter(AuditEvent.target_id == args['target_id'])
  since, until = parse_date('since'), parse_date('until')
  if since is not None:
    query = query.filter(AuditEvent.created_at >= since)
  if until is not None:
    # a day includes its events: until=2026-11-21 means until the end of that day
    if len(request.args['until']) == 10:
      until = until + datetime.timedelta(days=1)
      query = query.filter(AuditEvent.created_at < until)
    else:
      query = query.filter(AuditEvent.created_at <= until)
  return query


def without_private(event: dict) -> dict:
  return {k: v for k, v in event.items() if k not in PRIVATE_FIELDS}


def page_of_events(query, default_limit=50, redact=False):
  """(answer, error): a page of events, newest first, `?limit=` `?before_id=`"""
  try:
    limit = max(1, min(int(request.args.get('limit', default_limit)), 500))
    before_id = int(request.args['before_id']) if request.args.get('before_id') else None
  except ValueError:
    return None, (jsonify({"error": "limit and before_id must be numbers"}), 400)
  if before_id is not None:
    query = query.filter(AuditEvent.id < before_id)
  events = query.order_by(AuditEvent.id.desc()).limit(limit + 1).all()
  more = len(events) > limit
  events = events[:limit]
  serialized = [serialize_event(e) for e in events]
  if redact:
    serialized = [without_private(e) for e in serialized]
  return {"events": serialized, "next_before_id": events[-1].id if more else None}, None


def export(query, name: str, redact=False):
  """`?format=csv` or `jsonl`: every matching event, newest first, as a download"""
  fmt = request.args.get('format')
  columns = [c for c in EXPORT_COLUMNS if not (redact and c in PRIVATE_FIELDS)]
  count = query.count()
  if count > MAX_EXPORT:
    return jsonify({"error": f"That's {count} events: export at most {MAX_EXPORT} at once, with narrower dates (since, until)."}), 400
  def rows():
    # The response streams after the request ended: each batch is read in its own short session, always closed
    from sqlalchemy.orm import Session
    from ..database import engine
    before_id = None
    while True:
      with Session(engine) as session:
        batch = query.with_session(session)
        if before_id is not None:
          batch = batch.filter(AuditEvent.id < before_id)
        events = batch.order_by(AuditEvent.id.desc()).limit(1000).all()
        serialized = [serialize_event(e) for e in events]
      for data in serialized:
        yield {c: data[c] for c in columns}
      if len(events) < 1000:
        return
      before_id = events[-1].id
  if fmt == 'jsonl':
    body = (json.dumps(row, default=str) + '\n' for row in rows())
    mimetype, extension = 'application/x-ndjson', 'jsonl'
  else:
    def body_csv():
      buffer = io.StringIO()
      writer = csv.DictWriter(buffer, fieldnames=columns)
      writer.writeheader()
      for row in rows():
        writer.writerow({k: json.dumps(v, default=str) if isinstance(v, (dict, list)) else v for k, v in row.items()})
        yield buffer.getvalue()
        buffer.seek(0)
        buffer.truncate(0)
      yield buffer.getvalue()
    body, mimetype, extension = body_csv(), 'text/csv', 'csv'
  filename = f"{name}-{datetime.date.today().isoformat()}.{extension}"
  return Response(body, mimetype=mimetype, headers={"Content-Disposition": f'attachment; filename="{filename}"'})


def answer(query, name: str, default_limit=50, redact=False):
  """A page of the events, or their export with `?format=`"""
  try:
    query = filtered(query)
  except FilterError as e:
    return jsonify({"error": str(e)}), 400
  if request.args.get('format'):
    if request.args['format'] not in ('csv', 'jsonl'):
      return jsonify({"error": "`format` is csv or jsonl"}), 400
    return export(query, name, redact=redact)
  body, error = page_of_events(query, default_limit=default_limit, redact=redact)
  return error or jsonify(body)


@app.route('/api/v1/audit/actions', methods=['GET'])
@app.route('/api/v1/audit/actions/', methods=['GET'])
@login_required
def audit_actions():
  """What the audit log's actions mean: their label, category (with its icon), and whether projects see them"""
  return jsonify({
    "categories": {key: {"label": c.label, "icon": c.icon} for key, c in CATEGORIES.items()},
    "actions": {name: {"label": a.label, "category": a.category, "project": a.project} for name, a in ACTIONS.items()},
  })


@app.route('/api/v1/project/audit', methods=['GET'])
@app.route('/api/v1/project/audit/', methods=['GET'])
@login_required
def project_audit():
  """
  A project's history, for its members with the developer role: who ran, deleted or changed what in it, and in its
  subprojects. Only the actions about projects (audit_actions.Action.project), without addresses.
  """
  try:
    project_id = clean_path(request.args.get('project'))
  except AccessError as e:
    return jsonify({"error": e.message}), e.status
  decision = authorize(g.actor, 'project.history', project_id)
  if not decision.allowed:
    return denied(decision)
  query = (AuditEvent.query
           .filter(or_(AuditEvent.project_id == project_id, AuditEvent.project_id.like(f"{escape_like(project_id)}/%", escape='\\')))
           .filter(AuditEvent.action.in_(PROJECT_ACTIONS)))
  return answer(query, f"{project_id.replace('/', '-')}-history", redact=True)
