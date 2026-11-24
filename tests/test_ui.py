"""
Tests for qaboard/ui.py, how `qa` talks to people: colors only where they are read (terminals, CI logs), never with
NO_COLOR; stdout stays plain for scripts; errors say what to do, without tracebacks.
"""
import io
import os
import sys
import tempfile
import unittest
import subprocess
from pathlib import Path
from unittest import mock
from contextlib import redirect_stderr, redirect_stdout

import click
from click.testing import CliRunner

from qaboard import ui
from qaboard.terminal import CI_VARIABLES

ESC = '\x1b['
# what tells colors apart, removed to test the choices one by one
COLOR_VARIABLES = ('NO_COLOR', 'FORCE_COLOR', 'CLICOLOR_FORCE', 'QA_COLOR', 'TERM', 'COLUMNS', *CI_VARIABLES)


def clean_env(**env):
  return mock.patch.dict(os.environ, {**{k: v for k, v in os.environ.items() if k not in COLOR_VARIABLES}, **env}, clear=True)


class Terminal(io.StringIO):
  """A stream that says it's a terminal, on a file descriptor"""
  def __init__(self, fd=2):
    super().__init__()
    self.fd = fd
  def isatty(self):
    return True
  def fileno(self):
    return self.fd


class Pipe(io.StringIO):
  """A stream on a file descriptor that is not a terminal, like `qa ... 2> log.txt` or a CI job's"""
  def __init__(self, fd=2):
    super().__init__()
    self.fd = fd
  def fileno(self):
    return self.fd


def stderr_of(function, stream=None, **env):
  stream = stream if stream is not None else io.StringIO()
  with clean_env(**env), redirect_stderr(stream):
    function()
  return stream.getvalue()


class TestColors(unittest.TestCase):
  def test_no_colors_when_piped(self):
    output = stderr_of(lambda: ui.error("Boom", hint="Fix it"), Pipe())
    self.assertEqual(output, "error: Boom\nhint: Fix it\n")

  def test_colors_on_terminals(self):
    output = stderr_of(lambda: ui.error("Boom", hint="Fix it"), Terminal())
    self.assertIn(ESC, output)
    self.assertEqual(click.unstyle(output), "error: Boom\nhint: Fix it\n")

  def test_no_color(self):
    self.assertEqual(stderr_of(lambda: ui.warning("Careful"), Terminal(), NO_COLOR='1'), "warning: Careful\n")
    self.assertEqual(stderr_of(lambda: ui.warning("Careful"), Terminal(), QA_COLOR='never'), "warning: Careful\n")
    # NO_COLOR wins over everything
    self.assertNotIn(ESC, stderr_of(lambda: ui.warning("Careful"), Terminal(), NO_COLOR='1', FORCE_COLOR='1', CI='true'))
    # an empty NO_COLOR doesn't count (no-color.org)
    self.assertIn(ESC, stderr_of(lambda: ui.warning("Careful"), Terminal(), NO_COLOR=''))

  def test_force_color(self):
    for env in [{'FORCE_COLOR': '1'}, {'CLICOLOR_FORCE': '1'}, {'QA_COLOR': 'always'}]:
      with self.subTest(env):
        self.assertIn(ESC, stderr_of(lambda: ui.warning("Careful"), Pipe(), **env))
    self.assertNotIn(ESC, stderr_of(lambda: ui.warning("Careful"), Pipe(), FORCE_COLOR='0'))

  def test_ci_logs_have_colors_on_stderr_not_stdout(self):
    """CI logs are read in web pages that render colors. stdout stays plain: scripts read it."""
    for name in ('CI', 'GITLAB_CI', 'GITHUB_ACTIONS', 'JENKINS_URL', 'TF_BUILD'):
      with self.subTest(name):
        self.assertIn(ESC, stderr_of(lambda: ui.error("Boom"), Pipe(fd=2), **{name: 'true'}))
        with clean_env(**{name: 'true'}):
          self.assertFalse(ui.use_color(Pipe(fd=1)))
          self.assertEqual(ui.click_color(), None if _real_stderr_fd() != 2 else True)
    # what tests capture has no file descriptor: plain
    self.assertNotIn(ESC, stderr_of(lambda: ui.error("Boom"), io.StringIO(), CI='true'))

  def test_ci_tables_are_wide(self):
    with clean_env(CI='true'):
      self.assertEqual(ui.width(), 160)
      self.assertEqual(ui.console(Pipe(fd=1)).width, 160)
    with clean_env(CI='true', COLUMNS='200'):
      self.assertEqual(ui.width(), 200)
    with clean_env():
      self.assertIsNone(ui.width())

  def test_dumb_terminals(self):
    self.assertNotIn(ESC, stderr_of(lambda: ui.warning("Careful"), Terminal(), TERM='dumb'))

  def test_click_context_color(self):
    """`qa run` keeps colors in its logs (ctx.color=True), but stdout piped elsewhere stays plain; ctx.color=False is no colors"""
    for ctx_color, stream, colored in [(True, Pipe(fd=2), True), (True, Pipe(fd=1), False), (True, io.StringIO(), True), (False, Terminal(), False)]:
      with self.subTest(ctx_color=ctx_color, stream=stream), clean_env():
        with click.Context(click.Command('x'), color=ctx_color):
          self.assertEqual(ui.use_color(stream), colored)

  def test_click_color(self):
    with clean_env():
      self.assertIsNone(ui.click_color())
      self.assertTrue(ui.click_color(keeps_log_colors=True))
    with clean_env(NO_COLOR='1'):
      self.assertFalse(ui.click_color(keeps_log_colors=True))
    with clean_env(FORCE_COLOR='1'):
      self.assertTrue(ui.click_color())


