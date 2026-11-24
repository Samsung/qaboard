"""
Collections: named, versioned lists of inputs saved in QA-Board (docs/design/inputs-and-collections.md).

    import qaboard
    collection = qaboard.collections.get("night/hard-cases@2")
    for item in collection:
      item.path           # relative to item.database
      item.absolute_path  # database / path

Batches run on collections with their `collections` key, next to `inputs` (qaboard/iterators.py):

    hard-cases:
      collections: [night/hard-cases@2]

The server resolves references (GET /api/v1/collections/resolve): `name` (the latest version), `name@3`,
`name@latest`, or `project:name@3` for a collection of another project. Without an explicit project, a name
resolves to the project's collection, else to the nearest ancestor project's.

Requests go to the server `qa` sends results to, with the token it uses (qaboard/credentials.py). Importing this
module reads neither qaboard.yaml nor git: only get() without `project` does, to know the current project.
"""
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, Iterator, List, Optional, Tuple

import click


class CollectionError(click.ClickException, ValueError):
  """We could not get a collection: the message says why, and what to do. `qa` prints "Error: <message>"."""
  def __init__(self, message: str, ref: Optional[str] = None, project: Optional[str] = None, status: Optional[int] = None):
    super().__init__(message)
    self.ref = ref
    self.project = project
    self.status = status


class CollectionNotFound(CollectionError):
  """The server doesn't know the collection, or the version, from this project."""


@dataclass(frozen=True)
class CollectionInput:
  """
  An input of a collection: `for item in collection: item.path`.
  An object, not a tuple, so that it can say more about the input as collections do (per-input options, regions).
  `data`: the input's data in the collection ({} when there is none), `region`: the region of the input it is about,
  if any (None: the whole input).
  """
  id: Optional[int]
  database: str
  path: str
  data: Dict[str, Any] = field(default_factory=dict, compare=False, hash=False)
  region: Optional[Any] = field(default=None, compare=False, hash=False)

  @property
  def absolute_path(self) -> Path:
    return Path(self.database) / self.path


@dataclass
class Collection:
  """
  A version of a collection, as the server resolved a reference.
  `project` is the project that owns the collection (maybe an ancestor of the one asked from), `ref` the reference
  that was asked for, `name` and `version` what it resolved to.
  """
  ref: str
  project: Optional[str]
  name: str
  version: int
  inputs: List[CollectionInput] = field(default_factory=list)
  id: Optional[int] = None

  @property
  def pinned_ref(self) -> str:
    """A reference to this exact version, e.g. "night/hard-cases@2", for reproducible batches"""
    return f"{self.name}@{self.version}"

  def __len__(self) -> int:
    return len(self.inputs)

  def __iter__(self) -> Iterator[CollectionInput]:
    return iter(self.inputs)

  def to_dict(self) -> Dict[str, Any]:
    return {
      "id": self.id, "ref": self.ref, "project": self.project, "name": self.name, "version": self.version,
      "inputs": [_input_dict(i) for i in self.inputs],
    }


def _input_dict(i: CollectionInput) -> Dict[str, Any]:
  """{id, database, path}, with data and region only when they are set: `qa collections show --json` prints it"""
  return {"id": i.id, "database": i.database, "path": i.path, **({"data": i.data} if i.data else {}), **({"region": i.region} if i.region is not None else {})}


def _input_from(i: Dict[str, Any]) -> CollectionInput:
  """A CollectionInput from {id, database, path, data?, region?}, as the server answers (or Collection.to_dict wrote)"""
  data = i.get('data')
  return CollectionInput(id=_int_or_none(i.get('id')), database=str(i.get('database') or '.'), path=str(i['path']),
                         data=dict(data) if isinstance(data, dict) else {}, region=i.get('region'))


# The server lists the runs of batches with the project's code in a `qa batch --list` it starts, without a token to
# ask it for collections: it resolves those of the batch files first, and gives them in this file (backend/api/tuning.py).
# JSON: {"collections": {"<ref as written>": Collection.to_dict() | {"error": message, "status": 404}}}
RESOLVED_COLLECTIONS_ENV = 'QABOARD_RESOLVED_COLLECTIONS'


