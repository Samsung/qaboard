"""
The file browser's API, and who can read files under /s/.

nginx serves the files (services/nginx/snippets/qaboard-files.conf). It asks us:
- for folder listings: when the file browser asks for /s/some/folder/ with "Accept: application/json"
- whether the user can read a file, with auth_request, if the deployment enables it (snippets/qaboard-files-auth.conf)
The file browser also asks which run a folder belongs to, to redo or delete it (with the outputs API).

Who can read files:
- the outputs and artifacts folders of projects (from their storage settings in qaboard.yaml): whoever can see the
  projects stored there (backend/access/: visibility, roles, QABOARD_LOGIN_RESTRICTED_YAML's projects), with tokens'
  project restrictions
- QABOARD_LOGIN_RESTRICTED_YAML's "paths" (optional): any folder, e.g. "/algo/secret: {user_name: [john.doe]}",
  with the same rules as the YAML's projects; with empty rules anyone can read it.
The most specific folder decides.
And in the folders listed in QABOARD_FILES_UNIX_PERMISSIONS (e.g. /home), users only read what their Unix account can read.
"""
import os
import time
from pathlib import Path
from urllib.parse import quote, urlencode

from flask import request, jsonify

from backend import app
from ..models import Project, Output
from ..config import files_unix_permissions_roots
from ..files import normalize, path_from_url, is_listable, longest_prefix, folder_for, folder_and_parents, list_directory, unix_account, unix_can_read, USER_PLACEHOLDER
from .auth import get_current_user, restrictions, matches_rules, is_authorized_user
from ..access import authorize, current_actor, effective_visibility
from ..settings import setting


# The projects (and their storage settings) change rarely, we don't want a database query for each file
PROJECT_DIRS_TTL = 300 # seconds
_project_dirs = {"expires": 0.0, "dirs": {}}


def invalidate_project_dirs():
  _project_dirs["expires"] = 0.0


def project_dirs() -> dict:
  """
  {folder: {project ids}} for the outputs and artifacts of every project.
  Storage settings often have a folder per user (e.g. /algo/outputs/{user}): those folders keep {user}, see folder_for.
  Sub-projects share the storage of their git repository: a folder lists all the projects stored there.
  """
  now = time.monotonic()
  if now < _project_dirs["expires"]:
    return _project_dirs["dirs"]
  dirs = {}
  for project in Project.query.all():
    try:
      roots = project.storage_roots(user_name=USER_PLACEHOLDER)
    except Exception as e:
      print(f"[files] Could not get the storage of {project.id}: {e}")
      continue
    for kind in ('outputs', 'artifacts'):
      if roots[kind].is_absolute():
        dirs.setdefault(normalize(str(roots[kind])), set()).add(project.id)
  _project_dirs.update(expires=now + PROJECT_DIRS_TTL, dirs=dirs)
  return dirs


def file_restriction(path: str):
  """
  What decides who can read a path: ("paths", description, rules) from QABOARD_LOGIN_RESTRICTED_YAML,
  ("projects", description, project ids) for the storage of projects, or None if anyone can read it.
  The most specific folder decides; with equal folders, the YAML's paths win.
  """
  rules = {}
  for prefix, perms_data in restrictions('paths').items():
    rules[normalize(prefix)] = ("paths", f"the folder {prefix}", perms_data)
  for pattern, project_ids in project_dirs().items():
    folder = folder_for(pattern, path)
    if folder:
      rules.setdefault(folder, ("projects", f"the project {sorted(project_ids)[0]}", project_ids))
  restriction = longest_prefix(path, rules)
  if restriction is None or not restriction[2]:
    return None
  return restriction


def check_read_access(path: str):
  """None if the current user can read the path, else an error response."""
  if setting('auth.require_sign_in') and not get_current_user(to_jsonify=False).get('is_authenticated'):
    return jsonify({"error": "Sign in to see these files.", "reason": "login"}), 401
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
        return jsonify({"error": "These files are private. Log in to see the files your account can read.", "reason": "login"}), 401
      return jsonify({"error": f"Your account ({user_info.get('user_name')}) doesn't have the permissions to read these files.", "reason": "forbidden"}), 403
  for kind, description, rules in applicable:
    if kind == "projects":
      # project roles (backend/access/), and tokens' projects. Folders shared by sub-projects: all of them.
      actor = current_actor()
      for project_id in sorted(rules):
        # nginx asks for each file: public projects don't need the user's grants
        if (actor is None or actor.token is None) and effective_visibility(project_id)['effective'] == 'public':
          continue
        decision = authorize(actor, 'project.read', project_id)
        if decision.allowed:
          continue
        if decision.reason == 'sign_in_required':
          return jsonify({"error": f"Only some users can see the project {project_id}. Log in to see these files.", "reason": "login"}), 401
        return jsonify({"error": f"Only some users can see the project {project_id}.", "reason": "forbidden", "project": project_id}), 403
      continue
    if not is_authenticated:
      return jsonify({"error": f"Only some users can see {description}. Log in to see these files.", "reason": "login"}), 401
    if not matches_rules(user_info, rules):
      return jsonify({"error": f"Only some users can see {description}.", "reason": "forbidden"}), 403
  return None