def _real_stderr_fd():
  try:
    return sys.stderr.fileno()
  except Exception:
    return None


class TestSymbols(unittest.TestCase):
  def test_symbols_on_terminals_only(self):
    class Utf8Terminal(Terminal):
      encoding = 'utf-8'
    class Cp1252Terminal(Terminal):
      encoding = 'cp1252'
    with clean_env():
      self.assertEqual(ui.symbol(True, Utf8Terminal()), '✓')
      self.assertEqual(ui.symbol(False, Utf8Terminal()), '✗')
      self.assertEqual(ui.symbol(False, Pipe()), 'FAILED')
      # e.g. Windows' legacy consoles
      self.assertEqual(ui.symbol(True, Cp1252Terminal()), 'ok')

  def test_success(self):
    class Utf8Terminal(Terminal):
      encoding = 'utf-8'
    self.assertEqual(stderr_of(lambda: ui.success("Signed in."), Pipe()), "Signed in.\n")
    self.assertEqual(click.unstyle(stderr_of(lambda: ui.success("Signed in."), Utf8Terminal())), "✓ Signed in.\n")


class TestMessages(unittest.TestCase):
  def test_multiline_messages_and_hints(self):
    output = stderr_of(lambda: ui.error("Boom\nmore about it", hint=["First", None, "Second"]))
    self.assertEqual(output, "error: Boom\n       more about it\nhint: First\nhint: Second\n")

  def test_details_only_when_verbose(self):
    self.assertEqual(stderr_of(lambda: ui.warning("Failed", details="the payload")), "warning: Failed\n")
    self.assertIn("the payload", stderr_of(lambda: ui.warning("Failed", details="the payload"), QA_VERBOSE='1'))

  def test_fail_exits(self):
    with clean_env(), redirect_stderr(io.StringIO()) as stderr, self.assertRaises(SystemExit) as raised:
      ui.fail("Boom", hint="Fix it", code=3)
    self.assertEqual(raised.exception.code, 3)
    self.assertEqual(stderr.getvalue(), "error: Boom\nhint: Fix it\n")

  def test_qa_error_in_a_command(self):
    @click.command()
    def command():
      raise ui.QAError("No batch named 'nope'", hint="Batches: a, b")
    with clean_env():
      result = CliRunner().invoke(command)
    self.assertEqual(result.exit_code, 1)
    self.assertEqual(result.output, "error: No batch named 'nope'\nhint: Batches: a, b\n")
    self.assertNotIn('Traceback', result.output)

  def test_request_problems(self):
    import requests
    self.assertEqual(ui.request_problem(requests.ConnectionError("HTTPConnectionPool(host='x', port=9): Max retries exceeded with url: / (Caused by NewConnectionError(\"[Errno 111] Connection refused\"))")), "connection refused")
    self.assertEqual(ui.request_problem(requests.ConnectionError("Failed to resolve 'qa.nowhere' ([Errno -2] Name or service not known)")), "unknown host")
    self.assertEqual(ui.request_problem(requests.Timeout("Read timed out.")), "timed out")
    self.assertIn("TLS certificate is not trusted", ui.request_problem(requests.exceptions.SSLError("[SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed")))
    self.assertTrue(ui.is_connection_error(requests.ConnectionError()))
    self.assertTrue(ui.is_connection_error(requests.Timeout()))
    self.assertFalse(ui.is_connection_error(ValueError()))

  def test_yaml_problem(self):
    import yaml
    try:
      yaml.safe_load("a: [\n")
    except yaml.YAMLError as e:
      self.assertRegex(ui.yaml_problem(e), r"\(line \d+, column \d+\)$")


