"""
Who can do what on a project (docs/design/user-management.md, Appendix D). `authorize` is the only check:
the endpoints call it through `require_project_access`, `is_authorized_user` and `ingest_access` (api/auth.py).

A user's role on a project is the highest of:
- their grants and their groups' grants, on all projects or on the project or a prefix of it (a/b covers a/b/c);
- what the project's visibility gives: public projects give viewer to anyone, public and internal ones give
  signed-in users `projects.signed_in_role`, private ones nothing;
- QABOARD_LOGIN_RESTRICTED_YAML's rules, while it's there: its projects are private, the users it matches developers;
- owner for instance admins.
Tokens never have more than their user, their scopes and their projects allow.
"""
import datetime
from dataclasses import dataclass, field
from typing import Optional, List

from flask import g, has_request_context, jsonify

from .policy import ROLES, VISIBILITIES, RESTRICTIVENESS, required_role, required_scope, highest, allows, prefixes, applies_to, is_valid_project_id


@dataclass
class Decision:
  allowed: bool
  permission: str
  project_id: Optional[str]
  role: Optional[str] = None
  # how the user got their role: admin, grant, group, signed_in, visibility, yaml
  via: Optional[str] = None
  # why not: sign_in_required, missing_role, missing_scope, token_project, invalid_project
  reason: Optional[str] = None
  required: Optional[str] = None


@dataclass
class Context:
  """What we need to know about a user to decide, loaded once per request"""
  user: Optional[object]
  is_admin: bool = False
  group_ids: List[int] = field(default_factory=list)
  # (resource_type, resource_id, role, via)
  grants: list = field(default_factory=list)


def _request_cache() -> dict:
  if not has_request_context():
    return {}
  if not hasattr(g, '_access'):
    g._access = {}
  return g._access


def now():
  return datetime.datetime.utcnow()


def context_of(user) -> Context:
  cache = _request_cache()
  key = ('context', getattr(user, 'id', None))
  if key in cache:
    return cache[key]
  if user is None:
    context = Context(user=None)
  else:
    from ..admins import is_admin
    from ..models import GroupMember, RoleGrant
    from sqlalchemy import or_, and_
    group_ids = [m.group_id for m in GroupMember.query.filter(GroupMember.user_id == user.id).all()]
    subjects = [and_(RoleGrant.subject_type == 'user', RoleGrant.subject_id == user.id)]
    if group_ids:
      subjects.append(and_(RoleGrant.subject_type == 'group', RoleGrant.subject_id.in_(group_ids)))
    rows = (RoleGrant.query
            .filter(or_(*subjects))
            .filter(or_(RoleGrant.expires_at.is_(None), RoleGrant.expires_at > now()))
            .all())
    grants = [(r.resource_type, r.resource_id, r.role, 'grant' if r.subject_type == 'user' else 'group') for r in rows]
    context = Context(user=user, is_admin=is_admin(user), group_ids=group_ids, grants=grants)
  cache[key] = context
  return context


def visibility_rules() -> dict:
  """{path: visibility}: a small table, read once per request"""
  cache = _request_cache()
  if 'visibility' not in cache:
    from ..models import ProjectVisibility
    cache['visibility'] = {r.path: r.visibility for r in ProjectVisibility.query.all()}
  return cache['visibility']


def yaml_key(project_id: str) -> Optional[str]:
  """The key of QABOARD_LOGIN_RESTRICTED_YAML's projects that restricts the project, if it has rules"""
  from ..api.auth import is_login_restricted, restricted_project_key, restrictions
  if not is_login_restricted or not project_id:
    return None
  key = restricted_project_key(project_id)
  return key if key is not None and restrictions('projects').get(key) else None


def effective_visibility(project_id: str) -> dict:
  """{effective, own, inherited_from, default, parent}: the most restrictive of the rules on the project and its prefixes"""
  from ..settings import setting
  rules = visibility_rules()
  default = setting('projects.default_visibility')
  own = rules.get((project_id or '').strip('/'))
  found = [(path, rules[path]) for path in prefixes(project_id) if path in rules]
  if found:
    path, visibility = max(found, key=lambda item: RESTRICTIVENESS[item[1]])
    inherited_from = None if path == (project_id or '').strip('/') else path
  else:
    visibility, inherited_from = default, None
  # what removing the project's own rule would give ("Inherit" in the Access page)
  above = [v for path, v in found if path != (project_id or '').strip('/')]
  parent = max(above, key=lambda v: RESTRICTIVENESS[v]) if above else default
  if yaml_key(project_id) is not None:
    visibility, inherited_from, parent = 'private', 'QABOARD_LOGIN_RESTRICTED_YAML', 'private'
  return {"effective": visibility, "own": own, "inherited_from": inherited_from, "default": default, "parent": parent}


