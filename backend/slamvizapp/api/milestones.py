"""
CRUD operations for project milestones.
"""
from flask import request, jsonify
from slamvizapp import app, db_session
from sqlalchemy.orm.attributes import flag_modified

from ..models import Project


@app.route("/api/v1/project/milestones", methods=['GET', 'POST', 'DELETE'])
@app.route("/api/v1/project/milestones/", methods=['GET', 'POST', 'DELETE'])
def crud_milestones():
  data = request.get_json()
  project_id = data['project']
  try:
    project = Project.query.filter(Project.id == project_id).one()
  except:
    return f'ERROR: Project not found', 404
  milestones = project.data.get('milestones', {})
  
  if request.method == 'GET':
    return jsonify(milestones)

  # The body for HTTP DELETE requests can be dropped by proxies (eg uwsgi, nginx...)
  # so it's simpler to reuse the POST method...
  if request.method=='DELETE' or data.get('delete') in ['true', True]:
    del milestones[data['key']]
  else:
    milestones[data['key']] = data['milestone']

  project.data['milestones'] = milestones
  flag_modified(project, "data")
  db_session.add(project)
  db_session.commit()
  print(f"UPDATE: Milestones {project_id}: {project.data['milestones']}")
  return jsonify(project.data['milestones'])
