"""
"Export" on the commit page: links or copies of runs' files, gathered in a folder.

The web app decides what goes where: it sends the runs to export, what each run's new and reference results are
called, the settings that tell runs on the same input apart (`fields`), and a naming template. The server lists each
run's files matching a pattern, names them with the same logic as the web app (qaboard/export_names.py), and:
- POST /api/v1/exports/preview: says what the export would do, without writing anything: the names, the names used
  by several files, the files already there, the paths too long for Windows, the errors.
- POST /api/v1/exports: exports, into a new folder by default (one per export), and writes what it did next to the
  files: 0.export.csv (each file, and where it comes from) and 0.export.json (with the runs' configurations).

With `windows` (the default), names must work on Windows: names that differ only by case are the same name, and full
paths, as Windows users see them (qaboard.compat.linux_to_windows), must be under 260 characters.

The older API, /api/v1/export (backend/api/export_to_folder.py), is deprecated but unchanged, for scripts.

In folders that were there before, we only add files: they're someone's, maybe not the user's.
We replace files only in the folders of our exports, and never delete folders.
"""
import os
import re
import csv
import io
import json
import shutil
import datetime
from pathlib import Path
from collections import defaultdict
from dataclasses import dataclass, field

from requests.utils import quote
from flask import request, jsonify, g
from sqlalchemy.orm import joinedload


from qaboard.compat import windows_to_linux_path, linux_to_windows
from qaboard.export_names import FIELDS, ExportNameError, file_name, input_fields, parse_template
from backend import app, db_session

from backend.fs_utils import as_user, mkdir_shared
from backend.storage import check_storage_path, check_inside, UnsafePathError
from ..models import Batch, Output
from ..config import qaboard_url
from .auth import login_required, require_project_access


# what the preview lists: the counts are always complete
LISTED_FILES = 500
LISTED_PROBLEMS = 50
MAX_RUNS = 50_000
# Windows' MAX_PATH is 260 characters with the final NUL: Explorer and many apps can't open longer paths
WINDOWS_MAX_PATH = 259
DEFAULT_TEMPLATE = "{input}__{settings}__{file}__{side}"
# **/**.png => Invalid pattern: '**' can only be an entire path component
invalid_globstar = re.compile(r'(?:^|/)(\*\*(?!/?$|/))')
folder_id = re.compile(r'^[0-9a-f]{8}$')


class ExportError(Exception):
  """The request can't be done: a 4xx with this message"""
  def __init__(self, message, status=400):
    super().__init__(message)
    self.status = status


@dataclass
class Item:
  """A run to export, under a name: the same reference run can be exported once per new run it's compared to"""
  output: object
  side: str
  fields: dict = field(default_factory=dict)


def default_fields(output) -> dict:
  commit = output.batch.ci_commit
  return {
    **input_fields(str(output.test_input.path)),
    'platform': output.platform or '',
    'commit': (commit.hexsha or '')[:8],
    'batch': output.batch.label or '',
    'run': str(output.id),
    'side': '',
    'settings': '',
  }


def check_pattern(pattern: str) -> str:
  pattern = (pattern or '').strip().replace('\\', '/')
  if not pattern:
    raise ExportError("Which files? Give a pattern, like *.png")
  if pattern.startswith('/'):
    raise ExportError("File patterns are relative to the runs' folders, like *.png or **/*.jpg")
  if '..' in pattern.split('/'):
    raise ExportError("File patterns can't go out of the runs' folders (..)")
  if invalid_globstar.search(pattern):
    raise ExportError("** must be a whole folder in patterns, like **/*.jpg")
  return pattern


def list_files(output, pattern):
  """The run's files matching the pattern, and how many folders matched (we export files)"""
  if output.deleted:
    return [], 0
  output_dir = output.output_dir
  files, folders = [], 0
  for path in sorted(output_dir.glob(pattern)):
    if path.is_dir():
      folders += 1
    elif path.exists():
      files.append(path)
  return files, folders