def role_of(user, project_id: str):
  """(role, via) of a user (None: anonymous) on a project"""
  from ..settings import setting
  if project_id is not None and not is_valid_project_id(project_id):
    return None, None
  context = context_of(user)
  if context.is_admin:
    return 'owner', 'admin'
  role, via = None, None
  def consider(candidate, how):
    nonlocal role, via
    if candidate is not None and highest(role, candidate) == candidate and candidate != role:
      role, via = candidate, how
  for resource_type, resource_id, grant_role, how in context.grants:
    if resource_type == 'instance' or (resource_type == 'project' and applies_to(resource_id, project_id)):
      consider(grant_role, how)
  visibility = effective_visibility(project_id)['effective']
  if visibility == 'public':
    consider('viewer', 'visibility')
  if visibility in ('public', 'internal') and user is not None:
    consider(setting('projects.signed_in_role'), 'signed_in')
  key = yaml_key(project_id)
  if key is not None and user is not None:
    from ..api.auth import restrictions, matches_rules, get_current_user
    user_info = get_current_user(to_jsonify=False) if _is_current(user) else {"user_name": user.user_name, "email": user.email}
    if matches_rules(user_info, restrictions('projects')[key]):
      consider('developer', 'yaml')
  return role, via


def _is_current(user) -> bool:
  actor = g.get('actor') if has_request_context() else None
  return actor is not None and actor.user is not None and actor.user.id == user.id


def authorize(actor, permission: str, project_id: Optional[str]) -> Decision:
  required = required_role(permission)
  decision = Decision(allowed=False, permission=permission, project_id=project_id, required=required)
  user = actor.user if actor is not None else None
  # None: what the instance allows, e.g. to list projects
  if project_id is not None and not is_valid_project_id(project_id):
    decision.reason = 'invalid_project'
    return decision
  if actor is not None and actor.token is not None:
    if not actor.has_scope(required_scope(permission)):
      decision.reason, decision.required = 'missing_scope', required_scope(permission)
      return decision
    if not actor.allows_project(project_id):
      decision.reason = 'token_project'
      return decision
  decision.role, decision.via = role_of(user, project_id)
  if allows(decision.role, permission):
    decision.allowed = True
  else:
    decision.reason = 'sign_in_required' if user is None else 'missing_role'
  return decision


def current_actor():
  return g.get('actor') if has_request_context() else None


def can(permission: str, project_id: Optional[str], actor=None) -> bool:
  return authorize(actor if actor is not None else current_actor(), permission, project_id).allowed


def owners(project_id: str, limit=10) -> list:
  """Who to ask: the users and groups with the owner role on the project or a prefix of it"""
  from ..models import RoleGrant
  from sqlalchemy import or_
  rows = (RoleGrant.query
          .filter(RoleGrant.resource_type == 'project', RoleGrant.role == 'owner', RoleGrant.resource_id.in_(prefixes(project_id)))
          .filter(or_(RoleGrant.expires_at.is_(None), RoleGrant.expires_at > now()))
          .order_by(RoleGrant.id).limit(limit).all())
  return [subject_of(r.subject_type, r.subject_id) for r in rows]


def subject_of(subject_type: str, subject_id: int) -> dict:
  from ..models import User, Group
  if subject_type == 'user':
    user = User.query.filter(User.id == subject_id).one_or_none()
    return {"type": "user", "id": subject_id, "name": user.user_name if user else f"#{subject_id}", "full_name": (user.full_name if user else None),
            "kind": user.kind if user else None}
  group = Group.query.filter(Group.id == subject_id).one_or_none()
  return {"type": "group", "id": subject_id, "name": group.name if group else f"#{subject_id}"}


VERBS = {
  'project.read': "see", 'runs.ingest': "send results to", 'runs.act': "change the runs of",
  'milestones.write': "save milestones in", 'project.access': "manage who can access",
}


def invalid_project(project_id):
  """None, or the 400 for a project id we refuse (policy.is_valid_project_id), where `qa` sends results: it creates projects"""
  if is_valid_project_id(project_id, new=True):
    return None
  return denied(Decision(allowed=False, permission='runs.ingest', project_id=None, reason='invalid_project'))


def denied(decision: Decision):
  """The response of a refused decision: 401 to sign in, 403 with whom to ask"""
  from ..actor import error
  project = decision.project_id or 'this project'
  if decision.reason == 'invalid_project':
    return error(400, 'invalid_project', "This isn't a valid project: send it like group/repo, without . or .. or empty parts.")
  if decision.reason == 'missing_scope':
    return jsonify({"error": f"This token can't do this: it needs the \"{decision.required}\" scope.", "reason": "missing_scope", "required": decision.required}), 403
  if decision.reason == 'token_project':
    return jsonify({"error": f"This token can't access {project}.", "reason": "token_project"}), 403
  if decision.reason == 'sign_in_required':
    return error(401, 'sign_in_required', f"Sign in to {VERBS.get(decision.permission, 'access')} {project}.")
  verb = VERBS.get(decision.permission, 'access')
  if decision.role is None:
    message = f"You don't have access to {project}."
  else:
    message = f"You need the {decision.required} role to {verb} {project}: you're a {decision.role}."
  body = {
    "error": message, "reason": "missing_role", "required": decision.required, "role": decision.role,
    "project": decision.project_id, "owners": owners(decision.project_id) if decision.project_id else [],
    "can_request": bool(decision.project_id),
  }
  return jsonify(body), 403
