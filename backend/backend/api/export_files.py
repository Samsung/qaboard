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

The request: {project, runs: [{id, side, fields, regions}], files (a pattern), template, separator, windows, type
(link|copy), folder: {name, id} or {path}, sides, file_in_names, whole_files, folders}.
- `folders`: true (the default) exports the folders the pattern matches with the files in them, e.g. "dma_out": the
  folder is named with the template (its path is the {file}), and keeps its files' names and subfolders, e.g.
  "scenes_a__dma_out__new/frame_0.bin". Folders with files the pattern matches too (e.g. "**/*") export those files,
  not the folder. Links are made file by file, in real folders: symbolic links to folders don't open on Windows shares.
  false: matched folders are skipped (`folders_skipped`). The preview's files from folders have `folder`: {to, file}.
- `file_in_names`: true (the default), or "auto": when each run has at most one matching file, names leave it out
  ("{input}__{file}__{side}" gives "scenes_a__new.png"), unless different files would then get the same name.
  The answer says what was used (`file_in_names`), and `max_files_per_run`.
- `regions`: regions of interest of images, exported as crops: [{name, x, y, w, h, unit: "px"|"fraction",
  image_width, image_height, file, label, source}]. `file`: the image they belong to (its path in the run's folder),
  else every matching image. Pixels are scaled when image_width/image_height differ from the image's size. Crops are
  named with the {region} field (the template gets "__{region}" if it doesn't have it), and are new files, never links.
  Files that aren't images we can crop are counted (`nb_not_croppable`), not errors.
- `whole_files`: true (the default), false to export only the crops.
The preview's files say which entry of `runs` they come from (`item`), and their `region` (null for whole files).
0.export.csv has the crops' region and where they are in the source's pixels ("x,y,w,h").

Copies are made as the user (fs_utils.as_user), so that they own them. Before copying, preview and export check, as
the user, that they can write in the folder (if it exists) and read a few runs' files of each side: `copy_check`
{user, groups_known, nb_checked, folder_error, unreadable: [{side, error}]}. The export refuses a folder they can't
write in. `groups_known`: false when QA-Board only knows the user's primary group (accounts.groups_known).

Files that fail are grouped by kind of problem (backend/export_problems.py): `problems` [{step, actor, code, about,
count, examples, message, hint}], `nb_failed`, `nb_not_attempted` (when the first files all fail, we stop), and a
`reference` that admins find in the server's logs and in Sentry, with the tracebacks. `errors` has one line per problem.

The older API, /api/v1/export (backend/api/export_to_folder.py), is deprecated but unchanged, for scripts.

In folders that were there before, we only add files: they're someone's, maybe not the user's.
We replace files only in the folders of our exports, and never delete folders.
"""
import os
import re
import csv
import io
import json
import math
import shutil
import datetime
import traceback
from pathlib import Path
from collections import defaultdict
from dataclasses import dataclass, field

from requests.utils import quote
from flask import request, jsonify, g
from sqlalchemy.orm import joinedload


from qaboard.compat import windows_to_linux_path, linux_to_windows
from qaboard.export_names import FIELDS, ExportNameError, file_name, input_fields, parse_template, render, split_extension
from backend import app, db_session

from backend.fs_utils import as_user, mkdir_shared, unix_identity, UnknownAccountError
from backend.storage import check_storage_path, check_inside, UnsafePathError
from backend.export_problems import Problems, what_about, user_error
from backend.accounts import groups_known
from ..models import Batch, Output
from ..config import qaboard_url
from .auth import login_required, require_project_access


# what the preview lists: the counts are always complete
LISTED_FILES = 500
LISTED_PROBLEMS = 50
MAX_RUNS = 50_000
MAX_REGIONS = 500
MAX_CROPS = 50_000
# the files in the folders exported, for all runs
MAX_FOLDER_FILES = 200_000
# files that fail before any is exported: the others would fail too, we stop
GIVE_UP_AFTER = 50
# before copies, the runs of each side whose files we check the user can read
COPY_CHECKS = 3
# images Pillow can open, crop and write again in the same format
CROPPABLE = ('.png', '.jpg', '.jpeg', '.tif', '.tiff', '.bmp', '.webp')
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
  # regions of interest to crop, see check_regions
  regions: list = field(default_factory=list)


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
    # set for each crop
    'region': '',
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


def is_number(value):
  return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


def check_regions(regions, index):
  """A run's regions of interest, to crop: [{name, x, y, w, h, unit, image_width, image_height, file, label, source}]. Raises ExportError"""
  if regions is None:
    return []
  where = f"`runs[{index}].regions`"
  if not isinstance(regions, list):
    raise ExportError(f"{where}: a list of regions, like {{name, x, y, w, h}}")
  if len(regions) > MAX_REGIONS:
    raise ExportError(f"{where}: at most {MAX_REGIONS} regions per run, not {len(regions)}")
  checked = []
  for number, region in enumerate(regions):
    where = f"`runs[{index}].regions[{number}]`"
    if not isinstance(region, dict):
      raise ExportError(f"{where}: a region, like {{name, x, y, w, h}}")
    name = region.get('name')
    if not isinstance(name, str) or not name.strip():
      raise ExportError(f"{where}: regions need a `name`, it names their crops")
    numbers = {}
    for key in ('x', 'y', 'w', 'h', 'image_width', 'image_height'):
      value = region.get(key)
      if value is None and key.startswith('image_'):
        numbers[key] = None
        continue
      if not is_number(value):
        raise ExportError(f"{where}: `{key}` must be a number")
      numbers[key] = value
    if numbers['w'] <= 0 or numbers['h'] <= 0:
      raise ExportError(f"{where}: `w` and `h` must be positive")
    if any(numbers[key] is not None and numbers[key] <= 0 for key in ('image_width', 'image_height')):
      raise ExportError(f"{where}: `image_width` and `image_height` must be positive")
    unit = region.get('unit') or 'px'
    if unit not in ('px', 'fraction'):
      raise ExportError(f'{where}: `unit`: "px" or "fraction"')
    texts = {}
    for key in ('file', 'label', 'source'):
      value = region.get(key)
      if value is not None and not isinstance(value, str):
        raise ExportError(f"{where}: `{key}` must be a string")
      texts[key] = value or None
    if texts['file']:
      texts['file'] = texts['file'].replace('\\', '/')
    checked.append({"name": name.strip(), **numbers, "unit": unit, **texts})
  return checked


def region_key(region):
  """What makes crops different: the same crop under several names isn't a collision"""
  if region is None:
    return None
  return tuple(region[k] for k in ('name', 'x', 'y', 'w', 'h', 'unit', 'image_width', 'image_height'))


def list_files(output, pattern):
  """
  The run's files matching the pattern, and the folders it matches that are exported whole: [(folder, [files in it])].
  A folder is exported whole if the pattern matches none of its files (else those files are exported), and isn't in
  another folder exported whole.
  """
  if output.deleted:
    return [], []
  output_dir = output.output_dir
  files, dirs = [], []
  for path in sorted(output_dir.glob(pattern)):
    if path.is_dir():
      dirs.append(path)
    elif path.exists():
      files.append(path)
  folders = []
  for folder in dirs:
    if any(f.is_relative_to(folder) for f in files) or any(folder.is_relative_to(other) for other, _ in folders):
      continue
    folders.append((folder, folder_files(folder)))
  return files, folders


def folder_files(folder):
  """The files in a folder and its subfolders, sorted. Links to folders aren't followed: they may be anywhere"""
  found = []
  for root, dirs, names in os.walk(folder):
    dirs.sort()
    found.extend(Path(root) / name for name in sorted(names) if os.path.exists(Path(root) / name))
  return found


def list_runs(items, pattern, listing):
  """Lists each run's files once, in `listing`: {run id: (files, folders, error)}, see list_files"""
  for item in items:
    output = item.output
    if output.id in listing:
      continue
    try:
      files, folders = list_files(output, pattern)
      listing[output.id] = (files, folders, None)
    except (OSError, ValueError) as e:
      listing[output.id] = ([], [], f"Could not list the files of run {output.id}: {e}")
  return listing


_forbidden_windows = re.compile(r'[<>:"|?*\x00-\x1f]')

def inner_path(path, windows):
  """A file's path in an exported folder: as in the run, but with names Windows can open"""
  if not windows:
    return path
  return '/'.join(_forbidden_windows.sub('-', segment).rstrip('. ') or '_' for segment in path.split('/'))


def export_name(template, fields, file, separator, windows, with_file=True):
  if with_file:
    return file_name(template, fields, file, separator, windows=windows)
  # without the file, its extension still ends the name
  _, extension = split_extension(str(file).replace('\\', '/'))
  return render(template, {**fields, 'file': ''}, separator=separator, extension=extension, windows=windows)


def folder_export_name(template, fields, folder, separator, windows, with_file=True):
  """A folder's name: like a file's, without an extension"""
  return render(template, {**fields, 'file': folder if with_file else ''}, separator=separator, windows=windows)


def make_plan(items, pattern, template, separator, export_dir=None, folder=None, windows=True, *, file_in_names=True, whole_files=True, listing=None,
              folders=True):
  """
  What goes where: {files: [{to, source, file, item, region}], collisions, errors...}.
  `export_dir`: a folder that exists, to say which files are there already. `folder`: where the export goes.
  With `windows`, names are case-insensitive (Windows shares can't have img.png and IMG.png), and full paths, as
  Windows users see them, must be short enough.
  `file_in_names`: True, or "auto" to leave the file out of names when runs have at most one file, if names stay unique.
  `whole_files`: False exports only the crops of the items' regions. `listing`: the runs' files, if already listed.
  `folders`: export the folders the pattern matches, with their files (see list_files), else skip them.
  """
  parts = parse_template(template)
  listing = list_runs(items, pattern, {} if listing is None else listing)
  # a folder counts as one file: names say the file if a run has several files or folders
  max_files = max((len(listing[item.output.id][0]) + (len(listing[item.output.id][1]) if folders else 0) for item in items), default=0)
  uses_file = ('field', 'file') in parts
  options = dict(windows=windows, whole_files=whole_files, folders=folders)
  if file_in_names == 'auto' and uses_file and max_files <= 1:
    plan = name_files(items, listing, template, separator, export_dir, folder, with_file=False, **options)
    # names can't be made without the file, or several files have the same name: we keep the file
    if not plan['collisions'] and not plan['name_errors']:
      return {**plan, "max_files_per_run": max_files}
  plan = name_files(items, listing, template, separator, export_dir, folder, with_file=file_in_names != 'auto' or uses_file, **options)
  return {**plan, "max_files_per_run": max_files}


def name_files(items, listing, template, separator, export_dir, folder, windows, with_file, whole_files, folders=True):
  # crops are named with their region: if the template doesn't say where, it goes at the end
  crop_template = template if ('field', 'region') in parse_template(template) else template + '__{region}'
  files, errors, name_errors = [], defaultdict(int), 0
  without_files, folders_skipped, counted = set(), 0, set()
  exported_folders, in_folders = set(), 0
  not_croppable = {}
  seen = set()
  for index, item in enumerate(items):
    output = item.output
    run_files, run_folders, error = listing[output.id]
    if output.id not in counted:
      counted.add(output.id)
      if not folders:
        folders_skipped += len(run_folders)
      if error:
        errors[error] += 1
    if not run_files and not (folders and any(inner for _, inner in run_folders)):
      without_files.add(output.id)
      continue
    output_dir = output.output_dir
    fields = {**default_fields(output), **item.fields}
    # the folders matched, with their files: only whole files, crops are of the images matched
    for path, inner in (run_folders if folders and whole_files else []):
      rel = path.relative_to(output_dir).as_posix()
      try:
        name = folder_export_name(template, {**fields, 'region': ''}, rel, separator, windows, with_file=with_file)
      except ExportNameError as e:
        errors[str(e)] += 1
        name_errors += 1
        continue
      for source in inner:
        to = f"{name}/{inner_path(source.relative_to(path).as_posix(), windows)}"
        key = (str(source), None, to)
        if key in seen:
          continue
        seen.add(key)
        exported_folders.add((str(path), name))
        in_folders += 1
        files.append({"to": to, "source": source, "file": source.relative_to(output_dir).as_posix(), "item": index, "region": None,
                      "folder": {"to": name, "file": rel}})
    for path in run_files:
      rel = path.relative_to(output_dir).as_posix()
      regions = [r for r in item.regions if r['file'] is None or r['file'] == rel]
      croppable = path.suffix.lower() in CROPPABLE
      if regions and not croppable:
        not_croppable[str(path)] = rel
      entries = [(template, None)] if whole_files else []
      if croppable:
        entries += [(crop_template, region) for region in regions]
      for entry_template, region in entries:
        try:
          to = export_name(entry_template, {**fields, 'region': region['name'] if region else ''}, rel, separator, windows, with_file=with_file)
        except ExportNameError as e:
          errors[str(e)] += 1
          name_errors += 1
          continue
        key = (str(path), region_key(region), to)
        if key in seen:
          continue
        seen.add(key)
        files.append({"to": to, "source": path, "file": rel, "item": index, "region": region})
  by_name = defaultdict(list)
  for f in files:
    by_name[f['to'].lower() if windows else f['to']].append(f)
  collisions = [same for same in by_name.values() if len({(str(f['source']), region_key(f['region'])) for f in same}) > 1]
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
    "folders_skipped": folders_skipped,
    "nb_folders": len(exported_folders),
    "nb_in_folders": in_folders,
    "nb_crops": sum(1 for f in files if f['region']),
    "not_croppable": list(not_croppable.values()),
    "file_in_names": with_file,
    "name_errors": name_errors,
  }


def describe(plan, items, export_dir, ours, created):
  """The plan, for the web app"""
  def source(f):
    item = items[f['item']]
    return {"run": item.output.id, "side": item.side, "file": f['file'], "region": f['region']['name'] if f['region'] else None}
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
    "nb_folders": plan['nb_folders'],
    "nb_in_folders": plan['nb_in_folders'],
    "files": [{"to": f['to'], **source(f), "item": f['item'], "exists": f['exists'], **({"folder": f['folder']} if f.get('folder') else {})}
              for f in plan['files'][:LISTED_FILES]],
    "nb_crops": plan['nb_crops'],
    "nb_not_croppable": len(plan['not_croppable']),
    "not_croppable": list(dict.fromkeys(plan['not_croppable']))[:LISTED_PROBLEMS],
    "file_in_names": plan['file_in_names'],
    "max_files_per_run": plan['max_files_per_run'],
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
  """How it was exported: "link" (a hard link), "symlink" (hard links don't cross filesystems) or "copy"."""
  if type == "link":
    try:
      os.link(str(source), str(dest))
      return "link"
    except OSError:
      os.symlink(str(source), str(dest))
      return "symlink"
  elif type == "copy":
    if user is None:
      raise Exception("Need Login")
    as_user(user.user_name, shutil.copyfile, str(source), str(dest))
    return "copy"
  else:
    raise ValueError("Invalid type. Use 'link' or 'copy'.")


def make_folders(path, type, user=None):
  """
  The export's subfolders, e.g. new/ and reference/ with "{side}/...": made by whoever writes the files in them.
  Copies are written as the user: the server may not be able to create folders where the user can (e.g. NFS root squash,
  a folder the user chose), and the user may not be able to write in a folder the server made (e.g. ACLs, chmod ignored).
  """
  if type == "copy":
    if user is None:
      raise Exception("Need Login")
    as_user(user.user_name, mkdir_shared, path)
  else:
    mkdir_shared(path)


def crop_box(region, width, height):
  """(left, top, right, bottom): the region in the image's pixels. Raises ValueError if it's outside the image"""
  x, y, w, h = region['x'], region['y'], region['w'], region['h']
  if region['unit'] == 'fraction':
    x, w, y, h = x * width, w * width, y * height, h * height
  else:
    # regions drawn on another version of the image, e.g. a smaller preview
    if region.get('image_width') and region['image_width'] != width:
      x, w = x * width / region['image_width'], w * width / region['image_width']
    if region.get('image_height') and region['image_height'] != height:
      y, h = y * height / region['image_height'], h * height / region['image_height']
  left, top = min(max(round(x), 0), width), min(max(round(y), 0), height)
  right, bottom = min(max(round(x + w), 0), width), min(max(round(y + h), 0), height)
  if right <= left or bottom <= top:
    raise ValueError(f"region {region['name']} is outside the image ({width}x{height})")
  return left, top, right, bottom


class OpenImages:
  """The last image read: its crops follow each other in the plan, it's decoded once for all of them"""
  def __init__(self):
    self.path, self.image, self.info = None, None, {}

  def get(self, path):
    from PIL import Image
    if self.path != str(path):
      self.close()
      # closing an image frees its pixels: we keep a copy
      with Image.open(path) as image:
        image.load()
        self.image = image.copy()
        self.info = dict(image.info)
      self.path = str(path)
    return self.image

  def close(self):
    self.path, self.image = None, None


def crop_image(source, region, extension, images=None):
  """The crop's bytes in the format of `extension`, and where it is in the source's pixels: x,y,w,h as text"""
  from PIL import Image
  images = images or OpenImages()
  image = images.get(source)
  left, top, right, bottom = crop_box(region, *image.size)
  cropped = image.crop((left, top, right, bottom))
  image_format = Image.registered_extensions().get(extension.lower())
  if not image_format:
    raise ValueError(f"QA-Board can't write {extension} images")
  options = {}
  if images.info.get('icc_profile') and image_format in ('PNG', 'JPEG', 'TIFF', 'WEBP'):
    options['icc_profile'] = images.info['icc_profile']
  if image_format == 'JPEG':
    options['quality'] = 95
    if cropped.mode not in ('L', 'RGB', 'CMYK'):
      cropped = cropped.convert('L' if cropped.mode in ('LA', 'I', 'F') or cropped.mode.startswith('I;') else 'RGB')
  data = io.BytesIO()
  try:
    cropped.save(data, format=image_format, **options)
  except (OSError, ValueError, KeyError):
    # a mode the format can't write: we keep the mode when we can, e.g. 16-bit PNGs and TIFFs
    data = io.BytesIO()
    cropped.convert('RGBA' if 'A' in cropped.mode else 'RGB').save(data, format=image_format, **options)
  return data.getvalue(), f"{left},{top},{right - left},{bottom - top}"


def write_bytes(path, data):
  # 'x': never through a link someone put there
  with open(path, 'xb') as f:
    f.write(data)


def export_crop(f, dest, type, user=None, images=None):
  """Crops are new files: with "copy" the user owns them like copies, else the server writes them like 0.export.csv"""
  data, f['crop'] = crop_image(f['source'], f['region'], os.path.splitext(f['to'])[1], images)
  if type == "copy":
    if user is None:
      raise Exception("Need Login")
    as_user(user.user_name, write_bytes, str(dest), data)
  else:
    write_bytes(dest, data)


def check_can_copy(user):
  """Copies are made as the user, so that they own them: QA-Board needs their Unix account (backend/accounts.py)"""
  if user is None:
    raise ExportError("Log in to export copies", 401)
  try:
    unix_identity(user.user_name)
  except UnknownAccountError:
    raise ExportError(f"QA-Board can't copy files as {user.user_name}: it doesn't know their Unix account. "
                      "Export links instead, or ask your QA-Board admins to check the server's accounts.", 403)


def copy_samples(plan, items, per_side=COPY_CHECKS):
  """A file from each of the first runs of each side: what users can't read in one run, they usually can't in the others"""
  samples, seen = {}, set()
  for f in plan['files']:
    item = items[f['item']]
    if (item.side, item.output.id) in seen:
      continue
    picked = samples.setdefault(item.side, [])
    if len(picked) < per_side:
      picked.append(str(f['source']))
      seen.add((item.side, item.output.id))
  return samples


def can_copy(folder, samples):
  """Run as the user: can they write in the folder (if it exists), and read the runs' files"""
  folder_error = None
  # what the user's account can do, not the server's (the real uid): with ACLs too, e.g. on NFS
  if folder is not None and not os.access(folder, os.W_OK | os.X_OK, effective_ids=True):
    folder_error = f"Permission denied: '{folder}'"
  unreadable = []
  for side, paths in samples.items():
    for path in paths:
      try:
        with open(path, 'rb') as file:
          file.read(1)
      except OSError as e:
        unreadable.append({"side": side, "error": user_error(e)})
  return {"folder_error": folder_error, "unreadable": unreadable}


def check_copies(user, folder, plan, items):
  """
  Copies are made as the user: before exporting, we check what their account can do, instead of failing file after
  file. `folder`: the export's folder if it exists (else the server creates it, writable by all). One child process.
  """
  samples = copy_samples(plan, items)
  try:
    found = as_user(user.user_name, can_copy, folder, samples)
  except Exception as e:
    print(f"WARNING: could not check what {user.user_name} can copy: {''.join(traceback.format_exception(e))}", flush=True)
    found = {"folder_error": None, "unreadable": [], "error": str(e)}
  try:
    known = groups_known(user.user_name)
  except Exception:
    known = None
  return {"user": user.user_name, "groups_known": known, "nb_checked": sum(len(paths) for paths in samples.values()), **found}


def execute(plan, export_dir, type, user, replace, items=None):
  """
  Links or copies the files, and writes the crops. What's there is only replaced if it's a file, and `replace`.
  Returns (exported, skipped, problems): what failed, grouped (backend/export_problems.py). Exported files that are
  symbolic links have `symlink`: Windows shares often can't open them. When the first
  GIVE_UP_AFTER files all fail, the others would too: we stop (`problems.not_attempted`).
  """
  exported, skipped = [], []
  problems = Problems()
  # who writes: copies are made as the user, links by the server
  writer = user.user_name if type == 'copy' and user is not None else 'server'
  images = OpenImages()
  for index, f in enumerate(plan['files']):
    if not exported and problems.count >= GIVE_UP_AFTER:
      problems.not_attempted = len(plan['files']) - index
      break
    dest = export_dir / f['to']
    step, actor = 'folder', writer
    try:
      check_inside(dest, export_dir)
      if not dest.parent.is_dir():
        make_folders(dest.parent, type, user=user)
        check_inside(dest, export_dir)
      if os.path.lexists(dest):
        same = os.path.exists(dest) and os.path.samefile(dest, f['source'])
        if same and not f['region']:
          exported.append(f)  # already exported
          continue
        if same:
          skipped.append(f"{f['to']} is the image it's cropped from, QA-Board doesn't replace it")
          continue
        if not replace or (dest.is_dir() and not dest.is_symlink()):
          skipped.append(f"{f['to']} already exists, QA-Board doesn't replace it")
          continue
        step, actor = 'replace', 'server'
        dest.unlink()
      if f['region']:
        step, actor = 'crop', writer
        export_crop(f, dest, type, user=user, images=images)
      else:
        step, actor = type, writer
        if export_file(f['source'], dest, type, user=user) == "symlink":
          f['symlink'] = True
      exported.append(f)
    except Exception as e:
      # the server reads the images it crops
      if step == 'crop' and what_about(e, f['source']) != 'destination':
        actor = 'server'
      side = items[f['item']].side if items is not None else None
      problems.add(e, step=step, actor=actor, source=f['source'], f=f, side=side)
  images.close()
  return exported, skipped, problems


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
    # a reference from another project: the page looks for it there
    "ref_project": ref.get('project') if hexsha(ref) and ref.get('project') and ref.get('project') != new['project'] else None,
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
                 "settings": fields.get('settings', ''), "file": f['file'], "run": output.id, "source": str(f['source']),
                 "region": f['region']['name'] if f['region'] else '', "crop": f.get('crop') or ''})
  text = io.StringIO()
  writer = csv.DictWriter(text, fieldnames=["name", "side", "side_label", "input", "settings", "file", "run", "source", "region", "crop"], lineterminator='\n')
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


