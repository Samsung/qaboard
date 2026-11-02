"""
Who gets an account (`auth.access_policy`), and the requests of users waiting for an admin.
Admins hear about new requests by email (when QA-Board can send emails) and through `auth.access_request_webhook`.
Requesters get an email when an admin decides.
"""
import threading
from html import escape
from typing import Optional

from ..settings import setting
from ..tokens import utcnow, iso


def initial_status(email: Optional[str]) -> str:
  """active or pending, for a user signing in for the first time"""
  policy = setting('auth.access_policy')
  if policy == 'open':
    return 'active'
  if policy == 'domains' and email and '@' in email:
    domain = email.rsplit('@', 1)[1].strip().lower()
    allowed = {d.strip().lower().lstrip('@') for d in setting('auth.allowed_email_domains') or []}
    if domain in allowed:
      return 'active'
  return 'pending'


def pending_request(user):
  from ..models import AccessRequest
  return (AccessRequest.query
          .filter(AccessRequest.user_id == user.id, AccessRequest.kind == 'instance', AccessRequest.status == 'pending')
          .order_by(AccessRequest.id.desc()).first())


def request_access(user, message: str = '', notify_admins: bool = True):
  """The user's pending request, created if needed. Added to the database session: the caller commits."""
  from backend import db_session
  from ..models import AccessRequest
  request_row = pending_request(user)
  is_new = request_row is None
  if is_new:
    request_row = AccessRequest(user_id=user.id, kind='instance', message='', status='pending', created_at=utcnow())
    db_session.add(request_row)
  if message:
    request_row.message = message[:2000]
  if notify_admins and (is_new or message):
    notify(new_request_text(user, request_row), subject=f"QA-Board: {user.full_name or user.user_name} asks for access", to_admins=True)
  return request_row


def decide(user, status: str, by=None):
  """When an admin changes a pending user's status: their request is approved or denied, and they're told"""
  request_row = pending_request(user)
  if request_row is None:
    return None
  request_row.status = 'approved' if status == 'active' else 'denied'
  request_row.decided_at = utcnow()
  request_row.decided_by_id = by.id if by is not None else None
  if request_row.status == 'approved':
    text = f"Your access to QA-Board was approved. Sign in at {public_url()}."
  else:
    text = "Your request to use QA-Board was denied. Ask a QA-Board admin if you think it's a mistake."
  notify(text, subject="QA-Board: your access request", to_user=user)
  return request_row


def reviewers():
  """The admins who review requests: active, human"""
  from ..models import User
  from ..admins import is_admin
  return [u for u in User.query.filter(User.status == 'active', User.kind == 'human').all() if is_admin(u)]


def public_url() -> str:
  import os
  return (os.environ.get('QABOARD_URL') or '').rstrip('/') or 'QA-Board'


def new_request_text(user, request_row) -> str:
  who = f"{user.full_name} ({user.user_name})" if user.full_name else user.user_name
  email = f", {user.email}" if user.email else ''
  message = f"\nTheir message: {request_row.message}" if request_row.message else ''
  return f"{who}{email} signed in to QA-Board and waits for an admin.{message}\nApprove or deny: {public_url()}/admin/users/{user.id}"


def notify(text: str, subject: str, to_admins: bool = False, to_user=None, to_users=()):
  """Emails and the webhook, in the background: they never block or fail the request"""
  from ..notifications.mail import email_enabled, is_email
  recipients = []
  if email_enabled():
    if to_admins:
      recipients = [u.email for u in reviewers() if is_email(u.email)]
    for user in [to_user, *to_users]:
      if user is not None and is_email(user.email) and user.email not in recipients:
        recipients.append(user.email)
  webhook = setting('auth.access_request_webhook') if to_admins else None
  if not recipients and not webhook:
    return
  threading.Thread(target=_send, args=(text, subject, recipients, webhook), name='access-notify', daemon=True).start()


def _send(text, subject, recipients, webhook):
  from ..notifications.mail import send_email
  for to in recipients:
    try:
      html = '<p>' + escape(text).replace('\n', '<br>') + '</p>'
      send_email(to, subject, html, text, headers={'X-QABoard-Notification': 'access-request'})
    except Exception as e:
      print(f"[access] WARNING: could not email {to}: {type(e).__name__}: {e}")
  if webhook:
    import requests
    try:
      requests.post(webhook, json={"text": text}, timeout=10).raise_for_status()
    except Exception as e:
      print(f"[access] WARNING: the access request webhook failed: {type(e).__name__}")


def serialize(request_row) -> dict:
  user = request_row.user
  return {
    "id": request_row.id,
    "kind": request_row.kind,
    "message": request_row.message,
    "status": request_row.status,
    "created_at": iso(request_row.created_at),
    "decided_at": iso(request_row.decided_at),
    # project requests: which project, which role
    "project": request_row.resource_id,
    "role": request_row.role,
    "user": {"id": user.id, "user_name": user.user_name, "full_name": user.full_name, "email": user.email} if user else None,
  }
