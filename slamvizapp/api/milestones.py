"""
Save Load and Remove milestones of batches in DB
"""

from flask import request, jsonify
from slamvizapp import app, db_session
from sqlalchemy.orm.attributes import flag_modified
from ..models import Project

'''
@app.route("/api/v1/project/milestones", methods=['GET', 'POST', 'DELETE', 'PUT'])
def crud_milestones():
  if method=='GET':
    pass
  if method=='POST':
    pass
  if method=='PUT':
    pass
'''


@app.route("/api/v1/project/milestones/get", methods=['GET'])
def get_milestones():
  project_id = request.args.get('project')
  try:
    project = Project.query.filter(Project.id == project_id).one()
  except:
    return 'Not found', 404
  if 'milestones' in project.data:
    return project.data['milestones']
  else:
    return {}


@app.route("/api/v1/project/milestones/save", methods=[ 'POST'])
def save_milestone():
  data = request.get_json()
  project = Project.query.filter(Project.id == data['project']).one()

  milestones = project.data['milestones']
  key = data['key']
  data.pop('project','key') # remove items we don't need to save.
  milestones[key] = data
  project.data.update({'milestones': milestones})
  #print("milestones: ", project.data['milestones'])

  flag_modified(project, "data")
  db_session.add(project)
  db_session.commit()

  return project.data['milestones']


@app.route("/api/v1/project/milestones/remove", methods=['POST'])
def remove_milestone():
  data = request.get_json()
  project = Project.query.filter(Project.id == data['project']).one()

  milestones = project.data['milestones']

  key = data['key']
  milestones.pop(key)

  project.data.update({'milestones': milestones})

  db_session.add(project)
  flag_modified(project, "data")
  db_session.commit()

  return project.data['milestones']