def resolver_from_file(path: str):
  """A resolver (ref, project) -> Collection for qaboard.iterators, that only reads the server's file: never the network"""
  import json
  try:
    with open(path, encoding='utf-8') as f:
      resolved = json.load(f).get('collections') or {}
  except (OSError, ValueError, AttributeError) as e:
    resolved, problem = {}, str(e)
  else:
    problem = None

  def resolve(ref: str, project: Optional[str] = None) -> Collection:
    found = resolved.get(ref.strip())
    if found is None:
      raise CollectionError(
        f"QA-Board lists this batch with the project's code, and couldn't resolve the collection {ref!r} for it"
        f"{f' ({problem})' if problem else ''}: it only resolves the `collections` written in the batch files. "
        "Write it in the batch's `collections` in a batch file, or start the batch from the CLI.", ref=ref, project=project)
    if 'error' in found:
      status = found.get('status')
      raise (CollectionNotFound if status == 404 else CollectionError)(str(found['error']), ref=ref, project=project, status=status)
    return Collection(
      ref=ref, project=found.get('project'), name=str(found.get('name') or ''), version=int(found['version']), id=found.get('id'),
      inputs=[_input_from(i) for i in found.get('inputs') or [] if isinstance(i, dict) and 'path' in i],
    )
  return resolve


# project:name@version, the project and the version optional
_REF = re.compile(r'^(?:(?P<project>[^:@]+):)?(?P<name>[^:@]+)(?:@(?P<version>[^:@]*))?$')


def parse_ref(ref: str) -> Tuple[Optional[str], str, Optional[int]]:
  """
  ("project" or None, "name", version or None for the latest) from a reference like `a/b:night/hard@2`.
  Only checks the shape: the server normalizes names.
  """
  match = _REF.match(ref.strip()) if isinstance(ref, str) else None
  if not match or not match.group('name').strip():
    raise CollectionError(f'Invalid collection reference {ref!r}: write "name", "name@3", "name@latest" or "project:name@3".', ref=str(ref))
  version_str = match.group('version')
  version: Optional[int] = None
  if version_str is not None and version_str != 'latest':
    if not version_str.isdigit() or int(version_str) < 1:
      raise CollectionError(f'Invalid version in the collection reference {ref!r}: write "@3" for version 3, or "@latest".', ref=ref)
    version = int(version_str)
  project = match.group('project').strip() if match.group('project') else None
  return project, match.group('name').strip(), version


def current_project() -> Optional[str]:
  """The id of the (sub)project of the current directory's qaboard.yaml, e.g. "group/repo/subproject", like `qa` uses."""
  from .config import project
  return Path(project).as_posix() if project else None