def make_plan(items, pattern, template, separator, export_dir=None, folder=None, windows=True):
  """
  What goes where: {files: [{to, source, file, item}], collisions, errors...}.
  `export_dir`: a folder that exists, to say which files are there already. `folder`: where the export goes.
  With `windows`, names are case-insensitive (Windows shares can't have img.png and IMG.png), and full paths, as
  Windows users see them, must be short enough.
  """
  parse_template(template)
  files, errors = [], defaultdict(int)
  listed, without_files, folders = {}, set(), 0
  seen = set()
  for index, item in enumerate(items):
    output = item.output
    if output.id not in listed:
      try:
        listed[output.id], run_folders = list_files(output, pattern)
        folders += run_folders
      except (OSError, ValueError) as e:
        listed[output.id] = []
        errors[f"Could not list the files of run {output.id}: {e}"] += 1
    if not listed[output.id]:
      without_files.add(output.id)
      continue
    output_dir = output.output_dir
    fields = {**default_fields(output), **item.fields}
    for path in listed[output.id]:
      rel = path.relative_to(output_dir).as_posix()
      try:
        to = file_name(template, fields, rel, separator, windows=windows)
      except ExportNameError as e:
        errors[str(e)] += 1
        continue
      if (str(path), to) in seen:
        continue
      seen.add((str(path), to))
      files.append({"to": to, "source": path, "file": rel, "item": index})
  by_name = defaultdict(list)
  for f in files:
    by_name[f['to'].lower() if windows else f['to']].append(f)
  collisions = [same for same in by_name.values() if len({str(f['source']) for f in same}) > 1]
  for f in files:
    f['exists'] = export_dir is not None and os.path.lexists(export_dir / f['to'])
  existing = [f for f in files if f['exists']]
  too_long = []
  if windows and folder is not None:
    windows_folder = linux_to_windows(str(folder))
    for f in files:
      length = len(windows_folder) + 1 + len(f['to'])
      if length > WINDOWS_MAX_PATH:
        too_long.append((length, f))
    too_long.sort(key=lambda lf: -lf[0])
  return {
    "files": files,
    "collisions": collisions,
    "existing": existing,
    "too_long": too_long,
    "errors": errors,
    "runs": len({item.output.id for item in items}),
    "runs_without_files": len(without_files),
    "folders_skipped": folders,
  }


def describe(plan, items, export_dir, ours, created):
  """The plan, for the web app"""
  def source(f):
    item = items[f['item']]
    return {"run": item.output.id, "side": item.side, "file": f['file']}
  collisions = plan['collisions']
  existing = plan['existing']
  return {
    "folder": str(export_dir) if export_dir else None,
    # QA-Board creates it, or created it for an export: files there are replaced, else kept
    "folder_exists": not created,
    "ours": ours,
    "nb_files": len(plan['files']),
    "nb_runs": plan['runs'],
    "runs_without_files": plan['runs_without_files'],
    "folders_skipped": plan['folders_skipped'],
    "files": [{"to": f['to'], **source(f), "exists": f['exists']} for f in plan['files'][:LISTED_FILES]],
    "nb_collisions": len(collisions),
    "collisions": [{"to": same[0]['to'], "sources": [source(f) for f in same[:5]], "count": len(same)} for same in collisions[:LISTED_PROBLEMS]],
    "nb_too_long": len(plan['too_long']),
    "too_long": [{"to": f['to'], "length": length} for length, f in plan['too_long'][:LISTED_PROBLEMS]],
    "max_path": WINDOWS_MAX_PATH,
    "nb_existing": len(existing),
    "existing": [f['to'] for f in existing[:LISTED_PROBLEMS]],
    "errors": [f"{message} ({count} files)" if count > 1 else message for message, count in list(plan['errors'].items())[:LISTED_PROBLEMS]],
    "nb_errors": sum(plan['errors'].values()),
  }


def export_file(source, dest, type, user=None):
  if type == "link":
    try:
      os.link(str(source), str(dest))
    except OSError:
      os.symlink(str(source), str(dest))
  elif type == "copy":
    if user is None:
      raise Exception("Need Login")
    as_user(user.user_name, shutil.copyfile, str(source), str(dest))
  else:
    raise ValueError("Invalid type. Use 'link' or 'copy'.")


