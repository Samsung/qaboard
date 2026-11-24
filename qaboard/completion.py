"""
Shell completion for `qa`: `qa completion install`, and what the options complete with.

Click (>=8.0) does the completion: the shell runs `qa` with _QA_COMPLETE set (e.g. `_QA_COMPLETE=bash_complete`),
and `qa` prints the candidates. Click knows bash, zsh and fish; PowerShell is added here.
What options complete with comes from the project's qaboard.yaml and batches files, read from the disk:
completion never contacts QA-Board, and never fails (no candidates instead). It must stay fast: `import qaboard.qa`
doesn't import requests or the runners (tests/test_startup.py).
"""
import os
import sys
import shutil
import subprocess
from pathlib import Path
from typing import Any
from collections.abc import Iterable

import click
from click.shell_completion import CompletionItem, ShellComplete, add_completion_class, split_arg_string


COMPLETE_VAR = '_QA_COMPLETE'
SHELLS = ('bash', 'zsh', 'fish', 'powershell')
# qaboard/runners/__init__.py's `runners`: not imported here, it imports their clients (tests/test_completion.py checks it)
RUNNERS = ('local', 'lsf', 'celery', 'dask', 'windows', 'kubernetes')
ACTIONS_ON_EXISTING = ('run', 'postprocess', 'sync', 'skip', 'assert-exists')
ACTIONS_ON_PENDING = ('wait', 'sync', 'skip', 'run')
# at most this many paths for --input: databases can be huge
MAX_PATHS = 500


def is_completing() -> bool:
  return COMPLETE_VAR in os.environ


# What options complete with
###############################################################################

def _candidates(values: Iterable[str], incomplete: str) -> list[CompletionItem]:
  seen = set()
  items = []
  for value in values:
    if value in seen or not value.startswith(incomplete):
      continue
    seen.add(value)
    items.append(CompletionItem(value))
  return items


def _quiet(completer):
  """Completion never fails: no candidates instead"""
  def complete(ctx, param, incomplete):
    try:
      return completer(ctx, param, incomplete)
    except Exception:
      return []
  complete.__name__ = completer.__name__
  return complete


def _config():
  from . import config as _  # noqa: F401 (the submodule: `qaboard.config` is the dict)
  return sys.modules['qaboard.config']


def _root() -> Path:
  root = _config().root_qatools
  return Path(root) if root else Path()


def _yaml(path: Path) -> Any:
  import yaml
  with path.open(encoding='utf-8') as f:
    return yaml.load(f, Loader=yaml.SafeLoader)


def batches_files_of(ctx: click.Context | None) -> list[Any]:
  """The batches files a command reads: its --batches-file, else qaboard.yaml's inputs.batches"""
  given = ctx.params.get('batches_files') if ctx is not None else None
  return list(given) if given else list(_config().default_batches_files)


def read_batches_files(batches_files: Iterable[Any]) -> list[tuple[Path, dict[str, Any]]]:
  """The content of the batches files we can read, as `qa batch` finds them. Others are ignored."""
  from .conventions import location_from_spec
  qa_config = _config()
  found = []
  for batches_file in batches_files:
    try:
      path = location_from_spec(batches_file, {"project": qa_config.project, "subproject": qa_config.subproject})
      if not path.is_absolute():
        path = _root() / path
      content = _yaml(path)
    except Exception:
      continue
    if isinstance(content, dict):
      found.append((path, content))
  return found


def batch_names(batches_files: Iterable[Any]) -> list[dict[str, str]]:
  """The batches and aliases `qa batch` can run, in their files' order: [{"name", "kind": batch|alias, "file"}]"""
  from .iterators import BATCH_FILE_SETTINGS
  names: list[dict[str, str]] = []
  for path, content in read_batches_files(batches_files):
    aliases = content.get('aliases', content.get('groups')) or {}
    for name in content:
      name = str(name)
      if name.startswith('.') or name in BATCH_FILE_SETTINGS:
        continue
      names.append({"name": name, "kind": "batch", "file": str(path)})
    if isinstance(aliases, dict):
      names.extend({"name": str(name), "kind": "alias", "file": str(path)} for name in aliases)
  return names


@_quiet
def complete_batches(ctx, param, incomplete):
  return _candidates((b['name'] for b in batch_names(batches_files_of(ctx))), incomplete)


