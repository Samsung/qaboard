"""
The admin panel's groups (members and the sign-in rules that fill them) and roles on all projects (Appendix D.5).
"""
from flask import request, jsonify, g

from backend import app, db_session
from ..audit import audit
from ..access.grants import AccessError, set_grant, serialize as serialize_grant, changed
from ..tokens import iso, utcnow
from .auth import admin_required


def access_error(e: AccessError):
  return jsonify({"error": e.message}), e.status


def serialize_group(group, members=None, rules=None) -> dict:
  from ..models import GroupMember, GroupRule
  body = {
    "id": group.id, "name": group.name, "description": group.description, "created_at": iso(group.created_at),
    "member_count": GroupMember.query.filter(GroupMember.group_id == group.id).count(),
    "rule_count": GroupRule.query.filter(GroupRule.group_id == group.id).count(),
  }
  if members is not None:
    body["members"] = [{
      "user": {"id": m.user.id, "user_name": m.user.user_name, "full_name": m.user.full_name, "email": m.user.email} if m.user else None,
      "source": m.source, "added_at": iso(m.added_at),
    } for m in members]
  if rules is not None:
    body["rules"] = [{"id": r.id, "provider_id": r.provider_id, "claim": r.claim, "values": r.values, "created_at": iso(r.created_at)} for r in rules]
  return body


def get_group(group_id):
  from ..models import Group
  group = Group.query.filter(Group.id == group_id).one_or_none()
  return group, (None if group else (jsonify({"error": "This group doesn't exist."}), 404))


def clean_name(value):
  name = value.strip() if isinstance(value, str) else ''
  if not name or len(name) > 100:
    return None
  return name


@app.route('/api/v1/admin/groups', methods=['GET', 'POST'])
@app.route('/api/v1/admin/groups/', methods=['GET', 'POST'])
@admin_required
def admin_groups():
  from ..models import Group
  if request.method == 'GET':
    return jsonify({"groups": [serialize_group(group) for group in Group.query.order_by(Group.name).all()]})
  body = request.get_json(silent=True) or {}
  name = clean_name(body.get('name'))
  if not name:
    return jsonify({"error": "Name the group, e.g. camera-team."}), 400
  if Group.query.filter(Group.name.ilike(name)).one_or_none():
    return jsonify({"error": f"There is already a group {name}."}), 409
  group = Group(name=name, description=(body.get('description') or '').strip()[:1000], created_at=utcnow())
  db_session.add(group)
  db_session.flush()
  audit('group.create', 'group', group.id, group.name)
  db_session.commit()
  return jsonify(serialize_group(group, [], [])), 201


@app.route('/api/v1/admin/groups/<int:group_id>', methods=['GET', 'POST', 'DELETE'])
@app.route('/api/v1/admin/groups/<int:group_id>/', methods=['GET', 'POST', 'DELETE'])
@admin_required
def admin_group(group_id):
  from ..models import Group, GroupMember, GroupRule, RoleGrant
  group, error = get_group(group_id)
  if error:
    return error
  if request.method == 'DELETE':
    # its grants go with it
    grants = RoleGrant.query.filter(RoleGrant.subject_type == 'group', RoleGrant.subject_id == group.id).all()
    for grant in grants:
      db_session.delete(grant)
    db_session.delete(group)
    audit('group.delete', 'group', group.id, group.name, meta={"grants": len(grants)})
    db_session.commit()
    changed()
    return jsonify({"status": "OK"})
  if request.method == 'POST':
    body = request.get_json(silent=True) or {}
    before = {"name": group.name, "description": group.description}
    if 'name' in body:
      name = clean_name(body['name'])
      if not name:
        return jsonify({"error": "Name the group, e.g. camera-team."}), 400
      if Group.query.filter(Group.name.ilike(name), Group.id != group.id).one_or_none():
        return jsonify({"error": f"There is already a group {name}."}), 409
      group.name = name
    if 'description' in body:
      group.description = (body.get('description') or '').strip()[:1000]
    audit('group.update', 'group', group.id, group.name, changes={k: {"from": v, "to": getattr(group, k)} for k, v in before.items() if getattr(group, k) != v})
    db_session.commit()
  members = GroupMember.query.filter(GroupMember.group_id == group.id).order_by(GroupMember.added_at).all()
  rules = GroupRule.query.filter(GroupRule.group_id == group.id).order_by(GroupRule.id).all()
  return jsonify(serialize_group(group, members, rules))


@app.route('/api/v1/admin/groups/<int:group_id>/members', methods=['POST'])
@app.route('/api/v1/admin/groups/<int:group_id>/members/', methods=['POST'])
@admin_required
def admin_add_group_member(group_id):
  from ..models import GroupMember, User
  group, error = get_group(group_id)
  if error:
    return error
  body = request.get_json(silent=True) or {}
  try:
    user = User.query.filter(User.id == int(body.get('user_id'))).one_or_none()
  except (TypeError, ValueError):
    user = None
  if user is None:
    return jsonify({"error": "Which user? Send `user_id`."}), 400
  member = GroupMember.query.filter(GroupMember.group_id == group.id, GroupMember.user_id == user.id).one_or_none()
  if member is None:
    member = GroupMember(group_id=group.id, user_id=user.id, added_at=utcnow())
    db_session.add(member)
  # an admin's choice: the next sign-in won't remove them
  member.source, member.added_by_id = 'manual', g.actor.user.id
  audit('group_member.add', 'group', group.id, group.name, meta={"user": user.user_name})
  db_session.commit()
  changed()
  return jsonify({"status": "OK"}), 201


