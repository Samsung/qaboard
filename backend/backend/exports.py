"""
Exports ("Export to a shared folder"): folders of links or copies of runs' files, that users share. QA-Board's runs
don't account for them, and they can be big, so we track them (models/Export.py): users see and delete theirs in
"Storage usage", and storage scans find the ones we didn't track.

- Each export goes to a new folder, <date>-<name>-<id> (the name is optional, users give it when they export).
  With `storage.exports_root` (a setting), in <root>/<user>/<project>/, else in a share/ folder next to the commit's
  runs. In <root>, they're easy to find, and not lost among the runs. Users can also choose a folder.
- "link" exports are hard links: they share their space with the runs' files. Deleting the runs doesn't free it while
  the export exists, and deleting the export doesn't free it while the runs exist (`linked_bytes`).
- Scans track the exports they find, e.g. made before QA-Board tracked them (`found`). Deleting an export deletes its
  folder: when a scan found it in a folder QA-Board didn't make, users may have other files there, so only admins and
  whoever owns all its files delete it (`in_chosen_folder`). QA-Board itself only records exports into folders it made.
"""
import re
import datetime
from pathlib import Path
from typing import Optional
from urllib.parse import urlparse, parse_qs, unquote

from .database import db_session
from .models import Export
from .fs_utils import measure
from .settings import setting
from . import accounts


EXPORTS_KEPT = 20  # the latest exports into a folder, in Export.data
# files that exports write next to the runs' files: scans recognize exports by them
MARKERS = ('0.qa.url', '0.qa.html', '0.export.json', '0.export.csv', '0.common.json')
# the folders QA-Board makes for exports: share/<date>-<name>-<8 hex> next to a commit's runs (share/<8 hex> before),
# <date>-<name>-<8 hex> in `storage.exports_root`. The name is optional.
own_folder = re.compile(r'/share/(?:\d{4}-\d{2}-\d{2}-(?:[A-Za-z0-9._-]+-)?)?[0-9a-f]{8}$')
own_folder_in_root = re.compile(r'/\d{4}-\d{2}-\d{2}-(?:[A-Za-z0-9._-]+-)?[0-9a-f]{8}$')


def utcnow():
  return datetime.datetime.utcnow()


def safe(name: str) -> str:
  return re.sub(r'[^A-Za-z0-9._-]+', '_', name or 'unknown').strip('._') or 'unknown'


def folder_name(name: str, key: str) -> str:
  """<date>-<name>-<id>: the export's own folder. The name is what users called the export, if they did"""
  name = re.sub(r'[^A-Za-z0-9._-]+', '-', name or '').strip('._-')[:60].strip('._-')
  return f"{utcnow():%Y-%m-%d}-{name + '-' if name else ''}{key[:8]}"


def default_dir(user_name: str, project_id: str, key: str, name: str = '') -> Optional[Path]:
  """Where an export goes, with `storage.exports_root`, <date>-<name>-<id>. None: as before, next to the runs"""
  root = setting('storage.exports_root')
  if not root:
    return None
  project = '/'.join(safe(part) for part in project_id.split('/'))
  return Path(root) / safe(user_name) / project / folder_name(name, key)


def owner_name(uid: int) -> str:
  """With QABOARD_ACCOUNTS_COMMAND's accounts, like the file browser, not only the server's /etc/passwd"""
  return accounts.owner_name(uid)


def measure_export(export: Export) -> Export:
  totals = measure(Path(export.path))
  export.bytes = totals['bytes']
  export.linked_bytes = totals['linked_bytes']
  export.files = totals['files']
  owners = sorted(totals['owners'].items(), key=lambda kv: -kv[1])
  export.owner = owner_name(owners[0][0]) if owners else export.owner
  # everyone with files in it: who may delete an export in a folder someone chose
  names = {}
  for uid, size in owners:
    names[owner_name(uid)] = names.get(owner_name(uid), 0) + size
  export.data = {**(export.data or {}), "owners": names}
  export.measured_at = utcnow()
  return export


