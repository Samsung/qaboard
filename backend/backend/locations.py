"""
Where runs' files are. Each run stores its location in full (outputs.output_dir_override):
- an absolute path: a folder the server reads directly, like every run before storage locations ("/mnt/qaboard/...")
- a URL: "s3://team-a/qaboard/proj/-/...", "file:///mnt/disk2/...". How the server reaches it comes from the
  storage locations admins add while it runs (models/StorageLocation.py, `qaboard-admin storage-locations`): the
  most specific one whose `url` starts the run's location says where it is mounted.

Runs never store a location's id or name: editing a location (where it's mounted, later its credentials) changes how
we reach its runs, not what they say, and a location removed by mistake strands nothing once added back. Only data
that moved needs its runs' locations rewritten, like with any path.

The server reads and writes locations through folders (mounted buckets: website/docs/backend-admin/uploads.mdx), so
the rest of the server only ever sees paths: Output.output_dir is `local_path(output_dir_override)`.
Locations the server can't reach are paths under UNREACHABLE: nothing exists there, nothing can be written there.

The upload root ($QABOARD_UPLOAD_ROOT, or the default storage: config.py) is the default location: the projects no
location lists upload there. It has no URL: its runs store paths, like before locations existed.

Where the server may write is set in its environment ($QABOARD_STORAGE_ROOTS): a location's folder must be inside a
storage root, so that whoever adds locations (an admin's session in the web app) can't point the server at any folder.
Locations added before that check stay readable, flagged by `outside_storage_roots`.
"""
import logging
import os
import re
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable, List, Optional, Tuple
from urllib.parse import quote, unquote, urlsplit

from . import config

logger = logging.getLogger(__name__)

# "s3://", "gs://", "file://", "az://"...
URL_PATTERN = re.compile(r'^[a-z][a-z0-9+.-]*://', re.IGNORECASE)
# What locations the server can't reach resolve to: a folder that doesn't exist, outside the storage roots
UNREACHABLE = Path('/nonexistent/qaboard-unreachable')
# Locations are edited rarely, and read for every file: each process reads them again after this
TTL = 30.0  # seconds


@dataclass(frozen=True)
class Location:
  url: Optional[str]  # ends with "/". None for the default location: its runs store paths
  path: Path          # where the server reaches it
  projects: Tuple[str, ...] = ()
  id: Optional[int] = None

  @property
  def is_default(self) -> bool:
    return self.url is None


class LocationError(ValueError):
  """A change admins asked for that we refuse, with what to do instead"""
  def __init__(self, message: str, reason: str = 'invalid'):
    super().__init__(message)
    self.reason = reason  # invalid, not_found, exists, outside_storage_roots, not_a_folder, has_runs


_cache = {"expires": 0.0, "locations": ()}


def is_url(location) -> bool:
  return bool(URL_PATTERN.match(str(location)))


def normalize_url(url: str) -> str:
  """A location's url as we store and compare them: lowercase scheme, no query, ending with "/" """
  if not is_url(url):
    raise ValueError(f"{url!r} is not a URL like s3://bucket/prefix/ or file:///mnt/disk/")
  parts = urlsplit(url)
  if parts.query or parts.fragment:
    raise ValueError(f"{url!r}: locations' URLs have no query (?...) or fragment (#...)")
  path = parts.path if parts.path.endswith('/') else f"{parts.path}/"
  if any(part in ('.', '..') for part in path.split('/')):
    raise ValueError(f"{url!r}: no \".\" or \"..\" in locations' URLs")
  return f"{parts.scheme.lower()}://{parts.netloc}{path}"


def invalidate() -> None:
  _cache["expires"] = 0.0


def locations() -> Tuple[Location, ...]:
  """The storage locations admins added, most specific url first"""
  now = time.monotonic()
  if now >= _cache["expires"]:
    _cache.update(expires=now + TTL, locations=_load())
  return _cache["locations"]


