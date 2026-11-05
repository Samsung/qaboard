"""
The names of exported files ("Export" on the commit page): a template like "{input}__{settings}__{file}__{side}"
filled with each run's fields, and each file's path in its run's folder.

The web app decides the fields of each run (what its new and reference results are called, the settings that tell
runs on the same input apart) and shows the names before exporting; the server lists the files and renders the same
names. Both use this logic: webapp/src/export/names.js is a port, and both are tested against the same cases,
tests/fixtures/export-names.json. Change one, change the other.

- A field's slashes (e.g. the input's folders) become `separator`, or stay folders if it's "/".
  The template's own slashes are always folders: "{side}/{input}" gives a folder per side.
- An empty field takes the separator next to it along: "{input}__{settings}__{file}" gives "a__out" without settings.
- The file's extension always ends the name: templates don't write it.
- Spaces become "_". With `windows` (the default), names are ones Windows can open: characters it doesn't allow
  become "-", names don't end with dots or spaces, and reserved names (CON, NUL, COM1...) get a "_" first. The server
  also checks paths' lengths, and compares names regardless of case (backend/api/export_files.py).
"""
import re
from typing import Dict, List, Optional, Tuple


FIELDS = ('side', 'input', 'input_name', 'settings', 'file', 'platform', 'commit', 'batch', 'run')
# a file name's bytes: most filesystems allow 255, we keep some room
MAX_NAME_BYTES = 200

_field = re.compile(r'\{([^{}]*)\}')
_forbidden_windows = re.compile(r'[<>:"|?*\x00-\x1f]')
_forbidden = re.compile(r'[\x00-\x1f]')
_reserved_windows = re.compile(r'^(CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(\.|$)', re.IGNORECASE)
_spaces = re.compile(r'\s+')
_extension = re.compile(r'^\.[A-Za-z0-9]{1,8}$')
# compressed files keep both extensions: "out.tar.gz"
_compressed = ('.gz', '.bz2', '.xz', '.zst', '.zip', '.7z')


class ExportNameError(ValueError):
  pass


def parse_template(template: str) -> List[Tuple[str, str]]:
  """[("literal", text) or ("field", name)]"""
  parts: List[Tuple[str, str]] = []
  position = 0
  for match in _field.finditer(template):
    if match.start() > position:
      parts.append(('literal', template[position:match.start()]))
    name = match.group(1).strip()
    if name not in FIELDS:
      raise ExportNameError(f"Unknown field {{{name}}}: use {', '.join('{' + f + '}' for f in FIELDS)}")
    parts.append(('field', name))
    position = match.end()
  if position < len(template):
    parts.append(('literal', template[position:]))
  for kind, text in parts:
    if kind == 'literal' and ('{' in text or '}' in text):
      raise ExportNameError("Braces go around field names, like {input}")
  if not any(kind == 'field' for kind, _ in parts):
    raise ExportNameError("The template needs fields, like {input} and {file}")
  return parts


def split_extension(path: str) -> Tuple[str, str]:
  """("debug/out", ".png") for "debug/out.png". Only short extensions: "scene.v2.1" or ".bashrc" have none."""
  slash = path.rfind('/')
  dot = path.rfind('.')
  if dot <= slash + 1:
    return path, ''
  extension = path[dot:]
  if not _extension.match(extension):
    return path, ''
  if extension.lower() in _compressed:
    stem, inner = split_extension(path[:dot])
    if inner and inner.lower() not in _compressed:
      return stem, inner + extension
  return path[:dot], extension


def input_fields(test_input_path: str) -> Dict[str, str]:
  """{input}: the input's path without its extension, {input_name}: only its name"""
  path = str(test_input_path).replace('\\', '/').strip('/')
  stem, _ = split_extension(path)
  return {'input': stem, 'input_name': stem.rsplit('/', 1)[-1]}


def clean(text: str, keep_slashes: bool, separator: str = '_', windows: bool = True) -> str:
  text = re.sub(r'\s*/\s*', '/', str(text).replace('\\', '/'))
  if not keep_slashes:
    text = text.strip('/').replace('/', separator)
  text = (_forbidden_windows if windows else _forbidden).sub('-', text)
  return _spaces.sub('_', text)


def render(template: str, fields: Dict[str, Optional[str]], separator: str = '_', extension: str = '', windows: bool = True) -> str:
  """The relative path of a file, e.g. "img01__gain=4__out__new.png". Raises ExportNameError"""
  if separator not in ('/', '_', '__', '-', '.', '+'):
    raise ExportNameError(f'Unknown separator "{separator}"')
  parts = parse_template(template)
  texts = []
  for kind, text in parts:
    if kind == 'literal':
      texts.append(clean(text, keep_slashes=True, windows=windows))
    else:
      value = fields.get(text)
      texts.append(clean(value, keep_slashes=separator == '/', separator=separator, windows=windows) if value not in (None, '') else '')
  # an empty field takes the separator before it along, else the one after it (not folders)
  dropped = set()
  for index, (kind, _) in enumerate(parts):
    if kind != 'field' or texts[index]:
      continue
    for neighbor in (index - 1, index + 1):
      if 0 <= neighbor < len(parts) and parts[neighbor][0] == 'literal' and neighbor not in dropped and '/' not in texts[neighbor]:
        dropped.add(neighbor)
        break
  path = ''.join(text for index, text in enumerate(texts) if index not in dropped)
  segments = []
  for segment in path.split('/'):
    if segment in ('.', '..'):
      raise ExportNameError(f'"{segment}" can\'t be a file or folder name')
    if windows:
      # Windows ignores trailing dots and spaces
      segment = segment.rstrip('. ')
    if segment:
      segments.append(segment)
  if not segments:
    raise ExportNameError("The name is empty: add fields like {input} and {file}")
  segments[-1] += clean(extension, keep_slashes=False, windows=windows)
  if windows:
    segments = ['_' + segment if _reserved_windows.match(segment) else segment for segment in segments]
  for segment in segments:
    if len(segment.encode('utf-8')) > MAX_NAME_BYTES:
      raise ExportNameError(f"Name too long ({len(segment.encode('utf-8'))} bytes, at most {MAX_NAME_BYTES}): {segment[:60]}…")
  return '/'.join(segments)


def file_name(template: str, fields: Dict[str, Optional[str]], file: str, separator: str = '_', windows: bool = True) -> str:
  """The name of a file of a run: `file` is its path in the run's folder"""
  stem, extension = split_extension(str(file).replace('\\', '/'))
  return render(template, {**fields, 'file': stem}, separator=separator, extension=extension, windows=windows)
