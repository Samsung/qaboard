"""
CRUD operations for project milestones.
"""
from flask import request, jsonify
from sqlalchemy.orm.attributes import flag_modified

from backend import app, db_session
from backend.models import Project
from .auth import get_current_user

# Note: this endpoint supports GET, but in practice is used only with POST, DELETE
# Getting milestones data is done by GET "/api/v1/projects" endpoint (backend/backend/api/api.py, get_projects)

@app.route("/api/v1/project/milestones", methods=['GET', 'POST', 'DELETE'])
@app.route("/api/v1/project/milestones/", methods=['GET', 'POST', 'DELETE'])
def crud_milestones():  
  # Query project milestones
  data = request.get_json()
  project_id = data['project']
  try:
    project = Project.query.filter(Project.id == project_id).one()
  except:
    return jsonify({"error": "Project not found"}), 404
  
  milestones = project.data.get('milestones', {})
  if request.method == 'GET':
    return jsonify(milestones)
  
  # Authentication is required for any milestones CRUD request (except GET)
  user_info = get_current_user(to_jsonify=False)
  user_name = user_info.get('user_name')
  if not user_info.get('is_authenticated') or not user_name:
    return jsonify({"error": "Authentication required"}), 401

  # Extract milestone owners and their user name
  milestone_key = data.get('key', '')
  existing_milestone = milestones.get(milestone_key, {})
  milestone_owners = existing_milestone.get('owners', [])
  owner_usernames = [o.get('user_name') for o in milestone_owners]

  # Check ownership for edit/delete operations. When no owners, any authenticated user is allowed to edit / delete the milestone
  if owner_usernames:
    # Prevent milestone edit or delete if it has owners and current user isn't one of them
    if user_name not in owner_usernames:
      return jsonify({"error": "You can only edit or delete your own milestones"}), 403
  
  # The body for HTTP DELETE requests can be dropped by proxies (eg uwsgi, nginx...)
  # so it's simpler to reuse the POST method...  
  if request.method == 'DELETE' or data.get('delete') in ['true', True]:
    del milestones[data['key']]
  # Future TODO: explicitly handle POST request and unknown request. This branch handles POST (without a 'delete' property)
  else:
    # Add current user to owners list if not already present
    if user_name not in owner_usernames:
      milestone_owners.append({
        'user_name': user_name,
        'full_name': user_info.get('full_name'),
      })
    
    milestone_data = dict(data['milestone'])
    milestone_data['owners'] = milestone_owners
    milestones[data['key']] = milestone_data

  # Update milestones in DB
  project.data['milestones'] = milestones
  flag_modified(project, "data")
  db_session.add(project)
  db_session.commit()
  print(f"UPDATE: Milestones {project_id}: {project.data['milestones']}")
  return jsonify(milestones)
