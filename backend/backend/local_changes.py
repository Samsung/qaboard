"""
How much runs may record of their local changes (docs/rfcs/local-changes.md): the `runs.local_changes` setting.

- "patch" (the default): the changed files' summary, and the patches as files of the run (.qaboard/*.patch)
- "summary": the summary only, no code: what a server that must not receive source code allows
- "off": nothing

We keep what runs send in `data.local_changes` up to that level, with the fields and types we know (the web app shows
them), refuse the patches they upload above it, and tell them the level when they start, so that the ones writing in
a storage shared with us don't write patches either.
"""
import re
from typing import Any, Dict, Optional

from qaboard.local_changes import LEVELS, FOLDER, PATCH_FILE, UNPUSHED_FILE, lowest

from .settings import setting

MAX_FILES = 500
MAX_NAMES = 100
MAX_PATH = 4096
MAX_TEXT = 500

FLAGS = ('dirty', 'pushed', 'timed_out')
TEXTS = ('scope', 'head', 'branch', 'upstream', 'base', 'sha256', 'error', 'untracked_contents')
COUNTS = ('unpushed_commits', 'files_total', 'added', 'deleted', 'untracked', 'ms')
NAMES = ('excluded', 'untracked_too_large')
PATCHES = {'patch': PATCH_FILE, 'unpushed': UNPUSHED_FILE}


def level() -> str:
  value = setting('runs.local_changes')
  return value if value in LEVELS else 'patch'


def _count(value) -> Optional[int]:
  return value if isinstance(value, int) and not isinstance(value, bool) and value >= 0 else None


CONTROL = re.compile(r'[\x00-\x1f\x7f-\x9f]')
# commits: people copy commands made of them (git checkout <head>)
SHAS = ('head', 'base')
SHA = re.compile(r'[0-9a-f]{40}([0-9a-f]{24})?')


def _text(value, size=MAX_TEXT) -> Optional[str]:
  """Text, without control characters (terminals and logs show them)"""
  return CONTROL.sub('', value[:size]) if isinstance(value, str) else None


def cleaned(state: Any, current: str) -> Optional[Dict[str, Any]]:
  """What we keep of a run's local changes at the server's level: the fields we know, of the types we expect"""
  if not isinstance(state, dict) or current == 'off':
    return None
  kept: Dict[str, Any] = {'level': lowest(state.get('level') if state.get('level') in LEVELS else 'patch', current)}
  for key in FLAGS:
    if key in state:
      kept[key] = state[key] if isinstance(state[key], bool) else None
  for key in TEXTS:
    if _text(state.get(key)) is not None and (key not in SHAS or SHA.fullmatch(state[key])):
      kept[key] = _text(state[key])
  for key in COUNTS:
    if _count(state.get(key)) is not None:
      kept[key] = state[key]
  if isinstance(state.get('files'), list):
    files = []
    for f in state['files'][:MAX_FILES]:
      if not isinstance(f, dict) or not isinstance(f.get('path'), str):
        continue
      entry: Dict[str, Any] = {'path': _text(f['path'], MAX_PATH), 'status': _text(f.get('status'), 2) or 'M',
                               'added': _count(f.get('added')), 'deleted': _count(f.get('deleted'))}
      if f.get('binary') is True:
        entry['binary'] = True
      files.append(entry)
    kept['files'] = files
  for key in NAMES:
    if isinstance(state.get(key), list):
      kept[key] = [_text(name, MAX_PATH) for name in state[key][:MAX_NAMES] if isinstance(name, str)]
  if isinstance(state.get('unpushed_log'), list):
    kept['unpushed_log'] = [{'sha': c['sha'], 'subject': _text(c.get('subject'), 200) or ''} for c in state['unpushed_log'][:50]
                            if isinstance(c, dict) and isinstance(c.get('sha'), str) and SHA.fullmatch(c['sha'])]
  for key, path in PATCHES.items():
    patch = state.get(key)
    if not isinstance(patch, dict):
      continue
    entry = {k: v for k, v in (('bytes', _count(patch.get('bytes'))), ('sha256', _text(patch.get('sha256'), 64))) if v is not None}
    # only where qa saves them: the web app fetches them from the run's folder
    if current == 'patch' and patch.get('path') == path:
      entry['path'] = path
    elif current != 'patch':
      entry['omitted'] = 'level'
    else:
      entry['omitted'] = _text(patch.get('omitted'), 32) or 'error'
    kept[key] = entry
  return kept


def allowed_data(data: Dict[str, Any], current: Optional[str] = None) -> Dict[str, Any]:
  """What we keep of the local changes a run sends in its `data` (changed in place, and returned)"""
  current = current or level()
  if 'dirty' in data:
    if current == 'off':
      data.pop('dirty')
    elif not isinstance(data['dirty'], bool):
      data['dirty'] = None
  if 'local_changes' in data:
    state = cleaned(data['local_changes'], current)
    if state is None:
      data.pop('local_changes')
    else:
      data['local_changes'] = state
  return data


def refuses_file(path: str, current: Optional[str] = None) -> bool:
  """Whether a run can't send us this file of its folder: anything in .qaboard/ that looks like a patch, above the level"""
  current = current or level()
  lowered = path.lower()
  return current != 'patch' and lowered.split('/', 1)[0] == FOLDER and lowered.endswith(('.patch', '.diff'))


def ran_local_changes(output) -> bool:
  """Whether a run ran code its commit doesn't have: uncommitted changes, or commits that were never pushed"""
  changes = (getattr(output, 'data', None) or {}).get('local_changes')
  return isinstance(changes, dict) and (changes.get('dirty') is True or changes.get('pushed') is False)


def redo_warning(outputs) -> Optional[str]:
  """What to tell people who redo runs that ran local changes: QA-Board redoes them on their commit, as it is"""
  local = [o for o in outputs if ran_local_changes(o)]
  if not local:
    return None
  some = "This run" if len(outputs) == 1 else ("These runs" if len(local) == len(outputs) else f"{len(local)} of these {len(outputs)} runs")
  return (f"{some} ran local changes (uncommitted, or not pushed). Redone from QA-Board, they run their commit as it is, "
          "without those changes: their results can change. To run them with their changes, use `qa restore <run id>` and run them from there.")