def _load() -> Tuple[Location, ...]:
  try:
    from .models import StorageLocation
    rows = StorageLocation.query.all()
  except Exception as e:  # e.g. before the migration: the server works without
    logger.warning("Could not read the storage locations: %s", e)
    return ()
  return sort(Location(url=row.url, path=Path(row.path), projects=tuple(row.projects or ()), id=row.id) for row in rows)


def sort(items) -> Tuple[Location, ...]:
  # most specific first; with the same url (can't happen in the table) the newest
  return tuple(sorted(items, key=lambda l: (-len(l.url), -(l.id or 0))))


def local_path(location) -> Path:
  """The folder where the server reads a run's location (outputs.output_dir_override)"""
  location = str(location)
  if not is_url(location):
    return Path(location)
  for known in locations():
    if location.startswith(known.url) or f"{location}/" == known.url:
      rest = unquote(location[len(known.url):])
      return _join(known.path, rest)
  parts = urlsplit(location)
  if parts.scheme.lower() == 'file' and parts.netloc in ('', 'localhost'):
    return Path(unquote(parts.path))
  return _join(UNREACHABLE / parts.scheme.lower(), f"{parts.netloc}{unquote(parts.path)}")


def _join(base: Path, rest: str) -> Path:
  parts = [part for part in rest.split('/') if part]
  if any(part in ('.', '..') for part in parts):
    # never out of the location
    return UNREACHABLE
  return base.joinpath(*parts)


def location_of(path) -> str:
  """What a run whose files the server saves in `path` stores: the URL of its location, else the path"""
  path = Path(os.path.normpath(path))
  for known in sorted(locations(), key=lambda l: -len(l.path.parts)):
    if path == known.path or path.is_relative_to(known.path):
      rest = path.relative_to(known.path).as_posix()
      return known.url + ('' if rest == '.' else quote(rest))
  return str(path)


def is_reachable(location) -> bool:
  return not local_path(location).is_relative_to(UNREACHABLE)


def default() -> Optional[Location]:
  """The upload root, as a location: where the projects that no location lists upload. None: they can't upload"""
  root = config.upload_root
  return Location(url=None, path=Path(root), projects=('*',)) if root is not None else None


def paths() -> List[Path]:
  """Where the server reaches the locations, the default one included: like the storage roots, it manages the files there"""
  builtin = default()
  return list(dict.fromkeys([*(known.path for known in locations()), *([builtin.path] if builtin else [])]))


def outside_storage_roots(path) -> bool:
  """Whether a location's folder isn't inside $QABOARD_STORAGE_ROOTS (symlinks resolved): only added before we checked"""
  real = Path(os.path.realpath(path))
  return not any(real.is_relative_to(os.path.realpath(root)) for root in config.storage_roots)


def matches(entry: str, project_id: str) -> int:
  """How specifically a location's `projects` entry names a project: 0 when it doesn't"""
  entry = entry.strip('/')
  if entry == '*':
    return 1
  if project_id == entry or project_id.startswith(f"{entry}/"):
    return 2 + len(entry.split('/'))
  return 0


def for_project(project_id: str) -> List[Location]:
  """Where a project's new uploaded runs go, first: the locations that list it, most specific first, then the default one"""
  scored = [(max((matches(entry, project_id) for entry in known.projects), default=0), known) for known in locations()]
  listed = [known for score, known in sorted(scored, key=lambda s: (-s[0], -(s[1].id or 0))) if score]
  builtin = default()
  return [*listed, *([builtin] if builtin else [])]


# ==========================================
# Changes, from `qaboard-admin storage-locations` and the admin API. Callers commit.
def check_path(path: str, check: bool = True) -> str:
  """A location's folder, normalized, or a LocationError"""
  from .storage import private_dirs
  if not isinstance(path, str) or not os.path.isabs(path):
    raise LocationError(f"{path} must be an absolute path: where the server reaches the location, e.g. where the bucket is mounted.")
  real = Path(os.path.realpath(path))
  if any(real.is_relative_to(d) or d.is_relative_to(real) for d in private_dirs()):
    raise LocationError(f"{path} is one of the server's own folders.")
  if outside_storage_roots(path):
    roots = ':'.join(str(root) for root in config.storage_roots)
    raise LocationError(f"{path} isn't in the storage roots ({roots}): the server only writes there. Mount the storage inside one, "
                        "or add its folder to QABOARD_STORAGE_ROOTS and restart the server.", 'outside_storage_roots')
  if check and not real.is_dir():
    raise LocationError(f"{path} isn't a folder the server sees: mount the storage there first, in every container of the backend, "
                        "the proxy and the image server.", 'not_a_folder')
  return os.path.normpath(path)


