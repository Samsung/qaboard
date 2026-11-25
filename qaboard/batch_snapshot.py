"""
Snapshots of the batches a `qa batch` ran: the definitions, as they were when it started, filtered to what it runs.

Batch files change: people edit them, and lose what an earlier batch ran. `qa batch` and the server save one YAML
per command with only:
- the batches that run, chosen by name, by pattern (`night-*`), through aliases ("groups", nested), or as pipeline steps,
- the aliases used to reach them,
- with the file-level defaults (database, platform, configurations) copied into each batch, like `qa batch` does,
  so that the file stands alone.

`qa batch --batches-file snapshot.yaml <the same batches>` runs the same inputs and configurations.
It only depends on PyYAML: the server imports it too.
"""
import fnmatch
from typing import Any
from collections.abc import Iterable

import yaml


# Keys of batch files that are settings for their batches, not batches (like qaboard/iterators.py)
BATCH_FILE_SETTINGS = ('database', 'aliases', 'groups', 'configs', 'configurations', 'platform', 'matrix')
# Copied from a file into its batches when they don't set them (iterators.iter_inputs)
FILE_DEFAULTS = ("platform", "database", "configurations", "configs")
# Like iterators.resolve_aliases
MAX_DEPTH = 10
# The snapshot of untrusted files can't stand for more batches than this
MAX_BATCHES = 10_000
# Sent with the command to QA-Board: larger snapshots are not saved
MAX_SNAPSHOT_SIZE = 256 * 1024


class _Dumper(yaml.SafeDumper):
  """No &id001 anchors for values shared by several batches: each batch reads on its own."""
  def ignore_aliases(self, data):
    return True


def _dump(data) -> str:
  return yaml.dump(data, Dumper=_Dumper, default_flow_style=False, sort_keys=False, allow_unicode=True, width=120)


def load_batches_file(path) -> dict | None:
  """The batches of a file, as `qa batch` reads them, or None if it's empty or not a mapping."""
  with open(path, encoding='utf-8') as f:
    batches = yaml.load(f, Loader=yaml.SafeLoader)
  return batches if isinstance(batches, dict) and batches else None


def _is_batch_name(name) -> bool:
  return isinstance(name, str) and not name.startswith('.') and name not in BATCH_FILE_SETTINGS


def available_batches(files: Iterable[tuple[str, dict | None]], allow_duplicate_batches=False):
  """
  Merges batch files like `qa batch`, from [(path, batches)] in the order it reads them.
  Returns ({batch name: [(path, definition)]}, {alias: (path, names)}).
  A batch defined in several files keeps the last definition, or all of them with `inputs.allow_duplicate_batches`.
  """
  batches: dict[str, list[tuple[str, Any]]] = {}
  aliases: dict[str, tuple[str, Any]] = {}
  for path, content in files:
    if not isinstance(content, dict):
      continue
    file_aliases = content.get('aliases', content.get('groups', {})) or {}
    if isinstance(file_aliases, dict):
      aliases.update({name: (path, names) for name, names in file_aliases.items() if isinstance(name, str)})
    for name, definition in content.items():
      if not _is_batch_name(name):
        continue
      if isinstance(definition, dict) and definition.get("type") != "pipeline":
        defaults = {attr: content[attr] for attr in FILE_DEFAULTS if attr in content and attr not in definition}
        definition = {**definition, **defaults}
      if allow_duplicate_batches and name in batches:
        batches[name].append((path, definition))
      else:
        batches[name] = [(path, definition)]
  return batches, aliases


def _names(value) -> list:
  if value is None:
    return []
  return list(value) if isinstance(value, (list, tuple)) else [value]


def _pipeline_steps(definition) -> list[str]:
  """The batches a pipeline's steps run (`configurations: [{batch: name or [names]}]`)."""
  if not isinstance(definition, dict) or definition.get('type') != 'pipeline':
    return []
  steps: list[str] = []
  for key, value in definition.items():
    if str(key).lower() not in ('configuration', 'configurations', 'configs'):
      continue
    for step in _names(value):
      if isinstance(step, dict) and 'batch' in step:
        steps.extend(n for n in _names(step['batch']) if isinstance(n, str))
  return steps


def select(names, batches, aliases):
  """
  What runs for `qa batch <names>`: (the batches, in order, the aliases used, the names that aren't batches).
  Names that are neither batches nor aliases are patterns, else `qa batch` reads them as input paths.
  """
  selected: list[str] = []
  used_aliases: list[str] = []
  not_batches: list[str] = []

  def add_batch(name):
    if name in selected:
      return
    if len(selected) >= MAX_BATCHES:
      raise ValueError(f"The batches stand for more than {MAX_BATCHES} batches: check that the aliases don't refer to each other.")
    selected.append(name)
    for _, definition in batches[name]:
      for step in _pipeline_steps(definition):
        resolve(step, MAX_DEPTH)

  def resolve(name, depth):
    if isinstance(name, (list, tuple)):
      for n in name:
        resolve(n, depth)
      return
    if not isinstance(name, str):
      return
    if depth and name in aliases:
      if name not in used_aliases:
        used_aliases.append(name)
      for n in _names(aliases[name][1]):
        resolve(n, depth - 1)
      return
    if name in batches:
      add_batch(name)
      return
    matches = [b for b in batches if fnmatch.fnmatch(b, name)]
    for match in matches:
      add_batch(match)
    if not matches and name not in not_batches:
      not_batches.append(name)

  resolve(list(names), MAX_DEPTH)
  return selected, used_aliases, not_batches


