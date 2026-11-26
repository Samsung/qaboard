"""
How `qa` talks to people: errors, warnings, hints, and data printed as tables.

- stdout is the payload, what scripts read (paths, JSON...): it stays plain text when it's not a terminal.
  stderr is for people: what `qa` does, what went wrong and how to fix it.
- One style for diagnostics, like other CLIs (cargo, uv...):
    error: QA-Board refused the results (token_expired): they were not saved.
    hint: Run `qa auth login`
  `error:` is red and bold, `warning:` yellow, `hint:` cyan. Messages say what went wrong, with the value involved.
  Click's usage errors too (unknown option or command...): `qa` is a ui.Group, that shows them with show_usage_error.
- Colors, in this order: never with NO_COLOR (or QA_COLOR=never); always with FORCE_COLOR, CLICOLOR_FORCE or
  QA_COLOR=always; in CI, on stderr (CI logs are read in web pages that render colors; stdout stays plain, scripts
  read it); else only on terminals.
  `qa run` keeps colors in the logs QA-Board shows (qa.py `ctx.color`): the web app renders them.
- No spinners or progress bars that redraw lines: they would spam logs. Symbols (✓ ✗) only where they carry
  meaning (a run passed or failed), and only when the stream's encoding has them (not Windows' legacy code pages).
- Tracebacks are for bugs: expected errors (QAError, a server that can't be reached...) print a message,
  and the traceback only with `qa --verbose` (or QA_VERBOSE=1).

rich is imported only to print tables: `qa` starts faster without it.
"""
import os
import sys
from typing import Any, IO, NoReturn
from collections.abc import Iterable, Sequence

import click


# --- when to use colors and symbols ------------------------------------------------------------------------------

def _set(name: str) -> bool:
  return bool(os.environ.get(name))


ON = ('1', 'true', 'yes', 'always', 'on')
OFF = ('0', 'false', 'no', 'never', 'off')


def no_color() -> bool:
  """https://no-color.org: NO_COLOR is set (not empty), or QA_COLOR=never."""
  return _set('NO_COLOR') or os.environ.get('QA_COLOR', '').strip().lower() in OFF


def force_color() -> bool:
  """Colors even when piped: FORCE_COLOR or CLICOLOR_FORCE (set, not to 0 or false), or QA_COLOR=always."""
  if os.environ.get('QA_COLOR', '').strip().lower() in ON:
    return True
  for name in ('FORCE_COLOR', 'CLICOLOR_FORCE'):
    value = os.environ.get(name)
    if value and value.strip().lower() not in OFF:
      return True
  return False


def verbose() -> bool:
  """`qa --verbose`, or QA_VERBOSE: say more, e.g. what was sent to the server, and the traceback of errors."""
  return os.environ.get('QA_VERBOSE', '').strip().lower() not in ('', *OFF)


def in_ci() -> bool:
  """A CI job: its logs are read in a web page that renders colors, not on a terminal (qaboard/terminal.py)."""
  from .terminal import in_ci as terminal_in_ci
  return terminal_in_ci()


def is_terminal(stream: IO | None = None) -> bool:
  stream = stream if stream is not None else sys.stdout
  try:
    return bool(stream.isatty()) and os.environ.get('TERM') != 'dumb'
  except (AttributeError, ValueError):  # no isatty, or closed
    return False


def _fd(stream: IO | None) -> int | None:
  """The file descriptor of the stream, None if it has none, e.g. a StringIO or what tests capture."""
  try:
    return stream.fileno() if stream is not None else None
  except (AttributeError, ValueError, OSError):
    return None


def ci_colors(stream: IO | None = None) -> bool:
  """In CI, we color what we write to the job's stderr (not stdout: scripts read it)."""
  return in_ci() and _fd(stream if stream is not None else sys.stderr) == 2


