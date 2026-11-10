"""
A project's settings, from its Admin pages (docs/rfcs/project-admin.md): the quality gate's project rules.
Reading needs project.read: the rules a project is held to are not a secret for those who see its results.
Changing them needs project.access, like its Access page: owners, and the server's admins.
"""
from flask import request, jsonify, g

from backend import app, db_session
from ..audit import audit
from ..access import authorize, can, denied
from ..project_settings import SettingsError, clean_gate, describe_yaml_gate, gate_changes, get_settings, save_gate
from .access import project_param, may_manage
from .auth import login_required


def reference_gate(project_id):
  """The gate of the project's qaboard.yaml, as its reference branch last sent it"""
  from ..models import Project
  project = db_session.get(Project, project_id)
  config = (project.data or {}).get('qatools_config') if project is not None else None
  described = describe_yaml_gate(config)
  reference_branch = ((config or {}).get('project') or {}).get('reference_branch') if isinstance(config, dict) else None
  return {**described, 'branch': reference_branch or 'master', 'exists': project is not None}


def serialize(project_id):
  settings = get_settings(db_session, project_id)
  data = (settings.data or {}) if settings is not None else {}
  updated = (settings.updated or {}) if settings is not None else {}
  gate_updated = updated.get('gate')
  return {
    "project": project_id,
    "can_manage": can('project.access', project_id),
    "gate": data.get('gate'),
    "gate_updated": {"at": gate_updated.get('at'), "by": gate_updated.get('by')} if isinstance(gate_updated, dict) else None,
    "reference": reference_gate(project_id),
  }


@app.route('/api/v1/project/settings', methods=['GET'])
@app.route('/api/v1/project/settings/', methods=['GET'])
def project_settings():
  project_id, error = project_param(request.args.get('project'))
  if error:
    return error
  decision = authorize(g.actor, 'project.read', project_id)
  if not decision.allowed:
    return denied(decision)
  return jsonify(serialize(project_id))


@app.route('/api/v1/project/settings/gate', methods=['POST'])
@app.route('/api/v1/project/settings/gate/', methods=['POST'])
@login_required
def set_project_gate():
  body = request.get_json(silent=True) or {}
  project_id, error = project_param(body.get('project'))
  if error:
    return error
  if forbidden := may_manage(project_id):
    return forbidden
  if 'gate' not in body:
    return jsonify({"error": "`gate` is required: the settings, or null to remove them"}), 400
  try:
    gate = clean_gate(body['gate'])
  except SettingsError as e:
    return jsonify({"error": str(e)}), 400
  before, after = save_gate(db_session, project_id, gate, user=g.actor.user)
  changes = gate_changes(before, after)
  if changes:
    audit('project_settings.update', 'project', project_id, project_id, project_id=project_id, changes=changes, meta={"section": "gate"})
  db_session.commit()
  return jsonify(serialize(project_id))