def execute(plan, export_dir, type, user, replace):
  """Links or copies the files. What's there is only replaced if it's a file, and `replace`. Returns (exported, skipped, errors)"""
  exported, skipped, errors = [], [], []
  for f in plan['files']:
    dest = export_dir / f['to']
    try:
      check_inside(dest, export_dir)
      if not dest.parent.is_dir():
        mkdir_shared(dest.parent)
        check_inside(dest, export_dir)
      if os.path.lexists(dest):
        if os.path.exists(dest) and os.path.samefile(dest, f['source']):
          exported.append(f)  # already exported
          continue
        if not replace or (dest.is_dir() and not dest.is_symlink()):
          skipped.append(f"{f['to']} already exists, QA-Board doesn't replace it")
          continue
        dest.unlink()
      export_file(f['source'], dest, type, user=user)
      exported.append(f)
    except Exception as e:
      errors.append(f"Error when exporting {f['file']} as {f['to']}: {e}")
  return exported, skipped, errors


def write_new(path, text, replace=False):
  """Writes one of the export's own files, if it's not there. `replace`: in our exports' folders"""
  if os.path.lexists(path):
    if not replace:
      return False
    # e.g. a link someone put there: we remove the link, we don't write where it points
    path.unlink()
  with path.open('x') as f:
    f.write(text)
  return True


def page_url(sides):
  """The commit page the export comes from"""
  new = sides.get('new') or {}
  ref = sides.get('reference') or {}
  hexsha = lambda side: side.get('commit') if re.match(r'^[0-9a-f]{7,40}$', str(side.get('commit') or '')) else None
  if not new.get('project') or not hexsha(new):
    return None
  params = {
    "batch": new.get('batch'),
    "filter": new.get('filter'),
    "reference": hexsha(ref),
    "batch_ref": ref.get('batch') if hexsha(ref) else None,
    "filter_ref": ref.get('filter') if hexsha(ref) else None,
  }
  query = '&'.join(f'{k}={quote(str(v), safe="")}' for k, v in params.items() if v)
  return f"{qaboard_url}/{quote(str(new['project']), safe='/')}/commit/{hexsha(new)}{'?' + query if query else ''}"


def write_link_to_the_page(export_dir, url, replace):
  if not url:
    return
  redirect = f"""<!DOCTYPE HTML>
  <html lang="en-US">
      <head>
          <meta charset="UTF-8">
          <meta http-equiv="refresh" content="0; url={url}">
          <script type="text/javascript">
              window.location.href = "{url}"
          </script>
          <title>Page Redirection</title>
      </head>
      <body>
          <!-- Note: don't tell people to `click` the link, just tell them that it is a link. -->
          If you are not redirected automatically, follow this <a href='{url}'>link to the QA results</a>.
      </body>
  </html>"""
  write_new(export_dir / '0.qa.html', redirect, replace=replace)
  write_new(export_dir / '0.qa.url', f"[InternetShortcut]\nURL={url}\n", replace=replace)


def write_mapping(export_dir, key, exported, items, details, replace):
  """
  0.export.csv: each file, and where it comes from. 0.export.json: the same, with the runs' configurations.
  In a folder with an export already: 0.export-<id>.csv
  """
  base = '0.export'
  if not replace and (os.path.lexists(export_dir / f'{base}.csv') or os.path.lexists(export_dir / f'{base}.json')):
    base = f'0.export-{key}'
  runs = {}
  rows = []
  for f in exported:
    item = items[f['item']]
    output = item.output
    fields = {**default_fields(output), **item.fields}
    runs[str(output.id)] = {
      "project": output.batch.ci_commit.project_id,
      "commit": output.batch.ci_commit.hexsha,
      "batch": output.batch.label,
      "input": str(output.test_input.path),
      "database": str(output.test_input.database),
      "platform": output.platform,
      "configurations": output.configurations,
      "extra_parameters": output.extra_parameters,
      "folder": str(output.output_dir),
    }
    rows.append({"name": f['to'], "side": item.side, "side_label": fields.get('side', ''), "input": str(output.test_input.path),
                 "settings": fields.get('settings', ''), "file": f['file'], "run": output.id, "source": str(f['source'])})
  text = io.StringIO()
  writer = csv.DictWriter(text, fieldnames=["name", "side", "side_label", "input", "settings", "file", "run", "source"], lineterminator='\n')
  writer.writeheader()
  writer.writerows(rows)
  write_new(export_dir / f'{base}.csv', text.getvalue(), replace=replace)
  write_new(export_dir / f'{base}.json', json.dumps({**details, "files": rows, "runs": runs}, indent=2, default=str), replace=replace)
  return f'{base}.csv'