def click_color(keeps_log_colors: bool = False) -> bool | None:
  """
  What `qa` sets as Click's `ctx.color`, used by click.echo/secho: False with NO_COLOR, True with FORCE_COLOR, when
  `keeps_log_colors` (`qa run`'s log, that QA-Board shows with its colors) or in CI, else None: colors on terminals.
  """
  if no_color():
    return False
  if force_color() or keeps_log_colors or ci_colors(sys.stderr):
    return True
  return None


def use_color(stream: IO | None = None) -> bool:
  """Whether to color what we write to this stream (default: stderr)."""
  stream = stream if stream is not None else sys.stderr
  if no_color():
    return False
  if force_color():
    return True
  ctx = click.get_current_context(silent=True)
  if ctx is not None and ctx.color is False:
    return False
  if is_terminal(stream) or ci_colors(stream):
    return True
  # `qa run`'s logs keep their colors, but a stdout piped elsewhere stays plain
  return bool(ctx is not None and ctx.color and _fd(stream) != 1)


def fancy(stream: IO | None = None) -> bool:
  """Whether to use symbols like ✓ and ✗ (default: on stderr): a terminal or a CI's log, whose encoding has them."""
  stream = stream if stream is not None else sys.stderr
  if not (is_terminal(stream) or ci_colors(stream)):
    return False
  try:
    '✓✗'.encode(getattr(stream, 'encoding', None) or 'ascii')
  except (UnicodeEncodeError, LookupError):
    return False
  return True


def symbol(ok: bool | None, stream: IO | None = None) -> str:
  """✓ (ok), ✗ (failed) or ! (None, a warning) when `fancy`, else ok / FAILED / !"""
  if fancy(stream):
    return {True: '✓', False: '✗', None: '!'}[ok]
  return {True: 'ok', False: 'FAILED', None: '!'}[ok]


def width() -> int | None:
  """The width of tables when not on a terminal: $COLUMNS, or 160 in CI (rich would use 80), else rich's choice."""
  try:
    return int(os.environ['COLUMNS'])
  except (KeyError, ValueError):
    return 160 if in_ci() else None


def style(text: str, stream: IO | None = None, **styles) -> str:
  """click.style, only when we use colors on this stream (default: stderr)."""
  return click.style(text, **styles) if use_color(stream if stream is not None else sys.stderr) else text


def echo(message: str = '', err: bool = True, **styles):
  """Prints a line, on stderr by default, colored only when we use colors there."""
  stream = sys.stderr if err else sys.stdout
  color = use_color(stream)
  click.echo(click.style(message, **styles) if styles and color else message, err=err, color=color)


# --- diagnostics: on stderr -------------------------------------------------------------------------------------

COLORS = {'error': 'red', 'warning': 'yellow', 'hint': 'cyan'}


def _message(kind: str, message: str, **styles) -> str:
  """`kind: message`, with the next lines indented under the message."""
  prefix = f"{kind}: "
  lines = str(message).splitlines() or ['']
  text = ('\n' + ' ' * len(prefix)).join(lines)
  color = use_color(sys.stderr)
  return (click.style(prefix, fg=COLORS[kind], bold=True) if color else prefix) + (click.style(text, **styles) if color and styles else text)


def _hints(hint):
  if not hint:
    return []
  return [hint] if isinstance(hint, str) else [h for h in hint if h]


def error(message: str, hint=None, details: str | None = None):
  """`error: message` on stderr, then `hint: ...` (one or a list). `details` (e.g. a server's answer) only with --verbose."""
  click.echo(_message('error', message), err=True, color=use_color(sys.stderr))
  if details and verbose():
    echo(details, dim=True)
  for line in _hints(hint):
    show_hint(line)


def warning(message: str, hint=None, details: str | None = None):
  """`warning: message` on stderr, then `hint: ...` (one or a list). `details` only with --verbose."""
  click.echo(_message('warning', message), err=True, color=use_color(sys.stderr))
  if details and verbose():
    echo(details, dim=True)
  for line in _hints(hint):
    show_hint(line)


