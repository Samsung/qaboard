"""Changing grants and visibility, shared by the project Access API and the admin panel. Callers commit."""
import datetime
from typing import Optional

from .policy import ROLES, VISIBILITIES, prefixes, applies_to, is_valid_project_id


class AccessError(Exception):
  """A change we refuse, with the sentence for the user"""
  def __init__(self, message: str, status: int = 400):
    super().__init__(message)
    self.message, self.status = message, status


def clean_path(value) -> str:
  """A project id or prefix: a/b, without slashes around, nor . or .. segments"""
  if not isinstance(value, str):
    raise AccessError("Which project? Send `project`, e.g. group/repo.")
  parts = [part for part in value.strip().strip('/').split('/') if part]
  if not parts or not is_valid_project_id('/'.join(parts)) or len(value) > 500:
    raise AccessError("Which project? Send `project`, e.g. group/repo.")
  return '/'.join(parts)


def subject_exists(subject: dict):
  """(type, id) of a {type: user|group, id} the client sent"""
  from ..models import User, Group
  if not isinstance(subject, dict) or subject.get('type') not in ('user', 'group'):
    raise AccessError("Who? Send `subject`: {type: user or group, id}.")
  try:
    subject_id = int(subject.get('id'))
  except (TypeError, ValueError):
    raise AccessError("Who? Send `subject`: {type: user or group, id}.")
  model = User if subject['type'] == 'user' else Group
  if model.query.filter(model.id == subject_id).one_or_none() is None:
    raise AccessError(f"This {subject['type']} doesn't exist.", 404)
  return subject['type'], subject_id


def parse_expiry(value) -> Optional[datetime.datetime]:
  if value in (None, ''):
    return None
  try:
    expires_at = datetime.datetime.fromisoformat(str(value).replace('Z', '+00:00'))
  except ValueError:
    raise AccessError("expires_at is a date, e.g. 2027-01-31.")
  if expires_at.tzinfo is not None:
    expires_at = expires_at.astimezone(datetime.timezone.utc).replace(tzinfo=None)
  if expires_at <= datetime.datetime.utcnow():
    raise AccessError("expires_at must be in the future.")
  return expires_at


def owner_grants(resource_id: str) -> list:
  from ..models import RoleGrant
  return RoleGrant.query.filter(RoleGrant.resource_type == 'project', RoleGrant.resource_id == resource_id, RoleGrant.role == 'owner').all()


def check_keeps_an_owner(grant, actor, new_role: Optional[str] = None):
  """Owners can't remove (or demote) the last owner of a project: admins would be the only ones left to manage it"""
  if grant.role != 'owner' or new_role == 'owner' or grant.resource_type != 'project' or actor.is_admin:
    return
  others = [g for g in owner_grants(grant.resource_id) if g.id != grant.id]
  if not others:
    raise AccessError(f"It's the last owner of {grant.resource_id}: add another owner first.")


def set_grant(actor, subject: dict, role: str, resource_type: str, resource_id: str, expires_at=None, source: str = 'manual'):
  """Creates the grant, or changes the role of the same subject on the same resource. Returns (grant, created)."""
  from backend import db_session
  from ..models import RoleGrant
  if role not in ROLES:
    raise AccessError(f"role is one of {', '.join(ROLES)}.")
  subject_type, subject_id = subject_exists(subject)
  grant = RoleGrant.query.filter(
    RoleGrant.subject_type == subject_type, RoleGrant.subject_id == subject_id,
    RoleGrant.resource_type == resource_type, RoleGrant.resource_id == resource_id,
  ).one_or_none()
  created = grant is None
  if created:
    grant = RoleGrant(subject_type=subject_type, subject_id=subject_id, resource_type=resource_type, resource_id=resource_id,
                      granted_at=datetime.datetime.utcnow())
    db_session.add(grant)
  else:
    check_keeps_an_owner(grant, actor, role)
  grant.role, grant.expires_at, grant.source = role, expires_at, source
  grant.granted_by_id = actor.user.id if actor.user is not None else None
  return grant, created


def grants_on(project_id: str) -> list:
  """The grants that apply to a project: on it, on its prefixes, and on all projects"""
  from ..models import RoleGrant
  from sqlalchemy import or_
  return (RoleGrant.query
          .filter(or_(RoleGrant.resource_type == 'instance',
                      (RoleGrant.resource_type == 'project') & RoleGrant.resource_id.in_(prefixes(project_id))))
          .order_by(RoleGrant.resource_type.desc(), RoleGrant.resource_id, RoleGrant.id).all())


def serialize(grant, project_id: Optional[str] = None) -> dict:
  from . import subject_of
  from ..tokens import iso
  granted_by = subject_of('user', grant.granted_by_id) if grant.granted_by_id else None
  return {
    "id": grant.id,
    "subject": subject_of(grant.subject_type, grant.subject_id),
    "role": grant.role,
    "resource_type": grant.resource_type,
    "resource_id": grant.resource_id or None,
    # from a prefix of the project, or all projects: changed there, not here
    "inherited": project_id is not None and (grant.resource_type == 'instance' or grant.resource_id != project_id),
    "source": grant.source,
    "expires_at": iso(grant.expires_at),
    "expired": grant.expires_at is not None and grant.expires_at <= datetime.datetime.utcnow(),
    "granted_by": granted_by,
    "granted_at": iso(grant.granted_at),
  }


def set_visibility(actor, path: str, visibility: Optional[str]):
  """None removes the project's own rule: it inherits again. Returns the previous own visibility."""
  from backend import db_session
  from ..models import ProjectVisibility
  if visibility is not None and visibility not in VISIBILITIES:
    raise AccessError(f"visibility is one of {', '.join(VISIBILITIES)}, or null to inherit.")
  row = ProjectVisibility.query.filter(ProjectVisibility.path == path).one_or_none()
  previous = row.visibility if row else None
  if visibility is None:
    if row is not None:
      db_session.delete(row)
  else:
    if row is None:
      row = ProjectVisibility(path=path)
      db_session.add(row)
    row.visibility = visibility
    row.updated_by_id = actor.user.id if actor.user is not None else None
    row.updated_at = datetime.datetime.utcnow()
  return previous


def changed():
  """After a commit that changed access: this request's caches, and the files' (the other processes within minutes)"""
  from flask import g, has_request_context
  if has_request_context() and hasattr(g, '_access'):
    g._access.clear()
  from ..api.files import invalidate_project_dirs
  invalidate_project_dirs()


__all__ = ['AccessError', 'clean_path', 'set_grant', 'grants_on', 'serialize', 'set_visibility', 'check_keeps_an_owner', 'changed', 'applies_to']
