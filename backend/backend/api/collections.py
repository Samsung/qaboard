"""
Collections: named, versioned lists of inputs of a project (docs/design/inputs-and-collections.md).
The rules are in backend/input_collections.py, the SQL in backend/input_catalog.py.

GET          /api/v1/collections?project=&archived=0     the project's and its ancestors'
POST         /api/v1/collections                          create one, with its version 1
GET          /api/v1/collections/resolve?project=&ref=    for the CLI: night/hard@2 => its inputs
GET          /api/v1/collections/<id>?version=&project=   one, with a version and the list of versions
PATCH        /api/v1/collections/<id>                     rename, describe, archive (POST works too)
GET          /api/v1/collections/<id>/inputs              a version's inputs, in their order
POST         /api/v1/collections/<id>/versions            save a new version
PUT, DELETE  /api/v1/collections/<id>/favorite
PUT, DELETE  /api/v1/collections/<id>/pins                {group: id | null (everyone)}
GET          /api/v1/collections/<id>/export.yaml         a batch on it, for a batch file

Reading needs project.read on the project asked about (?project=, by default the collection's): a collection is
seen from its project and its subprojects. Writing needs collections.write on the collection's project.
Personal collections (`shared` false) are seen and edited by their creator only: anyone who reads the project makes
them. Sharing one with the project (its creator only) needs collections.write; pins are for shared ones.
"""
from typing import Optional

from flask import request, jsonify, Response, g, has_request_context
from sqlalchemy.exc import IntegrityError

from backend import app, db_session
from .. import input_catalog as catalog
from ..input_collections import (
  CollectionError, clean_project, normalize_name, clean_text, clean_input_ids, clean_version, clean_group_id, parse_ref,
  lookup_projects, is_visible_from, ref_of, search_tokens, clean_page, flag, serialize_collection, serialize_version,
  serialize_input, export_yaml, stale_error, is_shared, is_owner, is_visible_to, MAX_DESCRIPTION, MAX_NOTES,
)
from ..access import can
from ..audit import audit, capped, diff
from ..access.policy import prefixes
from .auth import login_required, require_project_access
from .inputs import error_response, current_user_info, readable_scope


def not_found(message="This collection doesn't exist.", reason='collection_not_found'):
  return jsonify({"error": message, "reason": reason}), 404


def sign_in_error():
  return jsonify({"error": "Sign in to do this: collections record who changed them.", "reason": "sign_in_required"}), 401


def can_edit(row, user_id: Optional[int], writable: Optional[bool] = None) -> bool:
  """Developers edit shared collections, their creator personal ones. `writable`: collections.write, if known"""
  if not is_shared(row):
    return is_owner(row, user_id)
  return can('collections.write', row['project_id']) if writable is None else writable


def answer(row, project_id: Optional[str], user_id: Optional[int], **extra) -> dict:
  return {
    **serialize_collection(
      row, project_id,
      favorite=row['id'] in catalog.favorite_ids(user_id, [row['id']]),
      pins=catalog.pins_of([row['id']]).get(row['id'], []),
      user_group_ids=catalog.group_ids_of(user_id),
      can_edit=can_edit(row, user_id),
      can_pin_everyone=is_shared(row) and can('project.access', row['project_id']),
      user_id=user_id,
    ),
    **extra,
  }


def viewing_project():
  """The ?project= the client looks from, checked, or None (then: the collection's own project)"""
  project_id = request.args.get('project')
  if not project_id:
    return None
  return clean_project(project_id)


def get_collection(collection_id: int, permission: Optional[str] = None, for_update: bool = False):
  """
  (collection row, the project it's seen from, None) or (None, None, an error response).
  `permission` 'collections.write': to edit it, which for a personal collection is its creator's only.
  """
  try:
    project_id = viewing_project()
  except CollectionError as e:
    return None, None, error_response(e)
  if project_id and (forbidden := require_project_access(None, project_id, 'project.read')):
    return None, None, forbidden
  row = catalog.collection_by_id(collection_id, for_update=for_update)
  if row is None or not is_visible_to(row, current_user_info()[1]):
    # someone else's personal collection: as if it didn't exist
    return None, None, not_found()
  if project_id and not is_visible_from(row['project_id'], project_id):
    # only from its project and the projects under it
    return None, None, not_found()
  project_id = project_id or row['project_id']
  if forbidden := require_project_access(None, project_id, 'project.read'):
    return None, None, forbidden
  if permission == 'collections.write' and not is_shared(row):
    # personal: its creator's, whatever their role
    return row, project_id, None
  if permission and (forbidden := require_project_access(None, row['project_id'], permission)):
    return None, None, forbidden
  return row, project_id, None


