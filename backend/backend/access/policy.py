"""
The roles and what they allow, in one place (docs/design/user-management.md, Appendix D.1).
Roles are ordered: a role allows what the roles below it allow. Adding one (e.g. maintainer) is a change here.
"""
from typing import Optional


ROLES = ('viewer', 'developer', 'owner')
LEVELS = {None: 0, **{role: level for level, role in enumerate(ROLES, start=1)}}

# permission: (the lowest role that has it, the scope a token needs for it)
PERMISSIONS = {
  'project.read': ('viewer', 'read'),
  # qa run / qa batch send results
  'runs.ingest': ('developer', 'ingest'),
  # redo, stop, rename, move or delete batches and runs, start tuning, export, save artifacts
  'runs.act': ('developer', 'act'),
  'milestones.write': ('developer', 'act'),
  # visibility, members, access requests
  'project.access': ('owner', 'act'),
}

VISIBILITIES = ('public', 'internal', 'private')
# the most restrictive wins along a project's path
RESTRICTIVENESS = {visibility: level for level, visibility in enumerate(VISIBILITIES)}


def required_role(permission: str) -> str:
  return PERMISSIONS[permission][0]


def required_scope(permission: str) -> str:
  return PERMISSIONS[permission][1]


def highest(*roles: Optional[str]) -> Optional[str]:
  return max(roles, key=lambda role: LEVELS[role], default=None)


def allows(role: Optional[str], permission: str) -> bool:
  return LEVELS[role] >= LEVELS[required_role(permission)]


def is_valid_project_id(project_id, new: bool = False) -> bool:
  """
  Project ids clients send: a/b/c, without . or .. or empty segments. Else `a/../b` would get the grants and
  visibility of `a`, and reach the files of `b`. Slashes around are tolerated (like in `prefixes`), not in `new` ids.
  """
  if not isinstance(project_id, str) or '\0' in project_id:
    return False
  if new and project_id != project_id.strip('/'):
    return False
  parts = project_id.strip('/').split('/')
  return all(part not in ('', '.', '..') for part in parts)


def prefixes(project_id: str) -> list:
  """a/b/c -> [a/b/c, a/b, a]: the paths whose grants and visibility apply to a project"""
  parts = [part for part in (project_id or '').strip('/').split('/') if part]
  return ['/'.join(parts[:n]) for n in range(len(parts), 0, -1)]


def applies_to(resource_id: str, project_id: str) -> bool:
  """Whether a grant or a visibility on `resource_id` applies to the project, by path segments (a/b: not a/bc)"""
  resource_id = (resource_id or '').strip('/')
  project_id = (project_id or '').strip('/')
  return bool(resource_id) and (project_id == resource_id or project_id.startswith(resource_id + '/'))
