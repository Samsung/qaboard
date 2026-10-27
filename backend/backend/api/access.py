"""
Who can access a project, from its Access page (docs/design/user-management.md, Appendix D.5): visibility, members,
access requests. Managing needs the project.access permission (owners, admins), on the project or a prefix of it.
"""
from flask import request, jsonify, g

from backend import app, db_session
from ..audit import audit
from ..access import authorize, can, denied, effective_visibility, owners, role_of
from ..access.grants import AccessError, clean_path, set_grant, grants_on, serialize as serialize_grant, set_visibility, check_keeps_an_owner, changed
from ..access.policy import ROLES, LEVELS
from ..sign_in.access import notify, public_url, serialize as serialize_request
from ..tokens import utcnow
from .auth import authenticated, login_required


def access_error(e: AccessError):
  return jsonify({"error": e.message}), e.status


def project_param(value):
  try:
    return clean_path(value), None
  except AccessError as e:
    return None, access_error(e)


def may_manage(project_id):
  """None if the caller can manage the project's access, else the response"""
  decision = authorize(g.actor, 'project.access', project_id)
  return None if decision.allowed else denied(decision)


def pending_requests(project_id, user_id=None):
  from ..models import AccessRequest
  query = AccessRequest.query.filter(AccessRequest.kind == 'project', AccessRequest.resource_id == project_id, AccessRequest.status == 'pending')
  if user_id is not None:
    query = query.filter(AccessRequest.user_id == user_id)
  return query.order_by(AccessRequest.created_at).all()


@app.route('/api/v1/project/access', methods=['GET'])
@app.route('/api/v1/project/access/', methods=['GET'])
def project_access():
  project_id, error = project_param(request.args.get('project'))
  if error:
    return error
  user = g.actor.user
  read = authorize(g.actor, 'project.read', project_id)
  if not read.allowed:
    return denied(read)
  role, via = role_of(user, project_id)
  can_manage = can('project.access', project_id)
  body = {
    "project": project_id,
    "my_role": role,
    "via": via,
    "can_manage": can_manage,
    "visibility": effective_visibility(project_id),
    # whom to ask: for signed-in users
    "owners": owners(project_id) if user is not None else [],
    "my_request": None,
  }
  if user is not None:
    mine = pending_requests(project_id, user.id)
    body["my_request"] = serialize_request(mine[0]) if mine else None
  if can_manage:
    body["grants"] = [serialize_grant(grant, project_id) for grant in grants_on(project_id)]
    body["requests"] = [serialize_request(r) for r in pending_requests(project_id)]
  return jsonify(body)


@app.route('/api/v1/project/access/visibility', methods=['POST'])
@app.route('/api/v1/project/access/visibility/', methods=['POST'])
@login_required
def update_project_visibility():
  body = request.get_json(silent=True) or {}
  project_id, error = project_param(body.get('project'))
  if error:
    return error
  if forbidden := may_manage(project_id):
    return forbidden
  if 'visibility' not in body:
    return jsonify({"error": "Send `visibility`: public, internal, private, or null to inherit."}), 400
  try:
    previous = set_visibility(g.actor, project_id, body['visibility'])
  except AccessError as e:
    return access_error(e)
  audit('visibility.update', 'project', project_id, project_id, project_id=project_id,
        changes={"visibility": {"from": previous, "to": body['visibility']}})
  db_session.commit()
  changed()
  return jsonify({"project": project_id, "visibility": effective_visibility(project_id)})


@app.route('/api/v1/project/access/grants', methods=['POST'])
@app.route('/api/v1/project/access/grants/', methods=['POST'])
@login_required
def create_project_grant():
  from ..access.grants import parse_expiry
  body = request.get_json(silent=True) or {}
  project_id, error = project_param(body.get('project'))
  if error:
    return error
  if forbidden := may_manage(project_id):
    return forbidden
  try:
    expires_at = parse_expiry(body.get('expires_at'))
    grant, created = set_grant(g.actor, body.get('subject'), body.get('role'), 'project', project_id, expires_at)
  except AccessError as e:
    db_session.rollback()
    return access_error(e)
  db_session.flush()
  serialized = serialize_grant(grant, project_id)
  audit('grant.create' if created else 'grant.update', 'project', project_id, project_id, project_id=project_id,
        meta={"subject": serialized["subject"], "role": grant.role, "expires_at": serialized["expires_at"]})
  db_session.commit()
  changed()
  return jsonify(serialized), 201 if created else 200


@app.route('/api/v1/project/access/grants/<int:grant_id>', methods=['DELETE'])
@app.route('/api/v1/project/access/grants/<int:grant_id>/', methods=['DELETE'])
@login_required
def delete_project_grant(grant_id):
  from ..models import RoleGrant
  grant = RoleGrant.query.filter(RoleGrant.id == grant_id, RoleGrant.resource_type == 'project').one_or_none()
  if grant is None:
    return jsonify({"error": "This member doesn't exist."}), 404
  if forbidden := may_manage(grant.resource_id):
    return forbidden
  try:
    check_keeps_an_owner(grant, g.actor)
  except AccessError as e:
    return access_error(e)
  serialized = serialize_grant(grant, grant.resource_id)
  db_session.delete(grant)
  audit('grant.delete', 'project', grant.resource_id, grant.resource_id, project_id=grant.resource_id,
        meta={"subject": serialized["subject"], "role": serialized["role"]})
  db_session.commit()
  changed()
  return jsonify({"status": "OK"})


def project_exists(project_id) -> bool:
  """The project, or a prefix of projects (e.g. a GitLab group)"""
  from ..models import Project
  return Project.query.filter((Project.id == project_id) | Project.id.startswith(project_id + '/')).first() is not None