def run_export(items, *, project_id, pattern, template, separator, windows, export_type, export_dir, key, dry_run, details, sides,
               file_in_names=True, whole_files=True, folders=True):
  """The plan (dry run), or the export. Returns the response's body"""
  created, ours = check_folder(export_dir)
  # the preview and the export plan the same way: the export is what was previewed
  plan = make_plan(items, pattern, template, separator, export_dir=None if created else export_dir, folder=export_dir, windows=windows,
                   file_in_names=file_in_names, whole_files=whole_files, folders=folders)
  if plan['nb_crops'] > MAX_CROPS:
    raise ExportError(f"Too many crops: {plan['nb_crops']}, at most {MAX_CROPS}. Export fewer regions or files.")
  if plan['nb_in_folders'] > MAX_FOLDER_FILES:
    raise ExportError(f"Too many files in the folders matched: {plan['nb_in_folders']}, at most {MAX_FOLDER_FILES}. "
                      "Export fewer runs, or only some of the folders' files, e.g. dma_out/*.bin.")
  result = describe(plan, items, export_dir, ours, created)
  result["existing_policy"] = "replace" if ours else "keep"
  result["type"] = export_type
  result["windows"] = windows
  if export_type == 'copy':
    check_can_copy(g.actor.user)
    result["copy_check"] = check_copies(g.actor.user, None if created else export_dir, plan, items)
  if dry_run:
    return result
  if export_type == 'copy' and result["copy_check"]["folder_error"]:
    raise ExportError(f"Copies are made as you, and your account ({g.actor.user.user_name}) can't write in {export_dir}. "
                      "Export links, or into a folder you can write in.", 403)
  if plan['collisions']:
    raise ExportError(f"{len(plan['collisions'])} names are used by several files, e.g. {plan['collisions'][0][0]['to']}: change how files are named", 409)
  if plan['too_long']:
    length, f = plan['too_long'][0]
    raise ExportError(f"{len(plan['too_long'])} paths are too long for Windows ({length} characters, at most {WINDOWS_MAX_PATH}), e.g. {f['to']}: "
                      "shorten the names, or turn off Windows-compatible names", 409)
  if created:
    create_folder(export_dir)
  exported, skipped, problems = execute(plan, export_dir, export_type, g.actor.user, replace=ours, items=items)
  # admins get the tracebacks, in the logs and Sentry, users a reference
  reference = problems.report(debug_context(export_dir, export_type, g.actor.user, project_id=project_id, template=template,
                                            nb_files=len(plan['files']), nb_exported=len(exported), not_attempted=problems.not_attempted)) if problems.count else None
  url = page_url(sides)
  write_link_to_the_page(export_dir, url, replace=ours)
  details = {**details, "qaboard": url, "folder": str(export_dir), "file_in_names": plan['file_in_names'], "nb_crops": plan['nb_crops']}
  mapping = write_mapping(export_dir, key, exported, items, details, replace=ours) if exported else None
  # users see their exports, and their size, in "Storage usage" (backend/exports.py), and can delete them:
  # not folders that were there before
  export_id = None
  new = sides.get('new') or {}
  try:
    from ..exports import record
    export = record(export_dir, project_id=project_id, hexsha=new.get('commit'), batch_label=new.get('batch'), user_name=g.user.get('user_name'),
                    export_type=export_type, filter=new.get('filter'), nb_files=len(exported),
                    name=details.get('name'), details={"files_pattern": pattern, "template": template, "separator": separator, "windows": windows, "runs": plan['runs'],
                                                       "nb_crops": plan['nb_crops']}) if ours else None
    db_session.commit()
    export_id = export.id if export else None
  except Exception as e:
    db_session.rollback()
    print(f"WARNING: could not track the export {export_dir}: {e}")
  return {
    **result,
    "export_id": export_id,
    "nb_files_exported": len(exported),
    # hard links don't cross filesystems: these are symbolic links, Windows shares often can't open them
    "nb_symlinks": sum(1 for f in exported if f.get('symlink')),
    "skipped": skipped[:LISTED_PROBLEMS],
    "nb_skipped": len(skipped),
    # one line per kind of problem; `problems` says more: what it means, what to do, examples
    "errors": [*result['errors'], *problems.as_errors(export_dir)[:LISTED_PROBLEMS]],
    "problems": problems.describe(export_dir)[:LISTED_PROBLEMS],
    "nb_failed": problems.count,
    "nb_not_attempted": problems.not_attempted,
    "reference": reference,
    "mapping": mapping,
  }


