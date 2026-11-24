"""
What inputs and collections are, without the database (docs/design/inputs-and-collections.md): validating what
clients send (names, references, lists of inputs, pages, searches), the projects a reference looks in, and what we
answer. The SQL is in backend/input_catalog.py, the API in api/inputs.py and api/collections.py, the tables in
models/Collection.py.

Not named collections.py: migrate.sh runs Python from this folder, where it would hide the standard library's.
"""
import re
import datetime
from typing import Optional, Tuple, List, NamedTuple, Iterable
from urllib.parse import quote

import yaml

from .access.policy import prefixes, is_valid_project_id


MAX_NAME = 200
MAX_DESCRIPTION = 20_000
MAX_NOTES = 20_000
# inputs in a version: more answers 413
MAX_INPUTS = 50_000
# pages of inputs
DEFAULT_LIMIT = 100
MAX_LIMIT = 5000
MAX_OFFSET = 10_000_000
# searches
MAX_QUERY = 500
MAX_TOKENS = 10
# the input runs shown with an input
MAX_RUNS = 50
# thumbnails' sizes: a few, so that they're cached
THUMBNAIL_SIZES = (64, 128, 256, 512, 1024)
DEFAULT_THUMBNAIL_SIZE = 256

NAME_SEGMENT = re.compile(r'^[A-Za-z0-9._ -]+$')
SORTS = ('last_run', 'path')


class CollectionError(ValueError):
  """What's wrong with what a client sent, and the HTTP status to answer"""
  def __init__(self, message: str, status: int = 400, reason: Optional[str] = None):
    super().__init__(message)
    self.status = status
    self.reason = reason


# Names

def normalize_name(name) -> str:
  """' night / hard ' => 'night/hard', like milestone groups. Raises CollectionError if it's not a valid name."""
  if not isinstance(name, str):
    raise CollectionError("`name` must be a string, e.g. night/hard-cases", reason='invalid_name')
  segments = [re.sub(' +', ' ', part.strip(' ')) for part in name.split('/')]
  segments = [part for part in segments if part]
  normalized = '/'.join(segments)
  if not normalized:
    raise CollectionError("Collections need a name, e.g. night/hard-cases", reason='invalid_name')
  if len(normalized) > MAX_NAME:
    raise CollectionError(f"The name is too long (at most {MAX_NAME} characters)", reason='invalid_name')
  for part in segments:
    if not NAME_SEGMENT.match(part) or part in ('.', '..'):
      raise CollectionError(
        f"Invalid name: \"{part}\". Use letters, digits, spaces, dots, dashes and underscores, with / for groups.",
        reason='invalid_name')
  return normalized


def clean_text(value, max_length: int, name: str) -> str:
  if value is None:
    return ''
  if not isinstance(value, str):
    raise CollectionError(f"`{name}` must be a string")
  value = value.replace('\x00', '').strip()
  if len(value) > max_length:
    raise CollectionError(f"`{name}` is too long (at most {max_length} characters)", status=413, reason='too_long')
  return value


def clean_input_ids(value) -> List[int]:
  """The ids of the inputs of a version, in their order, without duplicates"""
  if not isinstance(value, list):
    raise CollectionError("`inputs` must be a list of input ids")
  if len(value) > MAX_INPUTS:
    raise CollectionError(f"Collections have at most {MAX_INPUTS:,} inputs: this one has {len(value):,}.", status=413, reason='too_many_inputs')
  ids, seen = [], set()
  for item in value:
    # True is an int in Python, not an id
    if isinstance(item, bool) or not isinstance(item, int) or item <= 0 or item > 2**31 - 1:
      raise CollectionError("`inputs` must be a list of input ids (integers)")
    if item not in seen:
      seen.add(item)
      ids.append(item)
  return ids


# inputs added in one request (POST /inputs): `qa inputs add` sends them by chunks of this many
MAX_ADDED_INPUTS = 10_000
MAX_INPUT_PATH = 2000
MAX_INPUT_METADATA = 20_000