def show_hint(message: str):
  """`hint: what to do` on stderr."""
  click.echo(_message('hint', message), err=True, color=use_color(sys.stderr))


def success(message: str, stream: IO | None = None):
  """`✓ message` in green on terminals, else the message (on stderr by default)."""
  stream = stream if stream is not None else sys.stderr
  text = f"{symbol(True, stream)} {message}" if fancy(stream) else message
  click.echo(style(text, stream, fg='green', bold=True), file=stream, color=use_color(stream))


def fail(message: str, hint=None, code: int = 1, details: str | None = None) -> NoReturn:
  """Prints the error, then exits with `code`."""
  error(message, hint=hint, details=details)
  sys.exit(code)


class QAError(click.ClickException):
  """
  An error the user can fix, not a bug: `qa` prints `error: message` and `hint: ...`, without a traceback,
  and exits with `exit_code` (1). Raise it from commands; Click (and Typer) print it.
  """
  def __init__(self, message: str, hint=None, exit_code: int = 1):
    super().__init__(message)
    self.hint = hint
    self.exit_code = exit_code  # type: ignore[misc]  # a class variable in some versions of click

  def show(self, file: IO | None = None):
    error(self.format_message(), hint=self.hint)


def _quoted(names: Iterable[str], prefix: str = '') -> str:
  return ', '.join(f"`{prefix}{name}`" for name in sorted(names))


def show_usage_error(e: click.UsageError):
  """
  Click's usage errors (unknown option or command, missing argument...) in our style:
    Usage: qa run [OPTIONS]

    error: No such option: --inpt
    hint: Did you mean `--input`?
    hint: Try `qa run --help`
  """
  ctx = e.ctx
  message, hints = e.format_message(), []
  # Click adds its suggestions to the message: we give them as a hint
  possibilities = getattr(e, 'possibilities', None) or []
  command_name = getattr(e, 'command_name', None)  # click.NoSuchCommand (click 8.2+)
  if isinstance(e, click.NoSuchOption):
    message = f"No such option: {e.option_name}"
    suggested = _quoted(possibilities)
  elif isinstance(command_name, str):
    message = f"No such command: {command_name}"
    suggested = _quoted(possibilities, prefix=f"{ctx.command_path} " if ctx is not None else '')
  if possibilities and (isinstance(e, click.NoSuchOption) or isinstance(command_name, str)):
    hints.append(f"Did you mean {suggested}?" if len(possibilities) == 1 else f"Did you mean one of {suggested}?")
  if ctx is not None:
    help_names = ctx.command.get_help_option_names(ctx) if ctx.command.get_help_option(ctx) is not None else []
    if help_names:
      hints.append(f"Try `{ctx.command_path} {max(help_names, key=len)}`")
    echo(ctx.get_usage(), dim=True)
    echo()
  error(message, hint=hints)


class UsageError(click.UsageError):
  """Wraps Click's usage errors, to show them in our style (show_usage_error). The exit code stays 2."""
  def __init__(self, cause: click.UsageError):
    super().__init__(cause.message, cause.ctx)
    self.cause = cause
    self.exit_code = cause.exit_code  # type: ignore[misc]

  def format_message(self) -> str:
    return self.cause.format_message()

  def show(self, file: IO | None = None):
    show_usage_error(self.cause)


def _styled(e: click.UsageError) -> click.UsageError:
  """Our UsageError for Click's, except the help that groups print when given no command (click.exceptions.NoArgsIsHelpError)"""
  if isinstance(e, UsageError) or type(e).__name__ == 'NoArgsIsHelpError':
    return e
  return UsageError(e)


class Group(click.Group):
  """
  A click.Group whose usage errors, and those of its commands, are shown in our style. `qa` uses it: subcommands and
  subgroups' errors reach it, raised while parsing (make_context) or while running (invoke).
  """
  def make_context(self, *args, **kwargs):
    try:
      return super().make_context(*args, **kwargs)
    except click.UsageError as e:
      styled = _styled(e)
      if styled is e:
        raise
      raise styled from e

  def invoke(self, ctx):
    try:
      return super().invoke(ctx)
    except click.UsageError as e:
      styled = _styled(e)
      if styled is e:
        raise
      raise styled from e