def record(path, project_id=None, hexsha=None, batch_label=None, user_name=None, export_type=None, filter=None, nb_files=None,
           name=None, details=None) -> Export:
  """After exporting: the folder is tracked, with its size. `name`: what users called the export. The caller commits."""
  path = str(path)
  export = Export.query.filter(Export.path == path).one_or_none()
  now = utcnow()
  if export is None:
    export = Export(path=path, project_id=project_id, hexsha=hexsha, batch_label=batch_label, created_by=user_name, source='web', created_at=now, data={})
    db_session.add(export)
  export.updated_at = now
  export.deleted_at, export.deleted_by = None, None
  history = list((export.data or {}).get('exports') or [])
  history.append({"at": now.isoformat() + 'Z', "by": user_name, "project": project_id, "commit": hexsha, "batch": batch_label,
                  "type": export_type, "filter": filter, "files": nb_files, **(details or {})})
  export.data = {**(export.data or {}), "exports": history[-EXPORTS_KEPT:]}
  if name:
    export.data = {**export.data, "name": name}
  try:
    measure_export(export)
  except Exception as e:
    print(f"WARNING: could not measure the export {path}: {e}")
  db_session.flush()
  return export


def made_by_qaboard(path: str, exports_root: Optional[str]) -> bool:
  """If QA-Board made the export's folder, rather than users choosing a folder, where they may have other files"""
  if own_folder.search(path):
    return True
  return bool(exports_root) and path.startswith(exports_root.rstrip('/') + '/') and bool(own_folder_in_root.search(path))


def in_chosen_folder(export: Export) -> bool:
  """A scan found it in a folder QA-Board didn't make: deleting it deletes what else users have there"""
  return export.source == 'scan' and not made_by_qaboard(export.path, setting('storage.exports_root'))


def origin(path) -> dict:
  """The project, commit and batch of an export, from its 0.qa.url: URL=<QA-Board>/<project>/commit/<hexsha>?batch=<label>..."""
  try:
    with open(Path(path) / '0.qa.url', errors='replace') as f:
      content = f.read(10_000)
  except OSError:
    return {}
  line = re.search(r'^URL=(\S+)', content, re.MULTILINE)
  url = urlparse(line.group(1)) if line else None
  match = re.match(r'/(?P<project>.+)/commit/(?P<hexsha>[0-9a-f]{7,40})/?$', url.path) if url else None
  if not match:
    return {}
  batch = parse_qs(url.query).get('batch')
  return {"project_id": unquote(match['project']), "hexsha": match['hexsha'], "batch_label": batch[0] if batch else None}


def found(path: str, session=db_session, owner: Optional[str] = None, bytes=None, files=None, changed_at=None, scan_id=None) -> Export:
  """
  Tracks an export a scan found: its owner sees it in "Storage usage". With its project, commit and batch, if its
  0.qa.url says. Measured like the exports QA-Board makes, else with the scan's numbers. The caller commits.
  """
  export = session.query(Export).filter(Export.path == path).one_or_none()
  now = utcnow()
  if export is None:
    export = Export(path=path, source='scan', created_at=changed_at or now, updated_at=changed_at or now, data={})
    session.add(export)
  export.deleted_at, export.deleted_by = None, None
  for key, value in origin(path).items():
    if value and not getattr(export, key):
      setattr(export, key, value)
  export.owner = owner or export.owner
  export.bytes, export.files, export.measured_at = bytes, files, now
  export.data = {**(export.data or {}), "scan_id": scan_id}
  try:
    measure_export(export)
  except Exception as e:
    print(f"WARNING: could not measure the export {path}: {e}")
  session.flush()
  return export


def iso(date):
  return f"{date.isoformat()}Z" if date else None


def serialize(export: Export) -> dict:
  return {
    "id": export.id,
    "path": export.path,
    "name": (export.data or {}).get('name'),
    "project_id": export.project_id,
    "hexsha": export.hexsha,
    "batch_label": export.batch_label,
    "created_by": export.created_by,
    "owner": accounts.resolve(export.owner),
    "source": export.source,
    "created_at": iso(export.created_at),
    "updated_at": iso(export.updated_at),
    "bytes": export.bytes,
    "linked_bytes": export.linked_bytes,
    "files": export.files,
    "measured_at": iso(export.measured_at),
    "deleted_at": iso(export.deleted_at),
    "exports": len((export.data or {}).get('exports') or []),
    "in_chosen_folder": in_chosen_folder(export),
  }