@_quiet
def complete_platforms(ctx, param, incomplete):
  platforms = [_config().default_platform, 'linux', 'windows']
  for _, content in read_batches_files(batches_files_of(None)):
    for value in [content, *content.values()]:
      if isinstance(value, dict) and isinstance(value.get('platform'), str):
        platforms.append(value['platform'])
  return _candidates(platforms, incomplete)


@_quiet
def complete_input_types(ctx, param, incomplete):
  types = (_config().config.get('inputs') or {}).get('types') or {}
  return _candidates(['default', *(str(t) for t in types if t != 'default')], incomplete)


@_quiet
def complete_configurations(ctx, param, incomplete):
  """The configurations named in qaboard.yaml and the batches files: those that are strings"""
  qa_config = _config()
  found: list[str] = []
  def add(value):
    if isinstance(value, str):
      found.append(value)
    elif isinstance(value, list):
      for v in value:
        add(v)
  inputs = qa_config.config.get('inputs') or {}
  for settings in [inputs, *((inputs.get('types') or {}).values())]:
    if isinstance(settings, dict):
      for key in ('configs', 'configurations', 'configuration'):
        add(settings.get(key))
  for _, content in read_batches_files(batches_files_of(None)):
    for value in [content, *content.values()]:
      if isinstance(value, dict):
        for key in ('configs', 'configurations', 'configuration'):
          add(value.get(key))
  return _candidates(found, incomplete)


@_quiet
def complete_runners(ctx, param, incomplete):
  return _candidates(RUNNERS, incomplete)


@_quiet
def complete_actions_on_existing(ctx, param, incomplete):
  return _candidates(ACTIONS_ON_EXISTING, incomplete)


@_quiet
def complete_actions_on_pending(ctx, param, incomplete):
  return _candidates(ACTIONS_ON_PENDING, incomplete)


def database_of(ctx: click.Context | None) -> Path:
  """--database, else the input type's default database"""
  root = ctx.find_root() if ctx is not None else None
  params = root.params if root is not None else {}
  if params.get('database'):
    return Path(params['database'])
  from .conventions import get_settings
  qa_config = _config()
  settings = get_settings(params.get('input_type') or qa_config.default_input_type, qa_config.config)
  return Path(qa_config.get_default_database(settings))


@_quiet
def complete_inputs(ctx, param, incomplete):
  """Paths relative to the database, like --input wants them"""
  database = database_of(ctx)
  if not database.is_absolute():
    database = _root() / database
  folder, _, prefix = incomplete.replace('\\', '/').rpartition('/')
  directory = database / folder if folder else database
  items = []
  with os.scandir(directory) as entries:
    for entry in entries:
      if not entry.name.startswith(prefix) or (entry.name.startswith('.') and not prefix.startswith('.')):
        continue
      value = f"{folder}/{entry.name}" if folder else entry.name
      items.append(CompletionItem(f"{value}/" if entry.is_dir() else value))
      if len(items) >= MAX_PATHS:
        break
  return sorted(items, key=lambda item: item.value)


# PowerShell
###############################################################################

_SOURCE_POWERSHELL = r"""
Register-ArgumentCompleter -Native -CommandName %(prog_name)s -ScriptBlock {
    param($wordToComplete, $commandAst, $cursorPosition)
    $line = $commandAst.Extent.Text
    $position = $cursorPosition - $commandAst.Extent.StartOffset
    if ($position -gt $line.Length) { $line = $line + (' ' * ($position - $line.Length)) }
    $env:COMP_WORDS = $line.Substring(0, $position)
    $env:COMP_INCOMPLETE = "$wordToComplete"
    $env:%(complete_var)s = 'powershell_complete'
    try {
        %(prog_name)s | ForEach-Object {
            [System.Management.Automation.CompletionResult]::new($_, $_, 'ParameterValue', $_)
        }
    } finally {
        Remove-Item Env:%(complete_var)s, Env:COMP_WORDS, Env:COMP_INCOMPLETE -ErrorAction SilentlyContinue
    }
}
"""