class TestTables(unittest.TestCase):
  def test_tables_without_colors_when_not_a_terminal(self):
    stream = Pipe(fd=1)
    with clean_env():
      ui.print_table(['input', 'status'], [['a.jpg', 'ok'], ['b.jpg', None]], stream=stream)
    output = stream.getvalue()
    self.assertNotIn(ESC, output)
    self.assertIn('a.jpg', output)
    self.assertIn('input', output)

  def test_markup_is_not_interpreted(self):
    stream = Pipe(fd=1)
    with clean_env():
      ui.print_table(['name'], [['[bold]x[/bold] :smile:']], stream=stream)
    self.assertIn('[bold]x[/bold] :smile:', stream.getvalue())

  def test_rich_output_only_on_terminals(self):
    with clean_env():
      self.assertTrue(ui.rich_output(Terminal(fd=1)))
      self.assertFalse(ui.rich_output(Pipe(fd=1)))
    with clean_env(CI='true'):
      self.assertFalse(ui.rich_output(Pipe(fd=1)))


class TestCli(unittest.TestCase):
  """Error messages of `qa`, as people see them"""
  qa = Path(sys.executable).parent / 'qa'

  def run_qa(self, *args, cwd, **env):
    if not self.qa.exists():
      self.skipTest('needs the qa executable')
    environ = {k: v for k, v in os.environ.items() if k not in COLOR_VARIABLES and not k.startswith('QA')}
    return subprocess.run([str(self.qa), *args], cwd=cwd, capture_output=True, encoding='utf-8',
                          env={**environ, 'QA_NO_CHECK_FOR_UPDATES': '1', 'QABOARD_IGNORE_SITE': '1', **env})

  def test_invalid_yaml(self):
    with tempfile.TemporaryDirectory() as tmp:
      (Path(tmp) / 'qaboard.yaml').write_text("project:\n  name: [\n")
      out = self.run_qa('get', 'commit_id', cwd=tmp)
    self.assertEqual(out.returncode, 1)
    self.assertNotIn('Traceback', out.stderr)
    self.assertNotIn(ESC, out.stderr)
    self.assertRegex(out.stderr, r"^error: .*qaboard.yaml is not valid YAML: .* \(line 3, column 1\)\nhint: Fix the YAML syntax")

  def test_invalid_yaml_in_ci_is_colored(self):
    with tempfile.TemporaryDirectory() as tmp:
      (Path(tmp) / 'qaboard.yaml').write_text("project:\n  name: [\n")
      out = self.run_qa('get', 'commit_id', cwd=tmp, CI='true')
      out_no_color = self.run_qa('get', 'commit_id', cwd=tmp, CI='true', NO_COLOR='1')
    self.assertEqual(out.returncode, 1)
    self.assertIn(ESC, out.stderr)
    self.assertNotIn(ESC, out_no_color.stderr)
    self.assertEqual(click.unstyle(out.stderr), out_no_color.stderr)

  def test_no_qaboard_yaml(self):
    with tempfile.TemporaryDirectory() as tmp:
      out = self.run_qa('batch', 'my-batch', cwd=tmp)
    self.assertEqual(out.returncode, 1)
    self.assertEqual(out.stdout, '')
    lines = out.stderr.splitlines()
    self.assertTrue(lines[0].startswith('error: No qaboard.yaml in '), out.stderr)
    self.assertEqual(lines[1], 'hint: Run `qa` in your project, or `qa init` to start a new one.')
    self.assertEqual(len(lines), 2, out.stderr)

  def project(self, tmp):
    root = Path(tmp)
    (root / 'qaboard.yaml').write_text("project:\n  name: group/repo\n  url: https://example.com/group/repo\n  entrypoint: main.py\n"
                                       "inputs:\n  database: .\n  batches: batches.yaml\n")
    (root / 'main.py').write_text("def run(context):\n  return {'is_failed': context.input_path.name == 'b', 'loss': 1}\n")
    (root / 'batches.yaml').write_text("images:\n  inputs:\n    - a\n    - b\n")
    (root / 'a').mkdir()
    (root / 'b').mkdir()
    return root

  def batch(self, *args, cwd):
    # the runs are started with `qa`: this one
    return self.run_qa('--offline', 'batch', *args, cwd=cwd, PATH=f"{Path(sys.executable).parent}{os.pathsep}{os.environ.get('PATH', '')}")

  def test_batch_summary(self):
    with tempfile.TemporaryDirectory() as tmp:
      root = self.project(tmp)
      out = self.batch('images', cwd=root)
      self.assertEqual(out.returncode, 1, out.stderr)
      self.assertIn('error: Failed run of b. Its log: ', out.stderr)
      self.assertEqual(out.stderr.strip().splitlines()[-1], 'error: 1 of 2 runs failed')
      (root / 'main.py').write_text("def run(context):\n  return {'is_failed': False}\n")
      out = self.batch('images', cwd=root)
      self.assertEqual(out.returncode, 0, out.stderr)
      self.assertEqual(out.stderr.strip().splitlines()[-1], '2 runs passed')

  def test_unknown_batch(self):
    with tempfile.TemporaryDirectory() as tmp:
      out = self.batch('imagez', cwd=self.project(tmp))
    # as before: a warning, not an error
    self.assertEqual(out.returncode, 0, out.stderr)
    self.assertIn('warning: No inputs found for the batch "imagez"', out.stderr)
    self.assertIn('hint: "imagez" is not a batch of batches.yaml: did you mean images? Batches: images', out.stderr)

  def test_invalid_tuning(self):
    with tempfile.TemporaryDirectory() as tmp:
      (Path(tmp) / 'qaboard.yaml').write_text("project:\n  name: group/repo\n  url: https://example.com/group/repo\n  entrypoint: main.py\n")
      out = self.run_qa('--offline', '--tuning', '{x', 'get', 'commit_id', cwd=tmp)
    self.assertEqual(out.returncode, 1)
    self.assertNotIn('Traceback', out.stderr)
    self.assertIn("error: --tuning '{x' is not valid JSON: ", out.stderr)
    self.assertIn("hint: Give a JSON object", out.stderr)


if __name__ == '__main__':
  unittest.main()
