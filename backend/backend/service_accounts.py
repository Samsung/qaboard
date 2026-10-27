"""
Service accounts: bot users (kind "service") that only use tokens, for CI and scripts that shouldn't run as a person
(docs/design/user-management.md, §7). Until organizations exist (M4), they belong to:
- the instance: admins manage them, and give them a role on all projects, or on some projects from their Access page;
- a project: its owners manage them, they have a role on the project, and their tokens can't reach outside of it.
Their tokens start with `qab_svc_`. A service account never has more than its role gives it, like users.
Deleting one disables it (runs keep saying who sent them), revokes its tokens and removes its grants.
"""
import re
from typing import Optional

from .access.policy import ROLES, applies_to


OWNER_TYPES = ('instance', 'project')
NAME_RE = re.compile(r'^[a-z0-9][a-z0-9._-]{0,39}$')
# people's sign-in can't create user names like that (api/auth.py: signup refuses brackets)
SUFFIX = '[bot]'
# what their tokens can do: no admin API
SCOPES = ('read', 'ingest', 'act')


class ServiceAccountError(Exception):
  """A change we refuse, with the sentence for the user"""
  def __init__(self, message: str, status: int = 400):
    super().__init__(message)
    self.message, self.status = message, status


def user_name_of(name: str, project_id: Optional[str]) -> str:
  """ci => ci[bot], or group/repo/ci[bot] for the project group/repo"""
  return f"{project_id}/{name}{SUFFIX}" if project_id else f"{name}{SUFFIX}"


def is_service(user) -> bool:
  return user is not None and getattr(user, 'kind', 'human') == 'service'


def project_of(user) -> Optional[str]:
  """The project a service account belongs to, if it belongs to one"""
  if is_service(user) and user.owner_type == 'project':
    return user.owner_id
  return None


def allows_project(user, project_id: Optional[str]) -> bool:
  """Project service accounts only reach their project (and the ones under it), whatever grants they're given"""
  owner = project_of(user)
  if owner is None:
    return True
  return project_id is not None and applies_to(owner, project_id)


def resource_of(user):
  """(resource_type, resource_id) of the grant that gives the service account its role"""
  if user.owner_type == 'project':
    return 'project', user.owner_id
  return 'instance', ''


def grant_of(user):
  from .models import RoleGrant
  resource_type, resource_id = resource_of(user)
  return RoleGrant.query.filter(
    RoleGrant.subject_type == 'user', RoleGrant.subject_id == user.id,
    RoleGrant.resource_type == resource_type, RoleGrant.resource_id == resource_id,
  ).one_or_none()


def create(actor, name, project_id: Optional[str], role: Optional[str], description: Optional[str] = None):
  """Creates the account and its role (added to the session: the caller commits). Returns the user."""
  from backend import db_session
  from .models import User
  from .audit import audit
  from .search import escape_like
  if not isinstance(name, str) or not NAME_RE.match(name.strip()):
    raise ServiceAccountError("Name it with lowercase letters, digits, . _ or -, e.g. “ci” or “nightly-benchmarks” (at most 40 characters).")
  name = name.strip()
  if role is not None and role not in ROLES:
    raise ServiceAccountError(f"role is one of {', '.join(ROLES)}.")
  if project_id and role is None:
    raise ServiceAccountError("Choose its role on the project: viewer, developer or owner.")
  if description is not None and (not isinstance(description, str) or len(description) > 500):
    raise ServiceAccountError("The description is a text of at most 500 characters.")
  user_name = user_name_of(name, project_id)
  if User.query.filter(User.user_name.ilike(escape_like(user_name), escape='\\')).first() is not None:
    raise ServiceAccountError(f"There is already a service account named {name} here, or there was one: choose another name.", 409)
  user = User(
    user_name=user_name,
    full_name=name,
    kind='service',
    status='active',
    owner_type='project' if project_id else 'instance',
    owner_id=project_id or None,
    login_type='SERVICE',
    data={"description": (description or '').strip(), "created_by": actor.user.user_name if actor.user else None},
  )
  db_session.add(user)
  db_session.flush()
  audit('service_account.create', 'user', user.id, user.user_name, project_id=project_id, meta={
    "owner_type": user.owner_type, "role": role,
  }, actor=actor)
  if role is not None:
    set_role(actor, user, role)
  return user


def set_role(actor, user, role: Optional[str]):
  """
  The account's role on its project, or on all projects. None removes it (instance accounts only).
  Raises AccessError when it would remove the project's last owner.
  """
  from backend import db_session
  from .audit import audit
  from .access.grants import set_grant
  resource_type, resource_id = resource_of(user)
  grant = grant_of(user)
  previous = grant.role if grant is not None else None
  if role == previous:
    return
  subject = {"type": "user", "id": user.id, "name": user.user_name}
  if role is None:
    if resource_type == 'project':
      raise ServiceAccountError("A project's service account needs a role on it: delete the account instead.")
    db_session.delete(grant)
    action = 'grant.delete'
  else:
    if role not in ROLES:
      raise ServiceAccountError(f"role is one of {', '.join(ROLES)}.")
    set_grant(actor, subject, role, resource_type, resource_id)
    action = 'grant.update' if previous else 'grant.create'
  audit(action, resource_type, resource_id or None, resource_id or "all projects", project_id=resource_id or None,
        meta={"subject": subject, "role": role or previous}, actor=actor)


def delete(actor, user):
  """Disables the account, revokes its tokens, removes its grants and group memberships. The caller commits."""
  from backend import db_session
  from .models import RoleGrant, GroupMember
  from .audit import audit
  from . import tokens as tokens_lib
  revoked = 0
  for token in user.tokens:
    if tokens_lib.revoke(token, by=actor.user, reason='service_account_deleted', actor=actor):
      revoked += 1
  grants = RoleGrant.query.filter(RoleGrant.subject_type == 'user', RoleGrant.subject_id == user.id).delete()
  GroupMember.query.filter(GroupMember.user_id == user.id).delete()
  user.status = 'disabled'
  user.data = {**(user.data or {}), "deleted_at": tokens_lib.iso(tokens_lib.utcnow())}
  db_session.add(user)
  audit('service_account.delete', 'user', user.id, user.user_name, project_id=project_of(user),
        meta={"revoked_tokens": revoked, "removed_grants": grants}, actor=actor)


def serialize(user, with_tokens: bool = False) -> dict:
  from . import tokens as tokens_lib
  grant = grant_of(user)
  tokens = sorted(user.tokens, key=lambda t: (t.created_at is not None, t.created_at, t.id), reverse=True)
  info = {
    "id": user.id,
    "name": user.full_name,
    "user_name": user.user_name,
    "description": (user.data or {}).get('description') or '',
    "owner_type": user.owner_type,
    "project": user.owner_id if user.owner_type == 'project' else None,
    "role": grant.role if grant is not None else None,
    "status": user.status,
    "created_at": tokens_lib.iso(user.created_date),
    "created_by": (user.data or {}).get('created_by'),
    "active_tokens": sum(1 for t in tokens if tokens_lib.status(t) == 'active'),
    "last_used_at": tokens_lib.iso(max((t.last_used_at for t in tokens if t.last_used_at), default=None)),
  }
  if with_tokens:
    info["tokens"] = [tokens_lib.serialize(t) for t in tokens]
  return info
