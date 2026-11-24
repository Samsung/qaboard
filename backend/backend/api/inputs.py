"""
The inputs runs used, for a project's Inputs tab (docs/design/inputs-and-collections.md).
The rules are in backend/input_collections.py, the SQL in backend/input_catalog.py, thumbnails in backend/thumbnails.py.

GET /api/v1/inputs?project=&q=&folder=&database=&live=1&sort=last_run|path&limit=100&offset=0&facets=
GET /api/v1/inputs?...&fields=id         only the ids of every input that matches (up to MAX_INPUTS), for "Select all matching"
GET /api/v1/inputs/<id>?project=         an input, with the project's latest runs on it
GET /api/v1/inputs/<id>/thumbnail?size=  a JPEG, 404 when no decoder reads the input
GET /api/v1/inputs/<id>/file             the input's file, when browsers read its format
"""
import hashlib
from pathlib import Path
from typing import List
from urllib.parse import quote

from flask import request, jsonify, send_file, make_response

from qaboard.api import dir_to_url

from backend import app
from .. import input_catalog as catalog
from ..input_collections import (
  CollectionError, clean_project, search_tokens, normalize_folder, clean_page, clean_sort, flag, thumbnail_size,
  serialize_input, input_file, iso, MAX_INPUTS,
)
from ..access import can
from ..access.policy import prefixes
from .. import locations
from .auth import get_current_user, require_project_access
from .files import readable_file


# Formats browsers show, served as they are to the image viewer. Not SVG: it can run scripts.
BROWSER_IMAGES = {'.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.avif'}


def error_response(e: CollectionError):
  body = {"error": str(e)}
  if e.reason:
    body["reason"] = e.reason
  return jsonify(body), e.status


def current_user_info():
  """The user's info, and their id if they are logged in"""
  user_info = get_current_user(to_jsonify=False) or {}
  user_id = user_info.get('user_id') if user_info.get('is_authenticated') else None
  return user_info, user_id


def readable_scope(project_id: str) -> List[str]:
  """The project and its subprojects the user can read: subprojects may be more private than their parent"""
  return [p for p in catalog.scope_projects(project_id) if p == project_id or can('project.read', p)]


@app.route("/api/v1/inputs", methods=['GET'])
@app.route("/api/v1/inputs/", methods=['GET'])
def list_inputs():
  """{inputs, total, databases, folders, limit, offset}, see input_catalog.list_inputs: the facets are null after the first page, unless facets=1"""
  try:
    project_id = clean_project(request.args.get('project'))
    database = request.args.get('database') or None
    if database is not None and len(database) > 2000:
      raise CollectionError("`database` is too long")
    filters = catalog.InputFilters(
      tokens=search_tokens(request.args.get('q')),
      folder=normalize_folder(request.args.get('folder')),
      database=database,
      live=flag(request.args.get('live'), True),
    )
    sort = clean_sort(request.args.get('sort'))
    fields = request.args.get('fields') or None
    if fields not in (None, 'id'):
      raise CollectionError("`fields` can only be `id`")
    limit, offset = clean_page(request.args.get('limit'), request.args.get('offset'))
    # total, databases and folders: by default on the first page only (offset=0), null on the next ones
    with_facets = flag(request.args.get('facets'), offset == 0)
  except CollectionError as e:
    return error_response(e)
  if forbidden := require_project_access(None, project_id, 'project.read'):
    return forbidden
  if fields == 'id':
    # Every match, not a page: as many as a collection's version can have. More: the web app asks to narrow the filters.
    found = catalog.list_input_ids(readable_scope(project_id), filters, sort, cap=MAX_INPUTS)
    return jsonify({**found, "max": MAX_INPUTS})
  found = catalog.list_inputs(readable_scope(project_id), filters, sort, limit, offset, with_facets=with_facets)
  return jsonify({**found, "inputs": [serialize_input(row) for row in found['inputs']], "limit": limit, "offset": offset})


def serialize_run(row) -> dict:
  output_dir_url = None
  if row.get('output_dir_override'):
    try:
      output_dir_url = dir_to_url(locations.local_path(row['output_dir_override']))
    except Exception:
      output_dir_url = None
  return {
    'id': row['id'],
    'project': row['project'],
    'batch': row['batch'],
    'commit': row['commit'],
    'branch': row['branch'],
    'user': row['user'],
    'origin': row['origin'],
    'platform': row.get('platform'),
    'configurations': row.get('configurations') or [],
    'created_date': iso(row['created_date']),
    'deleted': bool(row['deleted']),
    'is_failed': bool(row['is_failed']),
    'is_pending': bool(row.get('is_pending')),
    'is_running': bool(row.get('is_running')),
    'output_dir_url': output_dir_url,
  }


