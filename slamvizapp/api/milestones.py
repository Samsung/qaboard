"""
Save Load and Remove milestones of batches
"""

from flask import request, jsonify

from slamvizapp import app, db_session
from sqlalchemy.orm.attributes import flag_modified
from ..models import Project, CiCommit, Batch, Output

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
  try:
    project_id = request.args.get('project')
    project = (Project.query.filter(Project.id == project_id).one())

    return project.data['milestones']

  except:
    return 'FAILED'


@app.route("/api/v1/project/milestones/save", methods=[ 'POST'])
def save_milestone():

  data = request.get_json()
  project_id = (data['project'])
  project = (Project.query.filter(Project.id == project_id).one())

  milestones = project.data['milestones']
  key = f"{data['commit']}/{data['batch']}" # CONVENTION
  data.pop('project')
  milestones[key] = data

  project.data.update({'milestones': milestones})
  #print("milestones: ", project.data['milestones'])

  db_session.add(project)
  flag_modified(project, "data")
  db_session.commit()

  return project.data['milestones']


@app.route("/api/v1/project/milestones/remove", methods=['POST'])
def remove_milestone():

  data = request.get_json()
  project_id = (data['project'])
  project = (Project.query.filter(Project.id == project_id).one())

  milestones = project.data['milestones']
  print("milestones: ", milestones)

  key = f"{data['commit']}/{data['batch']}" # CONVENTION
  milestones.pop(key)
  print("milestones: ", milestones)

  project.data.update({'milestones': milestones})
  print("milestones: ", project.data['milestones'])

  db_session.add(project)
  flag_modified(project, "data")
  db_session.commit()

  return project.data['milestones']




'''
@app.route("/api/v1/project/milestones/load", methods=['GET', 'POST'])
def load_milestone():
  data = request.get_json()
  # print(data)
  return data

@app.route("/api/v1/project/milestones/is_exist", methods=['GET', 'POST'])
def is_milestone_exist():
  data = request.get_json()
  # print(data)
  return data
'''