def clean_new_inputs(value) -> List[dict]:
  """
  The inputs to add (POST /inputs): [{database, path, metadata?}], without duplicates, in their order.
  `path` is relative to `database`, like runs send them (`qa run`'s input, and the database it was found in).
  """
  import json
  if not isinstance(value, list) or not value:
    raise CollectionError("`inputs` must be a list of {database, path, metadata?}", reason='invalid_inputs')
  if len(value) > MAX_ADDED_INPUTS:
    raise CollectionError(f"Add at most {MAX_ADDED_INPUTS:,} inputs at a time: {len(value):,} were sent.", status=413, reason='too_many_inputs')
  inputs, seen = [], set()
  for index, item in enumerate(value):
    where = f"inputs[{index}]"
    if not isinstance(item, dict):
      raise CollectionError(f"{where} must be {{database, path, metadata?}}", reason='invalid_inputs')
    database, path = item.get('database'), item.get('path')
    if not isinstance(database, str) or not database.strip() or len(database) > MAX_INPUT_PATH:
      raise CollectionError(f"{where}.database must be the folder the input is in, like runs send it (e.g. /mnt/data)", reason='invalid_inputs')
    if not isinstance(path, str) or not path.strip() or len(path) > MAX_INPUT_PATH:
      raise CollectionError(f"{where}.path must be the input's path, relative to its database", reason='invalid_inputs')
    path = path.strip().replace('\\', '/').lstrip('/')
    if not path or any(part == '..' for part in path.split('/')):
      raise CollectionError(f"{where}.path must stay in its database: {item.get('path')!r}", reason='invalid_inputs')
    metadata = item.get('metadata')
    if metadata is not None and not isinstance(metadata, dict):
      raise CollectionError(f"{where}.metadata must be a mapping", reason='invalid_inputs')
    if metadata and len(json.dumps(metadata, default=str)) > MAX_INPUT_METADATA:
      raise CollectionError(f"{where}.metadata is too big: at most {MAX_INPUT_METADATA:,} characters of JSON", status=413, reason='invalid_inputs')
    key = (database.strip(), path)
    if key in seen:
      continue
    seen.add(key)
    inputs.append({"database": key[0], "path": key[1], "metadata": metadata or None})
  return inputs


def clean_version(value, name: str = 'version') -> Optional[int]:
  """A version number, None for the latest ("latest" or nothing)"""
  if value is None or value == '' or value == 'latest':
    return None
  if isinstance(value, bool):
    raise CollectionError(f"`{name}` must be a version number")
  try:
    version = int(value)
  except (TypeError, ValueError):
    raise CollectionError(f"`{name}` must be a version number, or \"latest\"")
  if version < 1 or version > 2**31 - 1:
    raise CollectionError(f"`{name}` must be a version number, from 1")
  return version


def clean_project(value) -> str:
  if not isinstance(value, str) or not value.strip('/') or not is_valid_project_id(value):
    raise CollectionError("Which project? Send ?project=group/repo", reason='invalid_project')
  return value.strip('/')


# References: name, name@3, name@latest, project:name@2

class Ref(NamedTuple):
  name: str
  version: Optional[int]
  # the project named explicitly, None to look in the project and its ancestors
  project: Optional[str]


def parse_ref(ref) -> Ref:
  if not isinstance(ref, str) or not ref.strip():
    raise CollectionError("Which collection? e.g. night/hard-cases, night/hard-cases@2 or group/repo:night/hard-cases", reason='invalid_ref')
  ref = ref.strip()
  if len(ref) > 2 * MAX_NAME + 1000:
    raise CollectionError("This reference is too long", reason='invalid_ref')
  rest, at, version = ref.rpartition('@')
  if not at:
    rest, version = ref, None
  elif not version.strip():
    raise CollectionError(f"Missing version after @ in \"{ref}\": e.g. @2, or @latest", reason='invalid_ref')
  # names have no colon: what's before the last one is the project
  project, colon, name = rest.rpartition(':')
  if colon:
    project = project.strip()
    if not project or ':' in project or not is_valid_project_id(project):
      raise CollectionError(f"Invalid project in the reference: \"{project}\"", reason='invalid_ref')
    project = project.strip('/')
  else:
    project = None
  try:
    version = clean_version(version.strip() if version is not None else None)
  except CollectionError:
    raise CollectionError(f"Invalid version in \"{ref}\": use a number, e.g. @2, or @latest", reason='invalid_ref')
  return Ref(normalize_name(name), version, project)


def lookup_projects(project_id: str, ref: Ref) -> List[str]:
  """Where a reference made from `project_id` looks, in order: the project named, else the project then its ancestors"""
  if ref.project:
    return [ref.project]
  return prefixes(project_id)


def is_visible_from(collection_project: str, project_id: str) -> bool:
  """A project's collections are seen from it and its subprojects (a sees nothing of a/b, a/bc nothing of a/b)"""
  collection_project = (collection_project or '').strip('/')
  project_id = (project_id or '').strip('/')
  return bool(collection_project) and (project_id == collection_project or project_id.startswith(collection_project + '/'))


