"""
The audit log: who did what to whom, when, from where. The actions are listed in backend/audit_actions.py.
Events are added to the current database session: they're saved with the change they describe, by the caller's commit.
With QABOARD_AUDIT_STDOUT=1, committed events are also printed as JSON lines, for log collectors and SIEMs.
"""
import os
import sys
import json
import hashlib
import logging
from typing import Optional

from flask import request, g, has_request_context

from .audit_actions import ACTIONS
from .settings import env_flag


logger = logging.getLogger(__name__)

# Tests set it: an action missing from audit_actions.ACTIONS is an error. Else we record it and warn once.
strict = env_flag(os.environ.get('QABOARD_AUDIT_STRICT', ''))
# Prints committed events on stdout, one JSON object per line prefixed with "qaboard-audit "
to_stdout = env_flag(os.environ.get('QABOARD_AUDIT_STDOUT', ''))
_warned = set()


# How many proxies in front of QA-Board's nginx add the client to X-Forwarded-For, e.g. 1 behind a Kubernetes ingress.
# QA-Board's nginx talks uwsgi: it passes the client's address as REMOTE_ADDR, and X-Forwarded-For as the client sent it.
trusted_proxy_hops = int(os.environ.get('QABOARD_TRUSTED_PROXY_HOPS', 0))

# Keys we never write in an event, wherever they are
SECRET_KEYS = {'password', 'token', 'secret', 'access_token', 'device_code', 'client_secret'}


def client_ip() -> Optional[str]:
  if not has_request_context():
    return None
  forwarded = [ip.strip() for ip in request.headers.get('X-Forwarded-For', '').split(',') if ip.strip()]
  if forwarded and trusted_proxy_hops > 0:
    return forwarded[-min(trusted_proxy_hops, len(forwarded))]
  return request.remote_addr


# Keys holding secrets in what users send (tuning parameters, CI inputs...): e.g. github_token, AWS_SECRET_ACCESS_KEY.
# Only text values are redacted: flags and ids like generated_password, token_id stay.
SECRET_WORDS = ('password', 'passwd', 'secret', 'token', 'api_key', 'apikey', 'private_key', 'access_key', 'credential')


def is_secret(key, value) -> bool:
  key = str(key).lower()
  if key in SECRET_KEYS:
    return True
  if not isinstance(value, str) or key.endswith(('_id', '_env')):
    return False
  return any(word in key for word in SECRET_WORDS)


def without_secrets(value):
  if isinstance(value, dict):
    return {k: ('[redacted]' if is_secret(k, v) else without_secrets(v)) for k, v in value.items()}
  if isinstance(value, list):
    return [without_secrets(v) for v in value]
  return value


def diff(before: dict, after: dict) -> dict:
  """{field: {from, to}} for the fields that changed"""
  return {k: {"from": before.get(k), "to": after.get(k)} for k in sorted({*before, *after}) if before.get(k) != after.get(k)}


# Events stay small: they're listed, filtered and exported. Lists and mappings keep their first items, texts are cut.
MAX_ITEMS = 50
MAX_TEXT = 300


def capped(value, items: int = MAX_ITEMS, text: int = MAX_TEXT):
  """A copy of `value` small enough for an event's meta or changes"""
  if isinstance(value, str):
    return value if len(value) <= text else value[:text] + '…'
  if isinstance(value, dict):
    return {str(k)[:text]: capped(v, items, text) for k, v in list(value.items())[:items]}
  if isinstance(value, (list, tuple, set)):
    return [capped(v, items, text) for v in list(value)[:items]]
  return value


def canonical_json(value) -> str:
  return json.dumps(value, sort_keys=True, separators=(',', ':'), default=str)


def fingerprint(value, limit: int = 4000) -> dict:
  """What identifies large parameters in an event: the hash of their canonical JSON, and the JSON, cut at `limit`"""
  # without their secrets, also in the hash: a hash of a short password could be guessed
  kept = canonical_json(without_secrets(value))
  return {
    "parameters_sha256": hashlib.sha256(kept.encode('utf-8')).hexdigest(),
    "parameters": kept[:limit],
    **({"parameters_truncated": True} if len(kept) > limit else {}),
  }


def update_meta(event, **meta):
  """Adds to the meta of an event recorded before what it describes ended, e.g. whether a batch started: the caller commits"""
  if event is not None:
    event.meta = without_secrets({**(event.meta or {}), **meta})


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
  if action not in ACTIONS:
    if strict:
      raise ValueError(f"Unknown audit action {action!r}: add it to backend/audit_actions.py")
    if action not in _warned:
      _warned.add(action)
      logger.warning(f"[audit] unknown action {action!r}: add it to backend/audit_actions.py")
  if actor is None and has_request_context():
    actor = g.get('actor')
  kind, user_id, token_id, label = 'anonymous', None, None, None
  if user is not None:
    kind, user_id, label = 'user', user.id, user.user_name
  elif actor is not None and actor.user is not None:
    kind = 'token' if actor.token is not None else 'user'
    user_id, label = actor.user.id, actor.user.user_name
    token_id = actor.token.id if actor.token is not None else None
  elif actor is not None and actor.label:
    kind, label = 'system', actor.label
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


def print_committed(session):
  """Called after commits (database.py): prints the events the transaction saved, see QABOARD_AUDIT_STDOUT"""
  flushed = session.info.pop('audit_flushed', None) or []
  # an event completed in the same transaction is printed once, as it ends up
  latest = {}
  for _, event in flushed:
    latest[event["id"]] = event
  for event in latest.values():
    print(f"qaboard-audit {json.dumps(event, default=str, separators=(',', ':'))}", file=sys.stdout, flush=True)


def remember_flushed(session, flush_context=None):
  """Called after flushes: ids and dates are set, and we can't query the database once committed"""
  from .models import AuditEvent
  # with the events whose details were completed later (update_meta): printed again, with the same id,
  # unless they're progress that will be completed again (audit_quiet, e.g. a garbage collection's counts)
  events = [serialize(o) for o in session.new if isinstance(o, AuditEvent)]
  events += [serialize(o) for o in session.dirty if isinstance(o, AuditEvent) and not getattr(o, 'audit_quiet', False)]
  if events:
    # by transaction: a savepoint that rolls back forgets only its own
    transaction = session.get_nested_transaction() or session.get_transaction()
    session.info.setdefault('audit_flushed', []).extend((transaction, e) for e in events)


def forget_rolled_back(session, previous_transaction):
  """Called after rollbacks, of savepoints too: forgets the events flushed in the transaction, or in those it contains"""
  def within(transaction):
    while transaction is not None:
      if transaction is previous_transaction:
        return True
      transaction = transaction.parent
    return False
  flushed = session.info.get('audit_flushed')
  if flushed:
    session.info['audit_flushed'] = [(t, e) for t, e in flushed if not within(t)]


def install_stdout():
  """Prints committed events if QABOARD_AUDIT_STDOUT is set: from every session (requests, jobs, scripts)"""
  if not to_stdout:
    return
  from sqlalchemy import event
  from sqlalchemy.orm import Session
  if not event.contains(Session, 'after_commit', print_committed):
    event.listen(Session, 'after_flush', remember_flushed)
    # not for savepoints: only once the whole transaction is committed
    event.listen(Session, 'after_commit', print_committed)
    event.listen(Session, 'after_soft_rollback', forget_rolled_back)


def system_audit(action: str, label='qaboard-admin', **kwargs):
  """Events from scripts, e.g. the qaboard-admin CLI"""
  from .actor import Actor
  return audit(action, actor=Actor(label=label), **kwargs)


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