def check_projects(projects) -> List[str]:
  if projects is None:
    return []
  if isinstance(projects, str) or not all(isinstance(p, str) and p.strip() for p in projects):
    raise LocationError("Projects are a list of project ids, groups' ids (`team-a/`) or \"*\".")
  return list(dict.fromkeys(p.strip() for p in projects))


def _url(url) -> str:
  try:
    return normalize_url(url)
  except (ValueError, TypeError) as e:
    raise LocationError(str(e))


def find(url):
  """The table's row for a location's url, or None"""
  from .models import StorageLocation
  return StorageLocation.query.filter(StorageLocation.url == _url(url)).one_or_none()


def runs_in(url: str) -> int:
  """How many runs say they are in a location"""
  from .models import Output
  return Output.query.filter(Output.output_dir_override.startswith(url, autoescape=True)).count()


def add(url: str, path: str, projects: Iterable[str] = (), check: bool = True, record: Optional[Callable] = None):
  """Adds a location: its runs store <url>/<their folder>, the server reaches them in `path`"""
  from backend import db_session
  from .models import StorageLocation
  from .audit import audit
  url = _url(url)
  if find(url) is not None:
    raise LocationError(f"{url} is already a location: change it instead.", 'exists')
  row = StorageLocation(url=url, path=check_path(path, check), projects=check_projects(projects), options={})
  db_session.add(row)
  db_session.flush()
  (record or audit)('storage_location.create', target_type='storage_location', target_id=row.id, target_label=url,
                    meta={"path": row.path, "projects": row.projects})
  invalidate()
  return row


def update(url: str, path: Optional[str] = None, projects: Optional[Iterable[str]] = None, check: bool = True,
           record: Optional[Callable] = None):
  """Changes where the server reaches a location (its runs don't change), or whose new runs go there"""
  from .audit import audit
  row = find(url)
  if row is None:
    raise LocationError(f"No location {url}.", 'not_found')
  changes = {}
  new_path = check_path(path, check) if path is not None else row.path
  if new_path != row.path:
    changes["path"] = {"from": row.path, "to": new_path}
    row.path = new_path
  new_projects = check_projects(projects) if projects is not None else list(row.projects or [])
  if new_projects != list(row.projects or []):
    changes["projects"] = {"from": row.projects, "to": new_projects}
    row.projects = new_projects
  if changes:
    (record or audit)('storage_location.update', target_type='storage_location', target_id=row.id, target_label=row.url, changes=changes)
  invalidate()
  return row, changes


def remove(url: str, force: bool = False, record: Optional[Callable] = None) -> int:
  """Removes a location, not its files. Refused while runs are in it, unless `force`. Returns how many runs were"""
  from backend import db_session
  from .audit import audit
  row = find(url)
  if row is None:
    raise LocationError(f"No location {url}.", 'not_found')
  runs = runs_in(row.url)
  if runs and not force:
    raise LocationError(f"{runs} runs are in {row.url}: the web app couldn't show their files. Stop new runs from going there "
                        "(no projects), or remove it anyway.", 'has_runs')
  (record or audit)('storage_location.delete', target_type='storage_location', target_id=row.id, target_label=row.url,
                    meta={"path": row.path, "runs": runs})
  db_session.delete(row)
  invalidate()
  return runs


def serialize(row, runs: Optional[int] = None) -> dict:
  return {
    "id": row.id,
    "url": row.url,
    "path": row.path,
    "projects": list(row.projects or []),
    "outside_storage_roots": outside_storage_roots(row.path),
    "reachable": Path(row.path).is_dir(),
    **({"runs": runs} if runs is not None else {}),
  }