def ref_of(name: str, collection_project: str, project_id: Optional[str] = None, version: Optional[int] = None) -> str:
  """How `project_id` names the collection: its name, or project:name when it's another project's (an ancestor's)"""
  ref = name if not project_id or project_id == collection_project else f"{collection_project}:{name}"
  return f"{ref}@{version}" if version else ref


# Searches and pages

def like_escape(value: str) -> str:
  return value.replace('\\', '\\\\').replace('%', '\\%').replace('_', '\\_')


def search_tokens(q) -> List[str]:
  """Words a path must all contain, case-insensitively"""
  if not isinstance(q, str):
    return []
  return [token for token in q[:MAX_QUERY].split() if token][:MAX_TOKENS]


def normalize_folder(folder) -> str:
  """' /a//b/ ' => 'a/b', the path prefix of an input folder ('' for all)"""
  if not isinstance(folder, str):
    return ''
  return '/'.join(part for part in folder.strip().split('/') if part)


def clean_page(limit, offset, default_limit: int = DEFAULT_LIMIT, max_limit: int = MAX_LIMIT) -> Tuple[int, int]:
  def number(value, default):
    if value is None or value == '':
      return default
    try:
      return int(value)
    except (TypeError, ValueError):
      raise CollectionError("`limit` and `offset` must be numbers")
  limit, offset = number(limit, default_limit), number(offset, 0)
  return max(1, min(limit, max_limit)), max(0, min(offset, MAX_OFFSET))


def clean_sort(sort) -> str:
  if sort in (None, ''):
    return 'last_run'
  if sort not in SORTS:
    raise CollectionError(f"`sort` is one of {', '.join(SORTS)}")
  return sort


def flag(value, default: bool) -> bool:
  if value is None or value == '':
    return default
  return str(value).lower() in ('1', 'true', 'yes', 'on')


def thumbnail_size(value) -> int:
  """The smallest size we make that is at least what's asked"""
  try:
    size = int(value) if value not in (None, '') else DEFAULT_THUMBNAIL_SIZE
  except (TypeError, ValueError):
    size = DEFAULT_THUMBNAIL_SIZE
  for candidate in THUMBNAIL_SIZES:
    if size <= candidate:
      return candidate
  return THUMBNAIL_SIZES[-1]


# What we answer

def iso(date: Optional[datetime.datetime]) -> Optional[str]:
  if date is None:
    return None
  if isinstance(date, str):
    return date
  if date.tzinfo is not None:
    date = date.astimezone(datetime.timezone.utc).replace(tzinfo=None)
  return date.isoformat() + 'Z'


def input_file(database: str, path: str) -> Optional[str]:
  """The absolute path of an input, None if its database isn't an absolute path"""
  database, path = str(database or ''), str(path or '')
  if not database.startswith('/'):
    return None
  return (database.rstrip('/') + '/' + path.lstrip('/')) if path else database


def serialize_input(row) -> dict:
  """`row`: a mapping with id, database, path, data, and maybe runs, first_run_at, last_run_at, position"""
  path = str(row['path'] or '')
  folder, slash, name = path.rpartition('/')
  absolute = input_file(row['database'], path)
  answer = {
    'id': row['id'],
    'database': row['database'],
    'path': path,
    'name': name if slash else path,
    'folder': folder if slash else '',
    'data': row.get('data') or {},
    'runs': int(row.get('runs') or 0),
    'first_run_at': iso(row.get('first_run_at')),
    'last_run_at': iso(row.get('last_run_at')),
    'thumbnail_url': f"/api/v1/inputs/{row['id']}/thumbnail",
    # the file, under /s/ like runs' output_dir_url: the image viewer and file browser read it from there
    'url': quote(f"/s{absolute}") if absolute else None,
  }
  if 'position' in row and row['position'] is not None:
    answer['position'] = row['position']
  return answer


def user_of(row, prefix: str = 'created_by_') -> Optional[dict]:
  if row.get(f'{prefix}id') is None:
    return None
  return {'id': row[f'{prefix}id'], 'user_name': row.get(f'{prefix}user_name'), 'full_name': row.get(f'{prefix}full_name')}


