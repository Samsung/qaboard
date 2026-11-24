"""
Diagnostic logs of `qa` and the SDK: what qa resolved and did (its config, requests to the server, runners, uploads).
They are not what qa tells people (click.echo): logs are for debugging, and off below warnings unless asked for.

- Modules log to `logger = logging.getLogger(__name__)`, under "qaboard". As a library (the SDK in your code) qaboard
  configures nothing: your logging decides, e.g. `logging.getLogger("qaboard").setLevel(logging.DEBUG)`.
- Only the `qa` CLI calls `setup()`, for the "qaboard" logger: `-v` info, `-vv` debug, `-vvv` other libraries' debug
  logs too; else $QA_LOG_LEVEL or $QABOARD_LOG_LEVEL (a name or a number); else $QA_VERBOSE (older): debug; else
  warnings. On stderr (runs' log.txt get them): with rich's handler on a terminal and in CI (colors, qaboard/terminal.py),
  else plain lines with times (e.g. runners' log files, $NO_COLOR). `--log-file`/$QA_LOG_FILE: debug logs also there.
- Logs never show tokens: our handlers scrub `token=...` parameters, Authorization values and QA-Board tokens (scrub()).
"""
import logging
import os
import re
import sys
from collections.abc import Mapping

LOGGER = 'qaboard'
LEVEL_VARIABLES = ('QA_LOG_LEVEL', 'QABOARD_LOG_LEVEL')
# the handlers setup() adds have this attribute: calling it again replaces them
_OURS = '_qaboard_cli_handler'
PLAIN_FORMAT = '%(asctime)s %(levelname)s %(name)s: %(message)s'

_CREDENTIALS = re.compile(r'\b(Bearer|Basic)(\s+)[^\s\'",;]+', re.IGNORECASE)
_QABOARD_TOKENS = re.compile(r'\bqab_[a-z]{3}_[A-Za-z0-9]+')


def scrub(text: str) -> str:
  """Filters secrets out of a log line: "?token=abc" => "?token=[Filtered]", "Bearer abc" => "Bearer [Filtered]"..."""
  from .sentry_utils import scrub_string, FILTERED
  text = scrub_string(text)
  text = _CREDENTIALS.sub(lambda m: f"{m.group(1)}{m.group(2)}{FILTERED}", text)
  return _QABOARD_TOKENS.sub(FILTERED, text)


class ScrubSecrets(logging.Filter):
  """On our handlers: whoever logs, what we write has no tokens"""
  def filter(self, record: logging.LogRecord) -> bool:
    try:
      message = record.getMessage()
    except Exception:
      return True
    scrubbed = scrub(message)
    if scrubbed != message:
      record.msg, record.args = scrubbed, None
    return True


class _Stderr(logging.StreamHandler):
  """Writes to sys.stderr as it is when logging, e.g. a run's log.txt tee (utils.redirect_std_streams), or tests' capture"""
  @property  # type: ignore[override]
  def stream(self):
    return sys.stderr

  @stream.setter
  def stream(self, value):
    pass


def parse_level(value: str | None) -> int | None:
  """"debug", "INFO", "10"... => a logging level; None when unset or unknown"""
  if value is None or not str(value).strip():
    return None
  value = str(value).strip()
  if value.isdigit():
    return int(value)
  level = logging.getLevelName(value.upper())
  return level if isinstance(level, int) else None


def level_for(verbose: int = 0, env: Mapping[str, str] | None = None) -> int:
  """The level of qa's logs: the -v flags, else $QA_LOG_LEVEL/$QABOARD_LOG_LEVEL, else $QA_VERBOSE, else warnings"""
  env = os.environ if env is None else env
  if verbose >= 2:
    return logging.DEBUG
  if verbose == 1:
    return logging.INFO
  for name in LEVEL_VARIABLES:
    level = parse_level(env.get(name))
    if level is not None:
      return level
  if 'QA_VERBOSE' in env:
    return logging.DEBUG
  return logging.WARNING


def _console_handler(env: Mapping[str, str]) -> logging.Handler:
  from . import terminal
  handler: logging.Handler
  if terminal.colors(sys.stderr, env):
    # on a terminal, or in CI whose web views render colors (qaboard/terminal.py). Imported only then: `qa` starts faster
    from rich.console import Console
    from rich.logging import RichHandler
    tty = terminal.is_terminal(sys.stderr)
    console = Console(stderr=True, force_terminal=True, force_interactive=tty, width=terminal.width(sys.stderr, env))
    handler = RichHandler(console=console, show_path=False, markup=False, rich_tracebacks=False,
                          log_time_format='[%X]' if tty else '[%Y-%m-%d %X]')
  else:
    handler = _Stderr()
    handler.setFormatter(logging.Formatter(PLAIN_FORMAT))
  return handler


def _add(logger: logging.Logger, handler: logging.Handler, level: int) -> None:
  handler.setLevel(level)
  handler.addFilter(ScrubSecrets())
  setattr(handler, _OURS, True)
  logger.addHandler(handler)


def _remove_ours(logger: logging.Logger) -> None:
  for handler in list(logger.handlers):
    if getattr(handler, _OURS, False):
      logger.removeHandler(handler)
      handler.close()


def setup(verbose: int = 0, log_file: str | None = None, env: Mapping[str, str] | None = None) -> int:
  """
  For the `qa` CLI only, never for libraries: where qa's logs go. Returns the level shown. Can be called again.
  The runs `qa -v batch` starts log like it: we set $QA_LOG_LEVEL (and $QA_LOG_FILE) for them.
  """
  env = os.environ if env is None else env
  logger = logging.getLogger(LOGGER)
  root = logging.getLogger()
  _remove_ours(logger)
  _remove_ours(root)
  level = level_for(verbose, env)
  _add(logger, _console_handler(env), level)
  levels = [level]
  log_file = log_file or env.get('QA_LOG_FILE') or None
  if log_file:
    log_file = os.path.abspath(log_file)  # qa changes the working directory to the project's
    file_handler = logging.FileHandler(log_file, encoding='utf-8', delay=True)
    file_handler.setFormatter(logging.Formatter(PLAIN_FORMAT))
    _add(logger, file_handler, logging.DEBUG)
    levels.append(logging.DEBUG)
  logger.setLevel(min(levels))
  # the code `qa run` runs may configure the root logger: our logs aren't shown twice
  logger.propagate = False
  if verbose >= 3:
    # the CLI owns the process: other libraries' logs too (requests, urllib3, git...)
    _add(root, _console_handler(env), logging.DEBUG)
    root.setLevel(logging.DEBUG)
  if verbose and env is os.environ:
    os.environ['QA_LOG_LEVEL'] = logging.getLevelName(level)
  if log_file and env is os.environ:
    os.environ['QA_LOG_FILE'] = log_file
  return level