def version_param(row, name='version'):
  """The version asked (?version=, by default the latest): (row, None) or (None, error response)"""
  try:
    number = clean_version(request.args.get(name))
  except CollectionError as e:
    return None, error_response(e)
  version = catalog.version_of(row['id'], number or row['latest_version'])
  if version is None:
    return None, not_found(f"{row['name']} has no version {number}: its latest is {row['latest_version']}.", 'version_not_found')
  return version, None


def json_body() -> dict:
  body = request.get_json(silent=True)
  if not isinstance(body, dict):
    raise CollectionError("Expected a JSON object")
  return body


def check_inputs(project_id: str, input_ids, allowed=frozenset()):
  """The inputs must be inputs of the project's runs (or of its subprojects the user can read), or in `allowed`"""
  outside = [i for i in catalog.inputs_outside(input_ids, readable_scope(project_id)) if i not in allowed]
  if outside:
    raise CollectionError(
      f"{len(outside)} input{'s are' if len(outside) > 1 else ' is'} not among the inputs of {project_id}'s runs: {', '.join(map(str, outside[:20]))}"
      + ('...' if len(outside) > 20 else ''),
      reason='unknown_inputs')


@app.route("/api/v1/collections", methods=['GET'])
@app.route("/api/v1/collections/", methods=['GET'])
def list_collections():
  """{collections}: the project's and its ancestors', by name. ?archived=1 lists the archived ones too."""
  try:
    project_id = clean_project(request.args.get('project'))
  except CollectionError as e:
    return error_response(e)
  if forbidden := require_project_access(None, project_id, 'project.read'):
    return forbidden
  _, user_id = current_user_info()
  rows = catalog.collections_of(prefixes(project_id), archived=flag(request.args.get('archived'), False), user_id=user_id)
  ids = [row['id'] for row in rows]
  favorites = catalog.favorite_ids(user_id, ids)
  pins = catalog.pins_of(ids)
  my_groups = [{"id": g['id'], "name": g['name']} for g in catalog.groups_of(user_id)]
  group_ids = [g['id'] for g in my_groups]
  projects = {row['project_id'] for row in rows} | {project_id}
  writable = {p: can('collections.write', p) for p in projects}
  owned = {p: can('project.access', p) for p in projects}
  return jsonify({
    "collections": [
      serialize_collection(row, project_id, row['id'] in favorites, pins.get(row['id'], []), group_ids,
                           can_edit(row, user_id, writable[row['project_id']]), is_shared(row) and owned[row['project_id']], user_id=user_id)
      for row in rows
    ],
    # for the pin menu: the groups the user can pin for (with can_edit), and pinning for everyone (the project's owners)
    "my_groups": my_groups,
    "can_pin_everyone": owned[project_id],
    # anyone signed in makes personal collections; developers share them with the project
    "can_create": bool(user_id),
    "can_share": writable[project_id],
  })


@app.route("/api/v1/collections", methods=['POST'])
@app.route("/api/v1/collections/", methods=['POST'])
@login_required
def create_collection():
  """
  {project, name, description?, inputs: [id], notes?, shared?} => the Collection, 201. 409 if the name is taken.
  `shared` (default true): with the project, needs collections.write. false: personal, anyone who reads the project.
  """
  _, user_id = current_user_info()
  if not user_id:
    return sign_in_error()
  try:
    body = json_body()
    project_id = clean_project(body.get('project'))
  except CollectionError as e:
    return error_response(e)
  shared = body.get('shared', True)
  if not isinstance(shared, bool):
    return error_response(CollectionError("`shared` must be true or false"))
  if forbidden := require_project_access(None, project_id, 'collections.write' if shared else 'project.read'):
    return forbidden
  if not catalog.project_exists(project_id):
    return jsonify({"error": f"The project {project_id} doesn't exist.", "reason": "project_not_found"}), 404
  try:
    name = normalize_name(body.get('name'))
    description = clean_text(body.get('description'), MAX_DESCRIPTION, 'description')
    notes = clean_text(body.get('notes'), MAX_NOTES, 'notes')
    input_ids = clean_input_ids(body.get('inputs', []))
    taken = catalog.name_taken(project_id, name)
    if taken is None:
      check_inputs(project_id, input_ids)
  except CollectionError as e:
    return error_response(e)
  if taken is not None:
    return name_taken_response(project_id, name, taken, user_id)
  try:
    collection_id = catalog.create_collection(project_id, name, description, input_ids, notes, user_id, shared=shared)
    audit('collection.create', 'collection', collection_id, name, project_id=project_id, meta={"version": 1, "size": len(input_ids), "shared": shared})
    db_session.commit()
  except IntegrityError:
    # saved by someone else meanwhile
    db_session.rollback()
    return name_taken_response(project_id, name, catalog.name_taken(project_id, name), user_id)
  row = catalog.collection_by_id(collection_id)
  return jsonify(answer(row, project_id, user_id)), 201


