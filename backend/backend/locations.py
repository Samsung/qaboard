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
"""
import os
import re
import time
from dataclasses import dataclass
from pathlib import Path
from typing import List, Optional, Tuple
from urllib.parse import quote, unquote, urlsplit

# "s3://", "gs://", "file://", "az://"...
URL_PATTERN = re.compile(r'^[a-z][a-z0-9+.-]*://', re.IGNORECASE)
# What locations the server can't reach resolve to: a folder that doesn't exist, outside the storage roots
UNREACHABLE = Path('/nonexistent/qaboard-unreachable')
# Locations are edited rarely, and read for every file: each process reads them again after this
TTL = 30.0  # seconds


@dataclass(frozen=True)
class Location:
  url: str            # ends with "/"
  path: Path          # where the server reaches it
  projects: Tuple[str, ...] = ()
  id: Optional[int] = None


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
    print(f"[locations] Could not read the storage locations: {e}")
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


def paths() -> List[Path]:
  """Where the server reaches the locations: like the storage roots, it manages the files there"""
  return [known.path for known in locations()]


def matches(entry: str, project_id: str) -> int:
  """How specifically a location's `projects` entry names a project: 0 when it doesn't"""
  entry = entry.strip('/')
  if entry == '*':
    return 1
  if project_id == entry or project_id.startswith(f"{entry}/"):
    return 2 + len(entry.split('/'))
  return 0


def for_project(project_id: str) -> List[Location]:
  """The locations a project's uploaded runs may be in, those its new runs go to first"""
  scored = [(max((matches(entry, project_id) for entry in known.projects), default=0), known) for known in locations()]
  return [known for score, known in sorted(scored, key=lambda s: (-s[0], -(s[1].id or 0))) if score]