def serialize_collection(row, project_id: Optional[str] = None, favorite: bool = False, pins: Iterable[dict] = (),
                         user_group_ids: Iterable[int] = (), can_edit: bool = False, can_pin_everyone: bool = False,
                         user_id: Optional[int] = None) -> dict:
  """
  `row`: a collection with its latest version's size, its creator, and who saved its latest version (input_catalog.COLLECTION_COLUMNS).
  `project_id`: where it's seen from, for its `ref`. `pins`: [{id, name}], id None for everyone.
  Who can't edit it (e.g. anonymous readers of a public project) only sees the pins for everyone and for their groups:
  the names of the other groups are not theirs to see.
  """
  groups = set(user_group_ids)
  pins = [pin for pin in pins if can_edit or pin['id'] is None or pin['id'] in groups]
  return {
    'id': row['id'],
    'project': row['project_id'],
    'name': row['name'],
    'description': row.get('description') or '',
    'created_by': user_of(row),
    # who saved the latest version
    'updated_by': user_of(row, 'updated_by_'),
    'created_at': iso(row.get('created_at')),
    'updated_at': iso(row.get('updated_at')),
    'archived': row.get('archived_at') is not None,
    'archived_at': iso(row.get('archived_at')),
    'latest_version': row['latest_version'],
    'size': int(row.get('size') or 0),
    'favorite': bool(favorite),
    'pinned_for': pins,
    # pinned for everyone, or for one of the user's groups: listed first in the sidebar
    'pinned': any(pin['id'] is None or pin['id'] in groups for pin in pins),
    'can_edit': bool(can_edit),
    # false: personal, only its creator sees it (`mine`)
    'shared': is_shared(row),
    'mine': is_owner(row, user_id),
    # owners of its project pin it for everyone; developers (can_edit) for their own groups
    'can_pin_everyone': bool(can_pin_everyone),
    'ref': ref_of(row['name'], row['project_id'], project_id),
    'inherited': bool(project_id) and project_id != row['project_id'],
  }


# Personal collections: seen and edited by their creator only, like personal milestones. Shared ones belong to the
# project: developers edit them (collections.write).

def is_shared(row) -> bool:
  return bool(row.get('shared', True))


def is_owner(row, user_id: Optional[int]) -> bool:
  return user_id is not None and row.get('created_by_id') == user_id


def is_visible_to(row, user_id: Optional[int]) -> bool:
  return is_shared(row) or is_owner(row, user_id)


def serialize_version(row) -> dict:
  return {
    'version': row['version'],
    'created_by': user_of(row),
    'created_at': iso(row.get('created_at')),
    'notes': row.get('notes') or '',
    'size': int(row.get('size') or 0),
  }


def batch_name(name: str) -> str:
  """A `qa batch` name for a collection: its last segment, e.g. night/hard cases => hard-cases"""
  last = name.split('/')[-1]
  return re.sub(r'[^A-Za-z0-9._-]+', '-', last).strip('-') or 'collection'


def export_yaml(name: str, collection_project: str, project_id: Optional[str], version: Optional[int], size: int,
                latest_version: Optional[int] = None) -> str:
  """A batch that runs on the collection, as the web app shows it: for a batch file (listed in qaboard.yaml's inputs.batches)"""
  ref = ref_of(name, collection_project, project_id or collection_project, version)
  if version:
    about = f"version {version}, {size:,} input{'s' if size != 1 else ''}"
  else:
    about = f"the latest version when the batch starts (now {latest_version or '?'}, {size:,} input{'s' if size != 1 else ''})"
  body = yaml.safe_dump({batch_name(name): {'collections': [ref]}}, sort_keys=False, default_flow_style=False, allow_unicode=True)
  return (
    f"# The collection {name} of {collection_project}: {about}.\n"
    f"# In a batch file that qaboard.yaml lists in inputs.batches, then: qa batch {batch_name(name)}\n"
    f"{body}"
  )


def stale_error(base_version: Optional[int], latest_version: int) -> dict:
  return {
    "error": f"Someone saved version {latest_version} meanwhile: reload to see it, or save anyway.",
    "reason": "stale_version",
    "base_version": base_version,
    "latest_version": latest_version,
  }


def clean_group_id(value) -> Optional[int]:
  """The group of a pin: an id, None for everyone. Query strings send it as text ('' or 'null': everyone)."""
  if value is None or value in ('', 'null', 'everyone'):
    return None
  if isinstance(value, str) and value.isdigit():
    value = int(value)
  if isinstance(value, bool) or not isinstance(value, int) or value <= 0 or value > 2**31 - 1:
    raise CollectionError("`group` must be a group id, or null for everyone")
  return value