def get(ref: str, project: Optional[str] = None, *, server: Optional[str] = None, token: Optional[str] = None) -> Collection:
  """
  The inputs of a collection, from QA-Board: `get("night/hard-cases@2")`.
  `ref`: `name` (the latest version), `name@3`, `name@latest`, or `project:name@3`.
  `project`: the project to resolve the name from. By default the project the reference names (`a/b:night@2`), else
  the project of the current directory's qaboard.yaml.
  `server`/`token`: by default those `qa` uses.
  Raises CollectionNotFound when there is no such collection or version, CollectionError for other problems.
  """
  ref_project, name, pinned_version = parse_ref(ref)
  ref = ref.strip()
  if project is None:
    # `a/b:night@2` says where it is: no need for a qaboard.yaml (nor to read it)
    project = ref_project or current_project()
  if not project:
    raise CollectionError(f"To find the collection {ref!r}, give the project: qaboard.collections.get({ref!r}, project=\"group/repo\"), "
                          "or run from the folder of a project's qaboard.yaml.", ref=ref)
  from .credentials import default_server
  from .results import _request, ResultsError
  server = (server or default_server()[0]).rstrip('/')
  try:
    data = _request(server, 'collections/resolve', {"project": project, "ref": ref}, token)
  except ResultsError as e:
    if e.status == 404:
      error = e.body.get('error') if isinstance(e.body, dict) else None
      raise CollectionNotFound(
        f"No collection {ref!r} for the project {project}{f' ({error})' if error else ''}. "
        f"Check its name and version on the project's Collections in QA-Board ({server}): "
        "collections belong to a project or to one of its ancestors.", ref=ref, project=project, status=404) from None
    if e.status is None:
      from .credentials import describe_network_error
      reason = describe_network_error(e.__cause__) if isinstance(e.__cause__, Exception) else str(e)
      raise CollectionError(
        f"Could not reach QA-Board at {server} to resolve the collection {ref!r}: {reason}. Collections are resolved by "
        "the server: check that it is up and that QABOARD_URL (or QABOARD_HOST) points to it.", ref=ref, project=project) from None
    raise CollectionError(f"QA-Board could not resolve the collection {ref!r} for the project {project}: {e}", ref=ref, project=project, status=e.status) from None
  collection = from_api(data, ref=ref, project=project)
  if pinned_version is not None and collection.version != pinned_version:
    raise CollectionError(f"Asked for {ref!r} but QA-Board answered version {collection.version}.", ref=ref, project=project)
  if not collection.name:
    collection.name = name
  return collection


def _int_or_none(value: Any) -> Optional[int]:
  try:
    return int(value)
  except (TypeError, ValueError):
    return None


def from_api(data: Dict[str, Any], ref: str, project: Optional[str] = None) -> Collection:
  """
  A Collection from GET /collections/resolve: {collection, version, project, inputs: [{id, database, path, data?, region?}]}.
  `collection` is the Collection object (or its name), `version` the version number (or its object).
  """
  if not isinstance(data, dict):
    raise CollectionError(f"Unexpected answer from QA-Board when resolving the collection {ref!r}: {str(data)[:200]}", ref=ref, project=project)
  described = data.get('collection')
  collection = described if isinstance(described, dict) else {}
  name = collection.get('name') or (described if isinstance(described, str) else None) or data.get('name') or ''
  version = data.get('version')
  if isinstance(version, dict):
    version = version.get('version')
  version_number = _int_or_none(version)
  if version_number is None:
    raise CollectionError(f"Unexpected answer from QA-Board when resolving the collection {ref!r}: no version.", ref=ref, project=project)
  inputs = []
  for i in data.get('inputs') or []:
    if not isinstance(i, dict) or 'path' not in i:
      continue
    inputs.append(_input_from(i))
  return Collection(
    ref=ref,
    project=data.get('project') or collection.get('project') or project,
    name=str(name),
    version=version_number,
    inputs=inputs,
    id=_int_or_none(collection.get('id')),
  )


@click.group(name='collections')
def collections():
  """Collections of inputs saved in QA-Board."""
  pass


@collections.command(name='show')
@click.argument('ref')
@click.option('--project', default=None, help="The project to resolve the name from. Default: the project of the current qaboard.yaml.")
@click.option('--json', 'as_json', is_flag=True, help="Print the collection as JSON: {id, ref, project, name, version, inputs: [{id, database, path}]}")
def show(ref, project, as_json):
  """
  Prints the inputs of a collection, one "database<TAB>path" per line, e.g. `qa collections show night/hard-cases@2`.
  REF: name (the latest version), name@3, name@latest, or project:name@3.
  """
  collection = get(ref, project=project)
  if as_json:
    import json
    click.echo(json.dumps(collection.to_dict(), indent=2))
    return
  owner = f"{collection.project}:" if collection.project and collection.project != (project or current_project()) else ""
  click.secho(f"{owner}{collection.pinned_ref}: {len(collection.inputs)} input{'s' if len(collection.inputs) != 1 else ''}", fg='cyan', err=True)
  for i in collection.inputs:
    click.echo(f"{i.database}\t{i.path}")