def name_taken_response(project_id: str, name: str, taken_id: Optional[int], user_id: Optional[int]):
  """
  409: names are unique per project, personal collections included. Someone else's personal one: we don't say
  which (no id: the web app then only asks for another name).
  """
  taken = catalog.collection_by_id(taken_id) if taken_id is not None else None
  if taken is not None and not is_visible_to(taken, user_id):
    return jsonify({"error": f"The name {name} is taken in {project_id}, by a collection you don't see (someone's personal one): pick another.", "reason": "name_taken"}), 409
  return jsonify({"error": f"{project_id} already has a collection named {name}.", "reason": "name_taken", "id": taken_id}), 409


def resolved(ref_text, project_id):
  """
  What GET /collections/resolve answers, as (body, None), or (None, an error response). `project_id`: where the
  reference is made from, None if the reference names its project. Also used in-process (in_process_resolver).
  """
  try:
    ref = parse_ref(ref_text)
    project_id = clean_project(project_id) if project_id else ref.project
    if not project_id:
      raise CollectionError("Which project? Send ?project=, or name it in the reference: group/repo:night/hard-cases", reason='invalid_project')
  except CollectionError as e:
    return None, error_response(e)
  if forbidden := require_project_access(None, project_id, 'project.read'):
    return None, forbidden
  # another project, not an ancestor: its own readers only
  if ref.project and not is_visible_from(ref.project, project_id) and (forbidden := require_project_access(None, ref.project, 'project.read')):
    return None, forbidden
  looked_in = lookup_projects(project_id, ref)
  _, user_id = current_user_info()
  # personal collections resolve for their creator only, e.g. in their own `qa batch`
  row = catalog.find_collection(looked_in, ref.name, user_id=user_id)
  if row is None:
    return None, not_found(f"No collection named {ref.name} in {', '.join(looked_in)}.")
  number = ref.version or row['latest_version']
  version = catalog.version_of(row['id'], number)
  if version is None:
    return None, not_found(f"{ref.name} has no version {number}: its latest is {row['latest_version']}.", 'version_not_found')
  return {
    "collection": answer(row, project_id, user_id),
    "name": row['name'],
    "ref": ref_of(row['name'], row['project_id'], project_id, version['version']),
    "version": version['version'],
    "project": row['project_id'],
    "inputs": [{"id": r['id'], "database": r['database'], "path": r['path']} for r in catalog.member_refs(version['id'])],
  }, None


@app.route("/api/v1/collections/resolve", methods=['GET'])
def resolve_collection():
  """
  For the CLI: ?project=a/b/c&ref=night/hard@2 looks in a/b/c, then a/b, then a; `a/b:night/hard` names the project.
  {collection: Collection, name, ref, version, project, inputs: [{id, database, path}]}. Archived collections resolve.
  """
  body, error = resolved(request.args.get('ref'), request.args.get('project'))  # personal ones: their creator's
  return error if error else jsonify(body)


def in_process_resolver(project_id: str):
  """
  For qaboard.iterators.resolving_collections_with, when the server lists a batch's runs itself (api/tuning.py):
  batches' `collections` resolve here, as the current user, instead of with a request to our own API.
  References are made from `project_id`, the project whose batches are listed, whatever its qaboard.yaml says.
  """
  def resolve(ref, project=None):
    from qaboard.input_collections import CollectionError as ClientError, CollectionNotFound, from_api
    body, error = resolved(ref, project_id)
    if error:
      response, status = error
      message = (response.get_json(silent=True) or {}).get('error') or f"HTTP {status}"
      raise (CollectionNotFound if status == 404 else ClientError)(message, ref=ref, project=project_id, status=status)
    return from_api(body, ref, project_id)
  return resolve


@app.route("/api/v1/collections/<int:collection_id>", methods=['GET'])
@app.route("/api/v1/collections/<int:collection_id>/", methods=['GET'])
def read_collection(collection_id):
  """The Collection, with `version` (?version=, by default the latest) and `versions`, the latest first"""
  row, project_id, error = get_collection(collection_id)
  if error:
    return error
  version, error = version_param(row)
  if error:
    return error
  _, user_id = current_user_info()
  return jsonify(answer(row, project_id, user_id,
                        version=serialize_version(version),
                        versions=[serialize_version(v) for v in catalog.versions_of(collection_id)]))