def new_folder(user_name, project_id, commit, name, key):
  """A new folder for each export: <date>-<name>-<id>, in storage.exports_root if admins chose it, else next to the commit's runs"""
  from ..exports import default_dir, folder_name
  return default_dir(user_name, project_id, key, name=name) or commit.repo_outputs_dir / 'share' / folder_name(name, key)


def check_folder(export_dir):
  """(created, ours): if QA-Board will create the folder, and if it's one of its exports' folders. Raises ExportError"""
  from ..models import Export
  from ..exports import in_chosen_folder
  try:
    check_storage_path(export_dir)
  except UnsafePathError as e:
    raise ExportError(f"ERROR: {e}", 403)
  created = not os.path.lexists(export_dir)
  if not created:
    if not export_dir.is_dir() or export_dir.is_symlink():
      raise ExportError(f"ERROR: '{export_dir}' is not a folder", 403)
    if not os.access(export_dir, os.W_OK):
      raise ExportError(f"The export folder need to be writable by all users. Call 'chmod a+w {export_dir}'", 403)
  tracked = None if created else Export.query.filter(Export.path == str(export_dir), Export.deleted_at.is_(None)).first()
  # an export a scan found in a folder someone chose isn't ours: users may have other files there
  ours = created or (tracked is not None and not in_chosen_folder(tracked))
  return created, ours


def create_folder(export_dir):
  try:
    # all users write their exports there
    mkdir_shared(export_dir)
  except Exception as e:
    raise ExportError(f"ERROR: When creating '{export_dir}': {e}", 403)


def run_export(items, *, project_id, pattern, template, separator, windows, export_type, export_dir, key, dry_run, details, sides):
  """The plan (dry run), or the export. Returns the response's body"""
  created, ours = check_folder(export_dir)
  plan = make_plan(items, pattern, template, separator, export_dir=None if created else export_dir, folder=export_dir, windows=windows)
  result = describe(plan, items, export_dir, ours, created)
  result["existing_policy"] = "replace" if ours else "keep"
  result["type"] = export_type
  result["windows"] = windows
  if dry_run:
    return result
  if plan['collisions']:
    raise ExportError(f"{len(plan['collisions'])} names are used by several files, e.g. {plan['collisions'][0][0]['to']}: change how files are named", 409)
  if plan['too_long']:
    length, f = plan['too_long'][0]
    raise ExportError(f"{len(plan['too_long'])} paths are too long for Windows ({length} characters, at most {WINDOWS_MAX_PATH}), e.g. {f['to']}: "
                      "shorten the names, or turn off Windows-compatible names", 409)
  if created:
    create_folder(export_dir)
  exported, skipped, errors = execute(plan, export_dir, export_type, g.actor.user, replace=ours)
  url = page_url(sides)
  write_link_to_the_page(export_dir, url, replace=ours)
  mapping = write_mapping(export_dir, key, exported, items, {**details, "qaboard": url, "folder": str(export_dir)}, replace=ours) if exported else None
  # users see their exports, and their size, in "Storage usage" (backend/exports.py), and can delete them:
  # not folders that were there before
  export_id = None
  new = sides.get('new') or {}
  try:
    from ..exports import record
    export = record(export_dir, project_id=project_id, hexsha=new.get('commit'), batch_label=new.get('batch'), user_name=g.user.get('user_name'),
                    export_type=export_type, filter=new.get('filter'), nb_files=len(exported),
                    name=details.get('name'), details={"files_pattern": pattern, "template": template, "separator": separator, "windows": windows, "runs": plan['runs']}) if ours else None
    db_session.commit()
    export_id = export.id if export else None
  except Exception as e:
    db_session.rollback()
    print(f"WARNING: could not track the export {export_dir}: {e}")
  return {
    **result,
    "export_id": export_id,
    "nb_files_exported": len(exported),
    "skipped": skipped[:LISTED_PROBLEMS],
    "nb_skipped": len(skipped),
    "errors": [*result['errors'], *errors[:LISTED_PROBLEMS]],
    "mapping": mapping,
  }