@app.route('/api/v1/admin/groups/<int:group_id>/members/<int:user_id>', methods=['DELETE'])
@app.route('/api/v1/admin/groups/<int:group_id>/members/<int:user_id>/', methods=['DELETE'])
@admin_required
def admin_remove_group_member(group_id, user_id):
  from ..models import GroupMember
  group, error = get_group(group_id)
  if error:
    return error
  member = GroupMember.query.filter(GroupMember.group_id == group.id, GroupMember.user_id == user_id).one_or_none()
  if member is None:
    return jsonify({"error": "This user isn't in the group."}), 404
  user_name = member.user.user_name if member.user else user_id
  db_session.delete(member)
  audit('group_member.remove', 'group', group.id, group.name, meta={"user": user_name, "source": member.source})
  db_session.commit()
  changed()
  # rules add users back at their next sign-in
  return jsonify({"status": "OK"})


@app.route('/api/v1/admin/groups/<int:group_id>/rules', methods=['POST'])
@app.route('/api/v1/admin/groups/<int:group_id>/rules/', methods=['POST'])
@admin_required
def admin_add_group_rule(group_id):
  from ..models import GroupRule
  from ..sign_in import providers
  group, error = get_group(group_id)
  if error:
    return error
  body = request.get_json(silent=True) or {}
  claim = body.get('claim').strip() if isinstance(body.get('claim'), str) else ''
  values = body.get('values')
  if isinstance(values, str):
    values = [v.strip() for v in values.split(',')]
  if not claim or len(claim) > 200:
    return jsonify({"error": "Which claim? e.g. groups, memberOf or email_domain."}), 400
  if not isinstance(values, list) or not [v for v in values if isinstance(v, str) and v.strip()]:
    return jsonify({"error": "Which values? e.g. [\"camera-team\"]."}), 400
  provider_id = body.get('provider_id') or None
  if provider_id is not None and providers.get(provider_id) is None:
    return jsonify({"error": f"There is no sign-in method {provider_id}."}), 400
  rule = GroupRule(group_id=group.id, provider_id=provider_id, claim=claim, values=[v.strip() for v in values if isinstance(v, str) and v.strip()][:100], created_at=utcnow())
  db_session.add(rule)
  db_session.flush()
  audit('group_rule.create', 'group', group.id, group.name, meta={"provider": provider_id, "claim": claim, "values": rule.values})
  db_session.commit()
  return jsonify({"id": rule.id, "provider_id": rule.provider_id, "claim": rule.claim, "values": rule.values, "created_at": iso(rule.created_at)}), 201


@app.route('/api/v1/admin/groups/<int:group_id>/rules/<int:rule_id>', methods=['DELETE'])
@app.route('/api/v1/admin/groups/<int:group_id>/rules/<int:rule_id>/', methods=['DELETE'])
@admin_required
def admin_delete_group_rule(group_id, rule_id):
  from ..models import GroupRule
  group, error = get_group(group_id)
  if error:
    return error
  rule = GroupRule.query.filter(GroupRule.id == rule_id, GroupRule.group_id == group.id).one_or_none()
  if rule is None:
    return jsonify({"error": "This rule doesn't exist."}), 404
  db_session.delete(rule)
  audit('group_rule.delete', 'group', group.id, group.name, meta={"claim": rule.claim, "values": rule.values})
  db_session.commit()
  # members it added leave at their next sign-in
  return jsonify({"status": "OK"})


@app.route('/api/v1/admin/grants', methods=['GET', 'POST'])
@app.route('/api/v1/admin/grants/', methods=['GET', 'POST'])
@admin_required
def admin_grants():
  """Roles on all projects (resource_type=instance), or every project grant (resource_type=project)"""
  from ..models import RoleGrant
  if request.method == 'GET':
    resource_type = request.args.get('resource_type', 'instance')
    if resource_type not in ('instance', 'project'):
      return jsonify({"error": "resource_type is instance or project."}), 400
    rows = RoleGrant.query.filter(RoleGrant.resource_type == resource_type).order_by(RoleGrant.resource_id, RoleGrant.id).limit(1000).all()
    return jsonify({"grants": [serialize_grant(grant) for grant in rows]})
  body = request.get_json(silent=True) or {}
  try:
    grant, created = set_grant(g.actor, body.get('subject'), body.get('role'), 'instance', '')
  except AccessError as e:
    db_session.rollback()
    return access_error(e)
  db_session.flush()
  serialized = serialize_grant(grant)
  audit('grant.create' if created else 'grant.update', 'instance', None, "all projects", meta={"subject": serialized["subject"], "role": grant.role})
  db_session.commit()
  changed()
  return jsonify(serialized), 201 if created else 200


@app.route('/api/v1/admin/grants/<int:grant_id>', methods=['DELETE'])
@app.route('/api/v1/admin/grants/<int:grant_id>/', methods=['DELETE'])
@admin_required
def admin_delete_grant(grant_id):
  from ..models import RoleGrant
  grant = RoleGrant.query.filter(RoleGrant.id == grant_id).one_or_none()
  if grant is None:
    return jsonify({"error": "This grant doesn't exist."}), 404
  serialized = serialize_grant(grant)
  db_session.delete(grant)
  audit('grant.delete', grant.resource_type, grant.resource_id or None, grant.resource_id or "all projects",
        project_id=grant.resource_id or None, meta={"subject": serialized["subject"], "role": grant.role})
  db_session.commit()
  changed()
  return jsonify({"status": "OK"})