# Edits also take POST: some proxies drop the body of other methods
@app.route("/api/v1/collections/<int:collection_id>", methods=['PATCH', 'POST'])
@app.route("/api/v1/collections/<int:collection_id>/", methods=['PATCH', 'POST'])
@login_required
def edit_collection(collection_id):
  """{name?, description?, archived?, shared?}: `shared` by its creator only, and sharing needs collections.write"""
  _, user_id = current_user_info()
  if not user_id:
    return sign_in_error()
  row, project_id, error = get_collection(collection_id, 'collections.write')
  if error:
    return error
  fields = {}
  try:
    body = json_body()
    if 'name' in body:
      fields['name'] = normalize_name(body['name'])
    if 'description' in body:
      fields['description'] = clean_text(body['description'], MAX_DESCRIPTION, 'description')
    if 'archived' in body:
      if not isinstance(body['archived'], bool):
        raise CollectionError("`archived` must be true or false")
      fields['archived'] = body['archived']
    if 'shared' in body:
      if not isinstance(body['shared'], bool):
        raise CollectionError("`shared` must be true or false")
      if body['shared'] != is_shared(row):
        fields['shared'] = body['shared']
  except CollectionError as e:
    return error_response(e)
  if 'shared' in fields:
    # its creator decides who sees it: a developer can't make someone else's shared collection theirs only
    if not is_owner(row, user_id):
      return jsonify({"error": "Only who created a collection can share it, or make it personal again.", "reason": "not_the_owner"}), 403
    if forbidden := require_project_access(None, row['project_id'], 'collections.write'):
      return forbidden
  if fields.get('name') and fields['name'] != row['name'] and (taken := catalog.name_taken(row['project_id'], fields['name'], except_id=collection_id)):
    return name_taken_response(row['project_id'], fields['name'], taken, user_id)
  try:
    catalog.update_collection(collection_id, fields)
    if fields.get('shared') is False:
      # pins are for shared collections: they'd come back if it's shared again
      catalog.clear_pins(collection_id)
    before = {k: (row.get('archived_at') is not None if k == 'archived' else row.get(k)) for k in fields}
    if changes := capped(diff(before, fields)):
      audit('collection.update', 'collection', collection_id, fields.get('name') or row['name'], project_id=row['project_id'], changes=changes)
    db_session.commit()
  except IntegrityError:
    db_session.rollback()
    return jsonify({"error": f"{row['project_id']} already has a collection named {fields.get('name')}.", "reason": "name_taken"}), 409
  return jsonify(answer(catalog.collection_by_id(collection_id), project_id, user_id))


@app.route("/api/v1/collections/<int:collection_id>/inputs", methods=['GET'])
def collection_inputs(collection_id):
  """{inputs: [Input with position], total, version, limit, offset}: a version's inputs, in their order. ?q= filters by path."""
  row, project_id, error = get_collection(collection_id)
  if error:
    return error
  version, error = version_param(row)
  if error:
    return error
  try:
    limit, offset = clean_page(request.args.get('limit'), request.args.get('offset'))
  except CollectionError as e:
    return error_response(e)
  found = catalog.members(version['id'], readable_scope(project_id), search_tokens(request.args.get('q')), limit, offset)
  return jsonify({
    "inputs": [serialize_input(r) for r in found['inputs']], "total": found['total'],
    "version": version['version'], "limit": limit, "offset": offset,
  })


@app.route("/api/v1/collections/<int:collection_id>/versions", methods=['POST'])
@app.route("/api/v1/collections/<int:collection_id>/versions/", methods=['POST'])
@login_required
def save_version(collection_id):
  """{inputs: [id], base_version, notes?} => the Collection with its new `version`, 201. 409 if base_version isn't the latest."""
  _, user_id = current_user_info()
  if not user_id:
    return sign_in_error()
  row, project_id, error = get_collection(collection_id, 'collections.write')
  if error:
    return error
  try:
    body = json_body()
    base_version = clean_version(body.get('base_version'), 'base_version')
    if base_version is None:
      raise CollectionError("`base_version` is required: the version your changes start from")
    notes = clean_text(body.get('notes'), MAX_NOTES, 'notes')
    input_ids = clean_input_ids(body.get('inputs'))
    if base_version != row['latest_version']:
      return jsonify(stale_error(base_version, row['latest_version'])), 409
    # inputs already in the collection stay allowed, e.g. if their runs were deleted with their project
    latest = catalog.version_of(collection_id, row['latest_version'])
    check_inputs(row['project_id'], input_ids, allowed=catalog.member_ids(latest['id']) if latest else frozenset())
  except CollectionError as e:
    return error_response(e)
  try:
    number = catalog.add_version(collection_id, base_version, input_ids, notes, user_id)
    audit('collection.version', 'collection', collection_id, f"{row['name']}@{number}", project_id=row['project_id'], meta={"version": number, "size": len(input_ids)})
    db_session.commit()
  except catalog.StaleVersion as e:
    db_session.rollback()
    return jsonify(stale_error(base_version, e.latest_version)), 409
  except IntegrityError:
    db_session.rollback()
    latest = catalog.collection_by_id(collection_id)
    return jsonify(stale_error(base_version, latest['latest_version'] if latest else base_version + 1)), 409
  row = catalog.collection_by_id(collection_id)
  return jsonify(answer(row, project_id, user_id, version=serialize_version(catalog.version_of(collection_id, number)))), 201