def managers_of(project_id) -> list:
  """The users to tell about a request: owners of the project (or groups of owners), else admins"""
  from ..models import User, GroupMember
  from ..sign_in.access import reviewers
  users = []
  for subject in owners(project_id, limit=50):
    if subject["type"] == "user":
      users += User.query.filter(User.id == subject["id"]).all()
    else:
      users += [m.user for m in GroupMember.query.filter(GroupMember.group_id == subject["id"]).all()]
  active = [u for u in users if u is not None and u.status == 'active']
  return active or reviewers()


@app.route('/api/v1/project/access/requests', methods=['POST'])
@app.route('/api/v1/project/access/requests/', methods=['POST'])
@authenticated
def request_project_access():
  from ..models import AccessRequest
  body = request.get_json(silent=True) or {}
  project_id, error = project_param(body.get('project'))
  if error:
    return error
  if not project_exists(project_id):
    return jsonify({"error": f"There is no project {project_id}."}), 404
  wanted = body.get('role')
  if wanted not in ROLES:
    return jsonify({"error": f"role is one of {', '.join(ROLES)}."}), 400
  user = g.actor.user
  role, _ = role_of(user, project_id)
  if LEVELS[role] >= LEVELS[wanted]:
    return jsonify({"error": f"You're already a {role} of {project_id}."}), 400
  message = body.get('message') if isinstance(body.get('message'), str) else ''
  existing = pending_requests(project_id, user.id)
  request_row = existing[0] if existing else AccessRequest(user_id=user.id, kind='project', resource_id=project_id, status='pending', created_at=utcnow())
  request_row.role, request_row.message = wanted, message.strip()[:2000]
  db_session.add(request_row)
  audit('access_request.create' if not existing else 'access_request.update', 'project', project_id, project_id, project_id=project_id,
        meta={"role": wanted})
  db_session.commit()
  who = f"{user.full_name} ({user.user_name})" if user.full_name else user.user_name
  text = (f"{who} asks for the {wanted} role on {project_id}." + (f"\nTheir message: {request_row.message}" if request_row.message else '')
          + f"\nApprove or deny: {public_url()}/{project_id}/access")
  notify(text, subject=f"QA-Board: {who} asks for access to {project_id}", to_users=managers_of(project_id))
  return jsonify(serialize_request(request_row)), 201 if not existing else 200


@app.route('/api/v1/project/access/requests/<int:request_id>', methods=['POST'])
@app.route('/api/v1/project/access/requests/<int:request_id>/', methods=['POST'])
@login_required
def decide_project_access(request_id):
  from ..models import AccessRequest
  request_row = AccessRequest.query.filter(AccessRequest.id == request_id, AccessRequest.kind == 'project').one_or_none()
  if request_row is None:
    return jsonify({"error": "This request doesn't exist."}), 404
  if forbidden := may_manage(request_row.resource_id):
    return forbidden
  if request_row.status != 'pending':
    return jsonify({"error": f"This request was already {request_row.status}."}), 400
  body = request.get_json(silent=True) or {}
  decision = body.get('decision')
  if decision not in ('approve', 'deny'):
    return jsonify({"error": "decision is approve or deny."}), 400
  project_id = request_row.resource_id
  if decision == 'approve':
    role = body.get('role') or request_row.role
    try:
      grant, _ = set_grant(g.actor, {"type": "user", "id": request_row.user_id}, role, 'project', project_id, source='request')
    except AccessError as e:
      db_session.rollback()
      return access_error(e)
    request_row.role = grant.role
  request_row.status = 'approved' if decision == 'approve' else 'denied'
  request_row.decided_at = utcnow()
  request_row.decided_by_id = g.actor.user.id
  audit(f'access_request.{request_row.status}', 'project', project_id, project_id, project_id=project_id,
        meta={"user": request_row.user.user_name if request_row.user else None, "role": request_row.role})
  db_session.commit()
  changed()
  if request_row.status == 'approved':
    text = f"You're now a {request_row.role} of {project_id} in QA-Board: {public_url()}/{project_id}"
  else:
    text = f"Your request for the {request_row.role} role on {project_id} was denied. Ask its owners if you think it's a mistake."
  notify(text, subject=f"QA-Board: your access to {project_id}", to_user=request_row.user)
  return jsonify(serialize_request(request_row))


@app.route('/api/v1/directory', methods=['GET'])
@app.route('/api/v1/directory/', methods=['GET'])
@login_required
def directory():
  """Users and groups, for the member pickers"""
  from ..models import User, Group
  from ..search import escape_like
  from sqlalchemy import or_
  q = (request.args.get('q') or '').strip()[:100]
  if not q:
    return jsonify({"users": [], "groups": []})
  pattern = f"%{escape_like(q)}%"
  users = (User.query
           .filter(User.status == 'active')
           # a project's service accounts can't reach other projects: no need to offer them
           .filter(or_(User.owner_type.is_(None), User.owner_type != 'project'))
           .filter(User.user_name.ilike(pattern, escape='\\') | User.full_name.ilike(pattern, escape='\\') | User.email.ilike(pattern, escape='\\'))
           .order_by(User.user_name).limit(10).all())
  groups = Group.query.filter(Group.name.ilike(pattern, escape='\\')).order_by(Group.name).limit(10).all()
  return jsonify({
    "users": [{"id": u.id, "user_name": u.user_name, "full_name": u.full_name, "kind": u.kind} for u in users],
    "groups": [{"id": group.id, "name": group.name, "description": group.description} for group in groups],
  })

