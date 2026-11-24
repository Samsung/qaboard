"""
Inputs in QA-Board before any run (docs/design/inputs-and-collections.md): projects list them on their Inputs page,
and save collections of them, before runs use them.

    import qaboard
    qaboard.inputs.add(["night/0001.raw", "night/0002.raw"], database="/mnt/data", metadata={"sensor": "imx766"})

    qa inputs add night-captures     # the inputs `qa batch night-captures` would run on
    qa inputs add 'night/*.raw'      # or paths, with globs, like `qa batch` takes them

Paths are relative to their database, like runs send theirs: the inputs a run uses later are the same inputs, not
copies. Requests go to the server `qa` sends results to, with the token it uses (qaboard/credentials.py).
"""
from dataclasses import dataclass, field
from pathlib import Path, PurePosixPath
from typing import Any, Dict, Iterable, List, Optional, Tuple, Union

import click

from .input_collections import CollectionError, CollectionInput, current_project

# inputs per request: the server takes at most 10,000 (backend/input_collections.py MAX_ADDED_INPUTS)
CHUNK = 5000

InputLike = Union[str, Path, Tuple[Any, Any], Dict[str, Any]]


@dataclass
class AddedInputs:
  """What `add()` did: `inputs` in the order they were given (with their ids), and how many the project didn't have"""
  project: str
  inputs: List[CollectionInput] = field(default_factory=list)
  added: int = 0
  known: int = 0

  def __len__(self) -> int:
    return len(self.inputs)

  def __iter__(self):
    return iter(self.inputs)


def as_input(item: InputLike, database: Optional[Union[str, Path]] = None, metadata: Optional[Dict] = None) -> Dict[str, Any]:
  """
  {database, path, metadata} as the server takes it. `item` is a path (relative to `database`, or absolute), a
  (database, path) pair, or a mapping {path, database?, metadata?}. Absolute paths outside `database` are under "/",
  as `qa batch` finds them.
  """
  item_metadata = None
  if isinstance(item, dict):
    if 'path' not in item:
      raise CollectionError(f"An input needs a path: {item!r}")
    database, path, item_metadata = item.get('database', database), item['path'], item.get('metadata')
  elif isinstance(item, tuple) and len(item) == 2:
    database, path = item
  elif isinstance(item, (str, Path)):
    path = item
  else:
    raise CollectionError(f"Inputs are paths, (database, path) pairs or {{path, database, metadata}} mappings, not {item!r}")
  path = Path(path)
  if path.is_absolute():
    if database is not None and Path(database).is_absolute():
      try:
        path = path.relative_to(Path(database))
      except ValueError:
        database, path = Path(path.anchor), path.relative_to(path.anchor)
    else:
      database, path = Path(path.anchor), path.relative_to(path.anchor)
  if database is None:
    raise CollectionError(f"In which database is {path}? Give `database=`, or an absolute path.")
  merged = {**(metadata or {}), **(item_metadata or {})}
  return {"database": str(database), "path": PurePosixPath(path.as_posix()).as_posix(), "metadata": merged or None}


def add(inputs: Iterable[InputLike], *, database: Optional[Union[str, Path]] = None, project: Optional[str] = None,
        metadata: Optional[Dict[str, Any]] = None, server: Optional[str] = None, token: Optional[str] = None) -> AddedInputs:
  """
  Adds inputs to the project, before any run: its Inputs page lists them, collections can have them.
  `inputs`: paths relative to `database` (or absolute), (database, path) pairs, or {path, database?, metadata?}.
  `metadata`: for every input, merged into theirs, like runs' input metadata (qaboard.yaml inputs.metadata).
  `project`: by default the project of the current directory's qaboard.yaml. `server`/`token`: by default those `qa` uses.
  Inputs the project already has stay as they are (their metadata is merged). Raises CollectionError when it can't.
  """
  project = project or current_project()
  if not project:
    raise CollectionError("To add inputs, give the project: qaboard.inputs.add(paths, project=\"group/repo\"), "
                          "or run from the folder of a project's qaboard.yaml.")
  items = [as_input(item, database, metadata) for item in inputs]
  result = AddedInputs(project=project)
  if not items:
    return result
  from .credentials import default_server
  from .results import _request, ResultsError
  server = (server or default_server()[0]).rstrip('/')
  for start in range(0, len(items), CHUNK):
    try:
      answer = _request(server, 'inputs', None, token, method='POST', json={"project": project, "inputs": items[start:start + CHUNK]})
    except ResultsError as e:
      if e.status is None:
        from .credentials import describe_network_error
        reason = describe_network_error(e.__cause__) if isinstance(e.__cause__, Exception) else str(e)
        raise CollectionError(f"Could not reach QA-Board at {server} to add inputs: {reason}.", project=project) from None
      done = f" ({result.added} added before the error)" if result.added else ""
      raise CollectionError(f"QA-Board could not add inputs to {project}{done}: {e}", project=project, status=e.status) from None
    result.inputs.extend(CollectionInput(id=i.get('id'), database=str(i['database']), path=str(i['path'])) for i in answer.get('inputs') or [])
    result.added += int(answer.get('added') or 0)
    result.known += int(answer.get('known') or 0)
  return result


@click.group(name='inputs')
def inputs():
  """Inputs in QA-Board, before any run uses them."""
  pass


@inputs.command(name='add', context_settings=dict(ignore_unknown_options=True))
@click.option('--batch', '-b', 'batches', multiple=True, help="A batch whose inputs to add, like `qa batch --batch`.")
@click.option('--batches-file', 'batches_files', type=click.Path(), multiple=True, help="YAML files listing batches. Default: qaboard.yaml's inputs.batches.")
@click.option('--project', default=None, help="Default: the project of the current qaboard.yaml.")
@click.argument('batch_names', nargs=-1)
@click.pass_context
def add_command(ctx, batches, batches_files, project, batch_names):
  """
  Adds to QA-Board the inputs `qa batch` would run on, without running: batch names, or paths (with globs) relative
  to the database, e.g. `qa inputs add night-captures` or `qa inputs add 'night/*.raw'`. The project's Inputs page
  lists them, and collections can have them. With `qa --dryrun`, only prints them.
  """
  from .iterators import iter_inputs
  from .config import default_batches_files, config
  obj = ctx.obj or {}
  names = [*batches, *batch_names]
  if not names:
    raise click.UsageError("Which inputs? Give batch names or paths, e.g. `qa inputs add night-captures`.")
  seen, found = set(), []
  for run_context in iter_inputs(names, list(batches_files) or default_batches_files, obj['database'], obj.get('configurations') or [],
                                 obj.get('platform'), {}, config, obj.get('inputs_settings')):
    key = (str(run_context.database), run_context.input)
    if key not in seen:
      seen.add(key)
      found.append(key)
  if not found:
    raise click.ClickException(f"No inputs found for {' '.join(names)}.")
  if obj.get('dryrun'):
    for database, path in found:
      click.echo(f"{database}\t{path}")
    click.secho(f"{len(found)} input{'s' if len(found) != 1 else ''} would be added.", fg='cyan', err=True)
    return
  result = add(found, project=project)
  click.secho(f"{result.project}: {result.added} input{'s' if result.added != 1 else ''} added, {result.known} it already had.", fg='green', err=True)
