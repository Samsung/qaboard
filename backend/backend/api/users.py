"""
What users manage about themselves: their preferences (they follow them from browser to browser),
and their own security events (sign-ins, tokens, devices).
"""
import json

from flask import request, jsonify, g
from sqlalchemy import or_
from sqlalchemy.orm.attributes import flag_modified

from backend import app, db_session
from ..models import AuditEvent
from ..audit import serialize as serialize_event
from .. import tokens as tokens_lib
from .auth import login_required


MAX_PREFERENCES_BYTES = 64 * 1024


def preferences_answer(user):
  return jsonify({"preferences": user.preferences or {}, "updated_at": tokens_lib.iso(user.preferences_updated_at)})


@app.route('/api/v1/user/preferences', methods=['GET'])
@app.route('/api/v1/user/preferences/', methods=['GET'])
@login_required
def get_preferences():
  return preferences_answer(g.actor.user)


@app.route('/api/v1/user/preferences', methods=['POST'])
@app.route('/api/v1/user/preferences/', methods=['POST'])
@login_required
def update_preferences():
  """Merges the top-level keys it gets, `null` removes one"""
  body = request.get_json(silent=True) or {}
  changes = body.get('preferences')
  if not isinstance(changes, dict):
    return jsonify({"error": "Send {\"preferences\": {\"key\": value}}"}), 400
  user = g.actor.user
  preferences = {**(user.preferences or {})}
  for key, value in changes.items():
    if value is None:
      preferences.pop(key, None)
    else:
      preferences[key] = value
  if len(json.dumps(preferences)) > MAX_PREFERENCES_BYTES:
    return jsonify({"error": f"Preferences are limited to {MAX_PREFERENCES_BYTES // 1024} KiB."}), 413
  user.preferences = preferences
  flag_modified(user, 'preferences')
  user.preferences_updated_at = tokens_lib.utcnow()
  db_session.commit()
  return preferences_answer(user)


def page_of_events(query, default_limit=50):
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
  return {"events": [serialize_event(e) for e in events], "next_before_id": events[-1].id if more else None}, None


@app.route('/api/v1/user/audit', methods=['GET'])
@app.route('/api/v1/user/audit/', methods=['GET'])
@login_required
def my_audit_events():
  user = g.actor.user
  query = AuditEvent.query.filter(or_(
    AuditEvent.actor_user_id == user.id,
    (AuditEvent.target_type == 'user') & (AuditEvent.target_id == str(user.id)),
  ))
  answer, error = page_of_events(query)
  return error or jsonify(answer)