# --- explaining common errors ----------------------------------------------------------------------------------

def yaml_problem(e: Exception) -> str:
  """A YAML error in one line, with where it is."""
  mark = getattr(e, 'problem_mark', None)
  problem = getattr(e, 'problem', None) or str(e)
  where = f" (line {mark.line + 1}, column {mark.column + 1})" if mark is not None else ''
  return f"{problem}{where}"


def _classes(e: BaseException):
  return {cls.__name__ for cls in type(e).__mro__}


def request_problem(e: BaseException) -> str:
  """
  Why a request did not reach a server, in a few words: "connection refused", "timed out", "unknown host"...
  (the messages of requests are long). Without importing requests.
  """
  text = str(e)
  lowered = text.lower()
  classes = _classes(e)
  if 'Timeout' in classes:
    return "timed out"
  if 'SSLError' in classes:
    if 'CERTIFICATE_VERIFY_FAILED' in text:
      return "its TLS certificate is not trusted, see QABOARD_API_VERIFY"
    return "TLS error"
  if 'ProxyError' in classes:
    return "the proxy refused the connection, see HTTPS_PROXY and NO_PROXY"
  if 'refused' in lowered:
    return "connection refused"
  if any(s in lowered for s in ('name or service not known', 'nodename nor servname', 'getaddrinfo failed', 'name resolution',
                                'no address associated', 'failed to resolve')):
    return "unknown host"
  if classes & {'InvalidURL', 'MissingSchema', 'InvalidSchema'}:
    return "invalid URL"
  return "connection failed"


def is_connection_error(e: BaseException) -> bool:
  """requests' connection errors and timeouts, without importing requests."""
  for cls in type(e).__mro__:
    if cls.__module__.startswith('requests') and cls.__name__ in ('ConnectionError', 'Timeout'):
      return True
  return False


# --- data: on stdout --------------------------------------------------------------------------------------------

def console(stream: IO | None = None):
  """A rich Console for this stream (default: stdout), with our choice of colors. Markup and emoji codes are off."""
  from rich.console import Console
  stream = stream if stream is not None else sys.stdout
  color = use_color(stream)
  return Console(
    file=stream,
    force_terminal=True if color else None,
    # off a terminal (CI) we chose colors: rich's 'auto' would drop them with TERM=dumb, which CI runners often set
    color_system=('auto' if is_terminal(stream) else '256') if color else None,
    no_color=not color,
    highlight=False,
    markup=False,
    emoji=False,
    width=None if is_terminal(stream) else width(),
  )


def rich_output(stream: IO | None = None) -> bool:
  """Whether to print data as tables: on terminals. Piped, it's printed as plain lines, that scripts can read."""
  return is_terminal(stream if stream is not None else sys.stdout)


def print_table(columns: Sequence[str], rows: Iterable[Sequence[Any]], stream: IO | None = None, title: str | None = None,
                styles: list[str | None] | None = None, justify: list[str] | None = None):
  """
  Prints a table with rich (on terminals: check `rich_output()` first, and print plain lines otherwise).
  `styles`: a rich style per row (e.g. "red"), or None.
  """
  from rich.table import Table
  from rich import box
  table = Table(title=title, box=box.SIMPLE_HEAD, header_style='bold', show_edge=False, pad_edge=False, title_justify='left')
  for index, column in enumerate(columns):
    table.add_column(column, justify=(justify[index] if justify else 'left'), overflow='fold')  # type: ignore[arg-type]
  for index, row in enumerate(rows):
    table.add_row(*['' if value is None else str(value) for value in row], style=styles[index] if styles else None)
  console(stream).print(table)
