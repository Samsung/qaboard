"""
CRUD operations for project milestones.
"""
from flask import request
from slamvizapp import app, db_session
from sqlalchemy.orm.attributes import flag_modified

from ..models import Project


@app.route("/api/v1/project/milestones", methods=['GET', 'POST', 'DELETE'])
@app.route("/api/v1/project/milestones/", methods=['GET', 'POST', 'DELETE'])
def crud_milestones():
  project_id = request.args['project']
  try:
    project = Project.query.filter(Project.id == project_id).one()
  except:
    return f'ERROR: Project not found', 404
  milestones = project.data.get('milestones', {})
  
  if method == 'GET':
    return milestones

  data = request.get_json()
  # The body for HTTP DELETE requests can be dropped by proxies (eg uwsgi, nginx...)
  # so it's simpler to reuse the POST method...
  if method=='DELETE' or data['delete']:
    milestones[data['key']] = data['milestone']
  else:
    milestones = project.data['milestones']
    del milestones[data['key']]

  project.data['milestones'] = milestones
  flag_modified(project, "data")
  db_session.add(project)
  db_session.commit()
  print(f"UPDATE: Milestones {project_id}: {project.data['milestones']}")
  return project.data['milestones']