def debug_context(export_dir, export_type, user, **context):
  """What admins need to understand failures, e.g. permissions: who the server and the user are, who owns the folder"""
  def stat(path):
    try:
      s = os.stat(path)
      return {"uid": s.st_uid, "gid": s.st_gid, "mode": oct(s.st_mode & 0o7777)}
    except OSError as e:
      return {"error": str(e)}
  identity = None
  if export_type == 'copy' and user is not None:
    try:
      uid, gid, groups = unix_identity(user.user_name)
      identity = {"user": user.user_name, "uid": uid, "gid": gid, "groups": groups, "groups_known": groups_known(user.user_name)}
    except Exception as e:
      identity = {"user": user.user_name, "error": str(e)}
  return {
    **context,
    "folder": str(export_dir),
    "type": export_type,
    "folder_stat": stat(export_dir),
    "parent_stat": stat(export_dir.parent),
    "server": {"uid": os.geteuid(), "gid": os.getegid()} if hasattr(os, 'geteuid') else None,
    "copies_as": identity,
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
    return jsonify({"error": "Which runs? `runs`: [{id, side, fields, regions}]"}), 400
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
  # the file and the region are set for each file and crop
  user_fields = [f for f in FIELDS if f not in ('file', 'region')]
  export_type = body.get('type', 'link')
  if export_type not in ('link', 'copy'):
    return jsonify({"error": "`type`: link or copy"}), 400
  sides = {key: strings(side, ('project', 'commit', 'batch', 'filter', 'label')) for key, side in (body.get('sides') or {}).items() if key in ('new', 'reference') and isinstance(side, dict)}
  try:
    items = [Item(output=outputs[r['id']], side=str(r.get('side') or 'new'), fields=strings(r.get('fields'), user_fields),
                  regions=check_regions(r.get('regions'), index)) for index, r in enumerate(runs)]
    file_in_names = body.get('file_in_names', True)
    if file_in_names is not True and file_in_names != 'auto':
      raise ExportError('`file_in_names`: true, or "auto" to leave the file out of names when runs have one file')
    whole_files = body.get('whole_files', True) is not False
    pattern = check_pattern(body.get('files'))
    template = str(body.get('template') or DEFAULT_TEMPLATE)
    separator = str(body.get('separator') or '_')
    windows = body.get('windows', True) is not False
    folders = body.get('folders', True) is not False
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
      "whole_files": whole_files,
      "folders": folders,
    }
    return jsonify(run_export(items, project_id=project_id, pattern=pattern, template=template, separator=separator, windows=windows,
                              export_type=export_type, export_dir=export_dir, key=key, dry_run=dry_run, details=details, sides=sides,
                              file_in_names=file_in_names, whole_files=whole_files, folders=folders))
  except ExportNameError as e:
    return jsonify({"error": str(e)}), 400
  except ExportError as e:
    return jsonify({"error": str(e)}), e.status