@app.route("/api/v1/collections/<int:collection_id>/favorite", methods=['PUT', 'DELETE'])
@app.route("/api/v1/collections/<int:collection_id>/favorite/", methods=['PUT', 'DELETE'])
@login_required
def favorite_collection(collection_id):
  """{id, favorite}: anyone who sees it adds it to their favorites"""
  _, user_id = current_user_info()
  if not user_id:
    return jsonify({"error": "Sign in to add collections to your favorites.", "reason": "sign_in_required"}), 401
  row, project_id, error = get_collection(collection_id)
  if error:
    return error
  favorite = request.method == 'PUT'
  catalog.set_favorite(user_id, collection_id, favorite)
  db_session.commit()
  return jsonify({"id": collection_id, "favorite": favorite})


def is_instance_admin() -> bool:
  actor = g.get('actor') if has_request_context() else None
  try:
    return bool(actor is not None and actor.is_admin)
  except Exception:
    return False


@app.route("/api/v1/collections/<int:collection_id>/pins", methods=['PUT', 'DELETE'])
@app.route("/api/v1/collections/<int:collection_id>/pins/", methods=['PUT', 'DELETE'])
@login_required
def pin_collection(collection_id):
  """
  Pins for a group ({group: id}: developers of the project who are in the group) or for everyone ({group: null}:
  owners). The group can also be in the query string (?group=12, ?group= for everyone): some proxies drop DELETE bodies.
  => the Collection
  """
  _, user_id = current_user_info()
  if not user_id:
    return sign_in_error()
  try:
    body = request.get_json(silent=True)
    body = body if isinstance(body, dict) else {}
    if 'group' in body:
      group_id = clean_group_id(body['group'])
    elif 'group' in request.args:
      group_id = clean_group_id(request.args.get('group'))
    else:
      raise CollectionError("Which group? {\"group\": id}, or {\"group\": null} for everyone")
  except CollectionError as e:
    return error_response(e)
  row, project_id, error = get_collection(collection_id)
  if error:
    return error
  if not is_shared(row):
    return jsonify({"error": "This collection is personal: share it with the project to pin it.", "reason": "personal_collection"}), 400
  if group_id is None:
    if forbidden := require_project_access(None, row['project_id'], 'project.access'):
      return forbidden
  else:
    if forbidden := require_project_access(None, row['project_id'], 'collections.write'):
      return forbidden
    if not catalog.group_exists(group_id):
      return jsonify({"error": "This group doesn't exist.", "reason": "group_not_found"}), 404
    if group_id not in catalog.group_ids_of(user_id) and not is_instance_admin():
      return jsonify({"error": "You can only pin collections for your own groups.", "reason": "not_a_member"}), 403
  # audited only when it changed something: pinning twice, or unpinning what isn't, is no event
  if catalog.set_pin(collection_id, group_id, request.method == 'PUT', user_id):
    audit('collection.pin' if request.method == 'PUT' else 'collection.unpin', 'collection', collection_id, row['name'], project_id=row['project_id'], meta={"group_id": group_id})
  db_session.commit()
  return jsonify(answer(catalog.collection_by_id(collection_id), project_id, user_id))


@app.route("/api/v1/collections/<int:collection_id>/export.yaml", methods=['GET'])
def export_collection(collection_id):
  """qaboard.yaml for a batch on the collection: with ?version=, that version, else the latest when the batch starts"""
  row, project_id, error = get_collection(collection_id)
  if error:
    return error
  version, error = version_param(row)
  if error:
    return error
  pinned = version['version'] if request.args.get('version') not in (None, '', 'latest') else None
  text = export_yaml(row['name'], row['project_id'], project_id, pinned, int(version.get('size') or 0), row['latest_version'])
  response = Response(text, mimetype='text/yaml')
  response.headers['Cache-Control'] = 'no-store'
  return response