def strings(d, keys):
  return {k: str(v) for k, v in (d or {}).items() if k in keys and isinstance(v, (str, int, float)) and not isinstance(v, bool)}


def check_runs_access(outputs, project_id):
  """The project's runs: the user acts on them. Others' (e.g. the reference's): they read them"""
  projects = {o.batch.ci_commit.project_id for o in outputs}
  for project in sorted(projects):
    if forbidden := require_project_access(g.user, project, 'runs.act' if project == project_id else 'project.read'):
      return forbidden
  return None


def export_folder(body, user_name, project_id, commit):
  folder = body.get('folder') or {}
  if not isinstance(folder, dict):
    raise ExportError("`folder`: {name, id} for a new folder, or {path}")
  key = folder.get('id') or os.urandom(4).hex()
  if not folder_id.match(str(key)):
    raise ExportError("`folder.id`: 8 hexadecimal characters")
  if folder.get('path'):
    return windows_to_linux_path(Path(str(folder['path']))).resolve(), key
  name = str(folder.get('name') or '')
  return new_folder(user_name, project_id, commit, name, key), key


@app.route("/api/v1/exports/preview", methods=['POST'])
@app.route("/api/v1/exports", methods=['POST'])
@login_required
def export_runs():
  dry_run = request.path.rstrip('/').endswith('/preview')
  body = request.get_json(silent=True) or {}
  project_id = body.get('project') or request.args.get('project')
  if not project_id:
    return jsonify({"error": "Which project? `project`"}), 400
  runs = body.get('runs')
  if not isinstance(runs, list) or not runs or not all(isinstance(r, dict) and isinstance(r.get('id'), int) for r in runs):
    return jsonify({"error": "Which runs? `runs`: [{id, side, fields}]"}), 400
  if len(runs) > MAX_RUNS:
    return jsonify({"error": f"Too many runs: at most {MAX_RUNS}. Filter them."}), 400
  # it creates links or copies in a folder: an action on the project's runs
  if forbidden := require_project_access(g.user, project_id):
    return forbidden
  ids = sorted({r['id'] for r in runs})
  outputs = {o.id: o for o in (Output.query
    .options(joinedload(Output.batch).joinedload(Batch.ci_commit))
    .filter(Output.id.in_(ids))
    .all())}
  if missing := [i for i in ids if i not in outputs]:
    return jsonify({"error": f"Unknown runs: {', '.join(map(str, missing[:10]))}"}), 404
  if forbidden := check_runs_access(outputs.values(), project_id):
    return forbidden
  user_fields = [f for f in FIELDS if f != 'file']
  items = [Item(output=outputs[r['id']], side=str(r.get('side') or 'new'), fields=strings(r.get('fields'), user_fields)) for r in runs]
  export_type = body.get('type', 'link')
  if export_type not in ('link', 'copy'):
    return jsonify({"error": "`type`: link or copy"}), 400
  sides = {key: strings(side, ('project', 'commit', 'batch', 'filter', 'label')) for key, side in (body.get('sides') or {}).items() if key in ('new', 'reference') and isinstance(side, dict)}
  try:
    pattern = check_pattern(body.get('files'))
    template = str(body.get('template') or DEFAULT_TEMPLATE)
    separator = str(body.get('separator') or '_')
    windows = body.get('windows', True) is not False
    parse_template(template)
    first = next((i.output for i in items if i.side == 'new'), items[0].output)
    export_dir, key = export_folder(body, g.user['user_name'], project_id, first.batch.ci_commit)
    details = {
      "name": str((body.get('folder') or {}).get('name') or '') or None,
      "exported_at": datetime.datetime.utcnow().isoformat() + 'Z',
      "by": g.user.get('user_name'),
      "project": project_id,
      "files_pattern": pattern,
      "template": template,
      "separator": separator,
      "windows": windows,
      "type": export_type,
      "sides": sides,
    }
    return jsonify(run_export(items, project_id=project_id, pattern=pattern, template=template, separator=separator, windows=windows,
                              export_type=export_type, export_dir=export_dir, key=key, dry_run=dry_run, details=details, sides=sides))
  except ExportNameError as e:
    return jsonify({"error": str(e)}), 400
  except ExportError as e:
    return jsonify({"error": str(e)}), e.status
