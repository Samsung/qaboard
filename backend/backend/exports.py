"""
Exports ("Export to a shared folder"): folders of links or copies of runs' files, that users share. QA-Board's runs
don't account for them, and they can be big, so we track them (models/Export.py): users see and delete theirs in
"Storage usage", and storage scans find the ones we didn't track.

- With `storage.exports_root` (a setting), exports all go to <root>/<user>/<project>/<date>-<id>, instead of a share/
  folder next to the commit's runs: easy to find, and not lost among the runs.
- "link" exports are hard links: they share their space with the runs' files. Deleting the runs doesn't free it while
  the export exists, and deleting the export doesn't free it while the runs exist (`linked_bytes`).
"""
import re
import datetime
from pathlib import Path
from typing import Optional

from .database import db_session
from .models import Export
from .fs_utils import measure
from .settings import setting
from . import accounts


EXPORTS_KEPT = 20  # the latest exports into a folder, in Export.data
# files that exports write next to the runs' files: scans recognize exports by them
MARKERS = ('0.qa.url', '0.qa.html', '0.common.json')


def utcnow():
  return datetime.datetime.utcnow()


def safe(name: str) -> str:
  return re.sub(r'[^A-Za-z0-9._-]+', '_', name or 'unknown').strip('._') or 'unknown'


def default_dir(user_name: str, project_id: str, key: str) -> Optional[Path]:
  """Where an export goes, with `storage.exports_root`. None: as before, next to the runs"""
  root = setting('storage.exports_root')
  if not root:
    return None
  project = '/'.join(safe(part) for part in project_id.split('/'))
  return Path(root) / safe(user_name) / project / f"{utcnow():%Y-%m-%d}-{key[:8]}"


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
  export.measured_at = utcnow()
  return export


def record(path, project_id=None, hexsha=None, batch_label=None, user_name=None, export_type=None, filter=None, nb_files=None) -> Export:
  """After exporting: the folder is tracked, with its size. The caller commits."""
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
                  "type": export_type, "filter": filter, "files": nb_files})
  export.data = {**(export.data or {}), "exports": history[-EXPORTS_KEPT:]}
  try:
    measure_export(export)
  except Exception as e:
    print(f"WARNING: could not measure the export {path}: {e}")
  db_session.flush()
  return export


def iso(date):
  return f"{date.isoformat()}Z" if date else None


def serialize(export: Export) -> dict:
  return {
    "id": export.id,
    "path": export.path,
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
  }