class PowerShellComplete(ShellComplete):
  """PowerShell (5 and 7): one candidate per line. Paths are left to PowerShell's own completion."""
  name = 'powershell'
  source_template = _SOURCE_POWERSHELL

  def get_completion_args(self) -> tuple[list[str], str]:
    words = split_arg_string(os.environ.get('COMP_WORDS', ''))
    incomplete = os.environ.get('COMP_INCOMPLETE', '')
    if incomplete and words and words[-1] == incomplete:
      words = words[:-1]
    return words[1:], incomplete

  def format_completion(self, item: CompletionItem) -> str:
    return '' if item.type in ('file', 'dir') else item.value


def register_shells() -> None:
  add_completion_class(PowerShellComplete)


# Installing
###############################################################################

def detect_shell() -> str | None:
  """The user's shell, from $SHELL (PowerShell on Windows)"""
  if os.environ.get('PSModulePath') and (os.name == 'nt' or not os.environ.get('SHELL')):
    return 'powershell'
  name = Path(os.environ.get('SHELL', '')).name.lower()
  if name in ('pwsh', 'powershell'):
    return 'powershell'
  if name in SHELLS:
    return name
  return 'powershell' if os.name == 'nt' else None


def source(shell: str, prog_name: str = 'qa') -> str:
  """The script that makes the shell complete `qa`"""
  from click.shell_completion import get_completion_class
  register_shells()
  from .qa import qa
  completion_class = get_completion_class(shell)
  if completion_class is None:
    raise click.UsageError(f"Unknown shell: {shell}. Use one of: {', '.join(SHELLS)}")
  return completion_class(qa, {}, prog_name, COMPLETE_VAR).source()


def powershell_profile() -> Path | None:
  for program in ('pwsh', 'powershell'):
    executable = shutil.which(program)
    if not executable:
      continue
    try:
      p = subprocess.run([executable, '-NoProfile', '-Command', '$PROFILE'], capture_output=True, text=True, timeout=30)
    except (OSError, subprocess.SubprocessError):
      continue
    if p.returncode == 0 and p.stdout.strip():
      return Path(p.stdout.strip())
  return None


def install_paths(shell: str, home: Path | None = None) -> tuple[Path, Path | None]:
  """Where the script goes, and the startup file that loads it (None when the shell loads it itself)"""
  from .site_config import user_config_dir
  home = home or Path.home()
  if shell == 'fish':
    config_home = os.environ.get('XDG_CONFIG_HOME')
    base = Path(config_home) if config_home and os.path.isabs(config_home) else home / '.config'
    return base / 'fish' / 'completions' / 'qa.fish', None
  extension = {'bash': 'bash', 'zsh': 'zsh', 'powershell': 'ps1'}[shell]
  script = user_config_dir() / 'completion' / f'qa.{extension}'
  if shell == 'bash':
    return script, home / '.bashrc'
  if shell == 'zsh':
    zdotdir = os.environ.get('ZDOTDIR')
    return script, (Path(zdotdir) if zdotdir else home) / '.zshrc'
  profile = powershell_profile()
  if profile is None:
    raise click.ClickException("Could not find your PowerShell profile ($PROFILE): is pwsh or powershell installed? Use `qa completion powershell` and add it to your profile.")
  return script, profile


def startup_lines(shell: str, script: Path) -> str:
  """What the startup file runs to load the script"""
  if shell == 'powershell':
    return f'. "{script}"'
  if shell == 'zsh':
    return f"(( $+functions[compdef] )) || {{ autoload -Uz compinit && compinit }}\n[ -f '{script}' ] && . '{script}'"
  return f"[ -f '{script}' ] && . '{script}'"


MARKER = "# qa shell completion (qa completion install)"


def install(shell: str, home: Path | None = None) -> dict[str, Any]:
  """Writes the script, and loads it from the shell's startup file. Doing it again only updates the script."""
  script, startup = install_paths(shell, home)
  script.parent.mkdir(parents=True, exist_ok=True)
  script.write_text(source(shell), encoding='utf-8')
  added = False
  if startup is not None:
    text = startup.read_text(encoding='utf-8') if startup.exists() else ''
    if MARKER not in text:
      startup.parent.mkdir(parents=True, exist_ok=True)
      with startup.open('a', encoding='utf-8') as f:
        f.write(f"{'' if not text or text.endswith(chr(10)) else chr(10)}\n{MARKER}\n{startup_lines(shell, script)}\n")
      added = True
  return {"shell": shell, "script": str(script), "startup_file": str(startup) if startup else None, "startup_file_changed": added}