def readable_file(url, *parts):
  """
  For the API endpoints that read files the client names, like the image and video viewers': (path, None) if the
  current user can read the file `url` (/s/some/folder, then the `parts` under it), else (None, an error response).
  Like the file browser: only files in the storage ($QABOARD_STORAGE_ROOTS), not the server's own, and with the
  access rules of QABOARD_LOGIN_RESTRICTED_YAML. Paths are normalized first: ".." can't leave the storage.
  """
  if not url or not isinstance(url, str) or not all(isinstance(part, str) and part for part in parts):
    return None, (jsonify({"error": "Which file? Its URL is missing"}), 400)
  path = path_from_url("/".join([url.rstrip("/"), *parts]))
  if path is None:
    return None, (jsonify({"error": "File URLs start with /s/"}), 400)
  if not is_listable(path):
    return None, (jsonify({"error": "QA-Board only reads the files in its storage ($QABOARD_STORAGE_ROOTS).", "reason": "not-listable"}), 403)
  denied = check_read_access(path)
  if denied:
    return None, denied
  return Path(path), None


@app.route('/api/v1/files/authorize')
def authorize_files():
  """
  Whether the user can read a file: 204 if yes, else 401 (log in) or 403.
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


def describe_run(output) -> dict:
  """What the file browser shows about a run, and the link to its results in QA-Board"""
  batch = output.batch
  ci_commit = batch.ci_commit
  project_id = ci_commit.project_id
  input_path = str(output.test_input.path)
  params = {"batch": batch.label} if batch.label != 'default' else {}
  params.update({"filter": input_path, "selected_views": "logs"})
  return {
    "id": output.id,
    "folder": normalize(output.output_dir_override),
    "is_failed": bool(output.is_failed),
    "is_pending": bool(output.is_pending),
    "is_running": bool(output.is_running),
    "deleted": bool(output.deleted),
    "input": input_path,
    "platform": output.platform,
    "configurations": output.configurations,
    "user": (output.data or {}).get('user'),
    "project": project_id,
    "commit": ci_commit.hexsha,
    "batch": batch.label,
    "url": f"/{quote(project_id)}/commit/{ci_commit.hexsha}?{urlencode(params)}",
  }


@app.route('/api/v1/files/run')
def run_of_folder():
  """
  The run whose output folder is ?path=, or contains it, for the file browser's run actions: {"run": {...}}.
  {"run": null} if it's not in a run's folder.
  """
  path = request.args.get('path')
  if not path:
    return jsonify({"error": "Missing ?path="}), 400
  path = normalize(path)
  denied = check_read_access(path)
  if denied:
    return denied
  # Results store the folder their client used, maybe through a symlink
  folders = {*folder_and_parents(path), *folder_and_parents(os.path.realpath(path))}
  outputs = Output.query.filter(Output.output_dir_override.in_(folders)).all()
  if not outputs:
    return jsonify({"run": None})
  # The most specific folder, else the latest run in it
  output = max(outputs, key=lambda o: (len(normalize(o.output_dir_override)), o.id))
  if not is_authorized_user(None, output.batch.ci_commit.project_id):
    return jsonify({"run": None})
  return jsonify({"run": describe_run(output)})


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
    return jsonify({"error": f"{path} is not a folder, or it doesn't exist (yet, or anymore).", "reason": "not-found"}), 404
  except PermissionError:
    return jsonify({"error": f"The QA-Board server doesn't have the permissions to read {path}.", "reason": "permissions"}), 403
  response = jsonify(listing)
  # Browsers get the file browser's page at this same URL. With Back, they show what they cached for the URL
  # (even with no-cache): if it's this JSON, users see it instead of the file browser.
  response.headers['Cache-Control'] = 'no-store'
  response.headers['Vary'] = 'Accept'
  return response