def snapshot(names, files: Iterable[tuple[str, dict | None]], allow_duplicate_batches=False, header: Iterable[str] = ()) -> dict[str, Any]:
  """
  The snapshot of what `qa batch <names>` runs, from the batch files [(path, batches)] it reads, in order.
  Returns {"yaml": the snapshot's text, "batches": the batches it defines, "aliases", "files": the paths of the files
  they come from, "inputs": the names that are not batches (input paths)}.
  """
  files = list(files)
  batches, aliases = available_batches(files, allow_duplicate_batches)
  selected, used_aliases, not_batches = select(names, batches, aliases)

  parts = [f"# {line}" if line else "#" for line in header]
  snapshot_aliases: dict[str, Any] = {name: aliases[name][1] for name in used_aliases}
  definitions: list[tuple[str, str, Any]] = []  # (name in the snapshot, path, definition)
  for name in selected:
    defined = batches[name]
    if len(defined) == 1:
      definitions.append((name, *defined[0]))
      continue
    # like qaboard/iterators.py with allow_duplicate_batches: an alias to each definition
    duplicate_names = [f"{name}_FIRST", *(f"{name}@{path}" for path, _ in defined[1:])]
    snapshot_aliases[name] = duplicate_names
    definitions.extend((n, path, definition) for n, (path, definition) in zip(duplicate_names, defined))
  if snapshot_aliases:
    parts.append(_dump({"aliases": snapshot_aliases}).rstrip())
  for name, path, definition in definitions:
    parts.append(f"\n# from {path}\n" + _dump({name: definition}).rstrip())
  used_files = []
  for path in [*(aliases[a][0] for a in used_aliases), *(path for _, path, _ in definitions)]:
    if path not in used_files:
      used_files.append(path)
  text = "\n".join(parts) + "\n"
  return {
    "yaml": text,
    "batches": [name for name, _, _ in definitions],
    "aliases": used_aliases,
    "files": used_files,
    "inputs": not_batches,
  }


def header_lines(names, command=None, when=None) -> list[str]:
  """What the snapshot's first lines say: where it comes from, and how to run it again."""
  lines = ["The batches this command ran, as they were defined when it started. Only what it ran is here."]
  if command:
    lines.append(f"Command: {command}")
  if when:
    lines.append(f"Started: {when}")
  lines += ["To run them again, save this file, then:",
            f"  qa batch --batches-file batches.yaml {' '.join(_quote(n) for n in names)}".rstrip(), ""]
  return lines


def _quote(text) -> str:
  import shlex
  return shlex.quote(str(text))


# `qa batch` options whose value names batch files
_FILE_OPTIONS = ('--batches-file', '--groups-file')

def reproduce_argv(argv: list[str], snapshot_path: str) -> list[str]:
  """
  The command line of `qa batch`, reading the snapshot instead of the batch files: `qa ... batch --batches-file <snapshot> ...`.
  argv is sys.argv: its first item is how `qa` was called, we write `qa`.
  """
  args = ["qa"]
  skip = False
  inserted = False
  for arg in argv[1:]:
    if skip:
      skip = False
      continue
    if arg in _FILE_OPTIONS:
      skip = True
      continue
    if any(arg.startswith(f"{option}=") for option in _FILE_OPTIONS):
      continue
    args.append(arg)
    if not inserted and arg in ('batch', 'optimize'):
      args += ['--batches-file', snapshot_path]
      inserted = True
  return args


def command_snapshot(names, batches_files, allow_duplicate_batches=False, argv=None, when=None) -> dict[str, Any] | None:
  """
  What `qa batch` sends to QA-Board with its command: the snapshot of the batches it runs, from its batch files:
  paths, or (the path as users wrote it, where it is).
  Returns {"yaml", "batches", "aliases", "files", "inputs", "names": as given, "reproduce": argv reading the snapshot}, or
  {"error"} / {"too_large": size} when it can't be saved, or None without batches.
  """
  if not names:
    return None
  import shlex
  files = []
  try:
    for path in batches_files:
      label, path = path if isinstance(path, tuple) else (path, path)
      files.append((str(label), load_batches_file(path)))
  except Exception as e:  # `qa batch` says what's wrong with the file when it reads it
    return {"error": f"Could not read {path}: {e}"}
  command = shlex.join(['qa', *argv[1:]]) if argv else None
  try:
    result = snapshot(names, files, allow_duplicate_batches, header=header_lines(names, command=command, when=when))
  except ValueError as e:
    return {"error": str(e)}
  # the batches as given, aliases and patterns unresolved: to run the same command
  result["names"] = list(names)
  if argv:
    result["reproduce"] = reproduce_argv(argv, "batches.yaml")
  size = len(result["yaml"].encode('utf-8'))
  if size > MAX_SNAPSHOT_SIZE:
    return {**{k: v for k, v in result.items() if k != "yaml"}, "too_large": size}
  return result
