"""
The file browser's API, and who can read files under /s/.

nginx serves the files (services/nginx/snippets/qaboard-files.conf). It asks us:
- for folder listings: when the file browser asks for /s/some/folder/ with "Accept: application/json"
- whether the user can read a file, with auth_request, if the deployment enables it (snippets/qaboard-files-auth.conf)

Files are restricted with QABOARD_LOGIN_RESTRICTED_YAML:
- "projects": the outputs and artifacts folders of the restricted projects, from their storage settings in qaboard.yaml
- "paths" (optional): any folder, e.g. "/algo/secret: {user_name: [john.doe]}"
The most specific folder decides. Its rules are the same as for projects, and with empty rules anyone can read it.
And in the folders listed in QABOARD_FILES_UNIX_PERMISSIONS (e.g. /home), users only read what their Unix account can read.
"""
import os
import time

from flask import request, jsonify

from backend import app
from ..models import Project
from ..config import files_unix_permissions_roots
from ..files import normalize, path_from_url, is_listable, longest_prefix, list_directory, unix_account, unix_can_read
from .auth import get_current_user, restrictions, restricted_project_key, matches_rules


# The projects (and their storage settings) change rarely, we don't want a database query for each file
PROJECT_DIRS_TTL = 300 # seconds
_project_dirs = {"expires": 0.0, "dirs": {}}


def restricted_project_dirs() -> dict:
  """{folder: project key in QABOARD_LOGIN_RESTRICTED_YAML} for the outputs and artifacts of restricted projects."""
  if not restrictions('projects'):
    return {}
  now = time.monotonic()
  if now < _project_dirs["expires"]:
    return _project_dirs["dirs"]
  dirs = {}
  for project in Project.query.all():
    key = restricted_project_key(project.id)
    if key is None:
      continue
    try:
      roots = project.storage_roots()
    except Exception as e:
      print(f"[files] Could not get the storage of {project.id}: {e}")
      continue
    # Sub-projects share the storage of their git repository: restricting one restricts the whole repository
    for kind in ('outputs', 'artifacts'):
      if roots[kind].is_absolute():
        dirs.setdefault(normalize(str(roots[kind])), key)
  _project_dirs.update(expires=now + PROJECT_DIRS_TTL, dirs=dirs)
  return dirs


def file_restriction(path: str):
  """The restriction that applies to a path: (description, rules), None if anyone can read it."""
  rules = {}
  for prefix, perms_data in restrictions('paths').items():
    rules[normalize(prefix)] = (f"the folder {prefix}", perms_data)
  projects = restrictions('projects')
  for folder, key in restricted_project_dirs().items():
    rules.setdefault(folder, (f"the project {key}", projects[key]))
  restriction = longest_prefix(path, rules)
  if restriction is None or not restriction[1]:
    return None
  return restriction


def check_read_access(path: str):
  """None if the current user can read the path, else an error response."""
  if not restrictions('paths') and not restrictions('projects') and not files_unix_permissions_roots:
    return None
  # Through symlinks users could reach restricted files from public folders
  real_path = os.path.realpath(path)
  applicable = [r for r in (file_restriction(path), file_restriction(real_path)) if r]
  unix_root = longest_prefix(real_path, {root: root for root in files_unix_permissions_roots})
  if not applicable and not unix_root:
    return None

  user_info = get_current_user(to_jsonify=False)
  is_authenticated = bool(user_info.get('is_authenticated'))
  if unix_root:
    account = unix_account(user_info.get('user_name') if is_authenticated else None)
    if not unix_can_read(real_path, unix_root, account):
      if not is_authenticated:
        return jsonify({"error": "These files are private. Sign in to see the files your account can read.", "reason": "login"}), 401
      return jsonify({"error": f"Your account ({user_info.get('user_name')}) doesn't have the permissions to read these files.", "reason": "forbidden"}), 403
  for description, perms_data in applicable:
    if not is_authenticated:
      return jsonify({"error": f"Only some users can see {description}. Sign in to see these files.", "reason": "login"}), 401
    if not matches_rules(user_info, perms_data):
      return jsonify({"error": f"Only some users can see {description}.", "reason": "forbidden"}), 403
  return None


@app.route('/api/v1/files/authorize')
def authorize_files():
  """
  Whether the user can read a file: 204 if yes, else 401 (sign in) or 403.
  nginx asks before serving files (auth_request), with the original URL in QABOARD_ORIGINAL_URI.
  Others can ask with ?path=/algo/some/file
  """
  original_uri = request.environ.get('QABOARD_ORIGINAL_URI')
  if original_uri:
    path = path_from_url(original_uri)
    if path is None:
      return '', 204
  else:
    path = request.args.get('path')
    if not path:
      return jsonify({"error": "Missing ?path="}), 400
    path = normalize(path)
  denied = check_read_access(path)
  return denied if denied else ('', 204)


@app.route('/s/')
@app.route('/s/<path:url_path>')
def list_files(url_path=''):
  """
  The content of a folder, as JSON. nginx sends us /s/some/folder/ when browsers ask for JSON.
  """
  path = normalize(url_path)
  denied = check_read_access(path)
  if denied:
    return denied
  if not is_listable(path):
    return jsonify({"error": "QA-Board only lists the folders in its storage ($QABOARD_STORAGE_ROOTS).", "reason": "not-listable"}), 403
  try:
    listing = list_directory(path)
  except (FileNotFoundError, NotADirectoryError):
    return jsonify({"error": f"{path} is not a folder, or it doesn't exist (anymore?).", "reason": "not-found"}), 404
  except PermissionError:
    return jsonify({"error": f"The QA-Board server doesn't have the permissions to read {path}.", "reason": "permissions"}), 403
  response = jsonify(listing)
  response.headers['Cache-Control'] = 'no-cache'
  return response