@app.route("/api/v1/inputs/<int:input_id>", methods=['GET'])
@app.route("/api/v1/inputs/<int:input_id>/", methods=['GET'])
def get_input(input_id):
  """
  An input (`Input`) and the latest runs on it (`runs`) of the project and of its subprojects.
  Seen from projects that ran on it, or that see a collection with it (their own or an ancestor's).
  """
  try:
    project_id = clean_project(request.args.get('project'))
  except CollectionError as e:
    return error_response(e)
  if forbidden := require_project_access(None, project_id, 'project.read'):
    return forbidden
  scope = readable_scope(project_id)
  row = catalog.input_in_scope(input_id, scope)
  if row is None:
    row = catalog.input_by_id(input_id) if catalog.in_collections_of(input_id, prefixes(project_id)) else None
    if row is None:
      return jsonify({"error": f"No run of {project_id} used this input.", "reason": "input_not_found"}), 404
    row = {**row, **catalog.input_stats(input_id, scope)}
  runs = catalog.input_runs(input_id, scope)
  return jsonify({**serialize_input(row), "runs": [serialize_run(r) for r in runs]})


def input_path(input_id):
  """(Path, row, None) of an input's file the user can read, else (None, None, an error response)"""
  project_id = request.args.get('project')
  if project_id:
    try:
      project_id = clean_project(project_id)
    except CollectionError as e:
      return None, None, error_response(e)
    if forbidden := require_project_access(None, project_id, 'project.read'):
      return None, None, forbidden
  row = catalog.input_by_id(input_id)
  if row is None:
    return None, None, (jsonify({"error": "This input doesn't exist.", "reason": "input_not_found"}), 404)
  absolute = input_file(row['database'], row['path'])
  if absolute is None:
    return None, None, (jsonify({"error": "This input isn't a file the server reads: its database isn't an absolute path.", "reason": "not_a_file"}), 404)
  # the file browser's rules: only files in the storage, that the user can read
  path, denied = readable_file(f"/s{quote(absolute)}")
  if denied:
    return None, None, denied
  return path, row, None


def busy_response():
  """Too many thumbnails are being decoded (thumbnails.Busy): the grid's images try again"""
  response = make_response(jsonify({"error": "The server is busy making thumbnails: try again in a few seconds.", "reason": "busy"}), 503)
  response.headers['Retry-After'] = '2'
  response.headers['Cache-Control'] = 'no-store'
  return response


@app.route("/api/v1/inputs/<int:input_id>/thumbnail", methods=['GET'])
def input_thumbnail(input_id):
  from ..thumbnails import thumbnail_of, is_cached, Busy
  path, row, error = input_path(input_id)
  if error:
    return error
  try:
    stat = Path(path).stat()
  except OSError:
    response = make_response(jsonify({"error": "The input's file doesn't exist (anymore?).", "reason": "missing_file"}), 404)
    response.headers['Cache-Control'] = 'private, max-age=300'
    return response
  size = thumbnail_size(request.args.get('size'))
  etag = hashlib.sha1(f"{path}:{stat.st_mtime_ns}:{size}".encode()).hexdigest()
  if etag in request.if_none_match:
    response = make_response('', 304)
  else:
    try:
      data = thumbnail_of(str(path), stat.st_mtime_ns, size)
    except Busy:
      return busy_response()
    if data is None:
      response = make_response(jsonify({"error": "QA-Board can't make a thumbnail of this file's format.", "reason": "no_thumbnail"}), 404)
      response.headers['Cache-Control'] = 'private, max-age=3600'
      return response
    response = make_response(data)
    response.mimetype = 'image/jpeg'
  response.set_etag(etag)
  # The server doesn't cache the big ones: browsers keep them longer. The ETag changes with the file.
  response.headers['Cache-Control'] = 'private, max-age=86400' if is_cached(size) else 'private, max-age=604800'
  response.headers['X-Content-Type-Options'] = 'nosniff'
  return response


@app.route("/api/v1/inputs/<int:input_id>/file", methods=['GET'])
def input_file_content(input_id):
  """The file, for the image viewer, when browsers read its format: else 415 (show the thumbnail instead)"""
  path, row, error = input_path(input_id)
  if error:
    return error
  suffix = Path(path).suffix.lower()
  if suffix not in BROWSER_IMAGES:
    return jsonify({
      "error": f"Browsers can't show {suffix or 'these'} files: use the thumbnail.", "reason": "unsupported_format",
      "thumbnail_url": f"/api/v1/inputs/{input_id}/thumbnail?size=1024",
    }), 415
  if not Path(path).is_file():
    return jsonify({"error": "The input's file doesn't exist (anymore?).", "reason": "missing_file"}), 404
  response = send_file(str(path), conditional=True, max_age=3600)
  response.headers['Cache-Control'] = 'private, max-age=3600'
  response.headers['X-Content-Type-Options'] = 'nosniff'
  return response
