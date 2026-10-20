"""
The audit log of security events: who did what to whom, when, from where.
Events are added to the current database session: they're saved with the change they describe, by the caller's commit.
"""
import os
from typing import Optional

from flask import request, g, has_request_context


# How many proxies (e.g. nginx) add themselves to X-Forwarded-For in front of the backend
trusted_proxy_hops = int(os.environ.get('QABOARD_TRUSTED_PROXY_HOPS', 1))

# Keys we never write in an event, wherever they are
SECRET_KEYS = {'password', 'token', 'secret', 'access_token', 'device_code', 'client_secret'}


def client_ip() -> Optional[str]:
  if not has_request_context():
    return None
  forwarded = [ip.strip() for ip in request.headers.get('X-Forwarded-For', '').split(',') if ip.strip()]
  if forwarded and trusted_proxy_hops > 0:
    return forwarded[-min(trusted_proxy_hops, len(forwarded))]
  return request.remote_addr


def without_secrets(value):
  if isinstance(value, dict):
    return {k: ('[redacted]' if k.lower() in SECRET_KEYS else without_secrets(v)) for k, v in value.items()}
  if isinstance(value, list):
    return [without_secrets(v) for v in value]
  return value


def diff(before: dict, after: dict) -> dict:
  """{field: {from, to}} for the fields that changed"""
  return {k: {"from": before.get(k), "to": after.get(k)} for k in sorted({*before, *after}) if before.get(k) != after.get(k)}


def audit(action: str, target_type: Optional[str] = None, target_id=None, target_label: Optional[str] = None,
          project_id: Optional[str] = None, changes: Optional[dict] = None, meta: Optional[dict] = None,
          actor=None, user=None):
  """
  Records an event. The actor is the request's (see backend/actor.py) unless given.
  `user` sets who acted when the request isn't authenticated yet, e.g. at sign-in.
  Returns the event, added to the session: the caller commits.
  """
  from backend import db_session
  from .models import AuditEvent
  if actor is None and has_request_context():
    actor = g.get('actor')
  kind, user_id, token_id, label = 'anonymous', None, None, None
  if user is not None:
    kind, user_id, label = 'user', user.id, user.user_name
  elif actor is not None and actor.user is not None:
    kind = 'token' if actor.token is not None else 'user'
    user_id, label = actor.user.id, actor.user.user_name
    token_id = actor.token.id if actor.token is not None else None
  elif not has_request_context():
    kind, label = 'system', 'system'
  event = AuditEvent(
    actor_kind=kind,
    actor_user_id=user_id,
    actor_token_id=token_id,
    actor_label=label,
    ip=client_ip(),
    user_agent=request.headers.get('User-Agent', '')[:500] if has_request_context() else None,
    action=action,
    target_type=target_type,
    target_id=str(target_id) if target_id is not None else None,
    target_label=target_label,
    project_id=project_id,
    changes=without_secrets(changes or {}),
    meta=without_secrets(meta or {}),
  )
  db_session.add(event)
  return event


def system_audit(action: str, **kwargs):
  """Events from scripts, e.g. the qaboard-admin CLI"""
  from .actor import Actor
  label = kwargs.pop('label', None) or 'qaboard-admin'
  event = audit(action, actor=Actor(), **kwargs)
  event.actor_kind, event.actor_label = 'system', label
  return event


def serialize(event) -> dict:
  from .tokens import iso
  return {
    "id": event.id,
    "created_at": iso(event.created_at),
    "actor_kind": event.actor_kind,
    "actor_user_id": event.actor_user_id,
    "actor_token_id": event.actor_token_id,
    "actor_label": event.actor_label,
    "ip": event.ip,
    "user_agent": event.user_agent,
    "action": event.action,
    "target_type": event.target_type,
    "target_id": event.target_id,
    "target_label": event.target_label,
    "project_id": event.project_id,
    "changes": event.changes or {},
    "meta": event.meta or {},
  }


def purge(retention_days: int) -> int:
  """Deletes the events older than the retention. Returns how many."""
  import datetime
  from backend import db_session
  from .models import AuditEvent
  cutoff = datetime.datetime.utcnow() - datetime.timedelta(days=retention_days)
  count = AuditEvent.query.filter(AuditEvent.created_at < cutoff).delete(synchronize_session=False)
  db_session.commit()
  return count
