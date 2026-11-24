"""
`qa --help`, `qa --version` and shell completion stay fast: `import qaboard.qa` doesn't import what only some
commands need (requests, the runners' clients, rich's tracebacks, scikit-learn, optuna...). qaboard/lazy.py.
"""
import os
import sys
import json
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SAMPLE_PROJECT = ROOT / 'qaboard' / 'sample_project'

# what `qa` imports only in the commands that need it
NOT_IMPORTED = (
  'requests', 'urllib3', 'qaboard.api', 'qaboard.runners', 'rich.traceback', 'rich.console',
  'sklearn', 'optuna', 'numpy', 'joblib', 'psutil', 'sentry_sdk', 'simplejson',
  'celery', 'distributed', 'kubernetes',
)


def imported(code: str, argv0: str = 'qa', env=None, cwd=SAMPLE_PROJECT):
  """The modules imported by `code`, run in a new interpreter with sys.argv[0] = argv0"""
  script = f"import sys, json\nsys.argv = [{argv0!r}, *sys.argv[1:]]\n{code}\nprint(json.dumps(sorted(sys.modules)))"
  p = subprocess.run(
    [sys.executable, '-c', script],
    cwd=str(cwd), capture_output=True, text=True,
    env={**os.environ, 'PYTHONPATH': str(ROOT), 'QA_NO_CHECK_FOR_UPDATES': '1', 'QA_OFFLINE': 'true', **(env or {})},
  )
  if p.returncode != 0:
    raise AssertionError(f"{p.returncode}\n{p.stdout}\n{p.stderr}")
  return set(json.loads(p.stdout.strip().splitlines()[-1]))


class TestStartup(unittest.TestCase):
  def assertNotImported(self, modules):
    heavy = sorted(m for m in NOT_IMPORTED if m in modules)
    self.assertEqual(heavy, [], "imported eagerly: make them lazy (qaboard/lazy.py, imports inside the commands)")

  def test_import_qa(self):
    self.assertNotImported(imported("import qaboard.qa"))

  def test_help(self):
    code = "from qaboard.qa import main\ntry:\n  main()\nexcept SystemExit:\n  pass"
    for args in (['--help'], ['runs', '--help'], ['batch', '--help'], ['--version']):
      with self.subTest(args=args):
        self.assertNotImported(imported(f"sys.argv += {args!r}\n{code}"))

  def test_completion(self):
    code = "from qaboard.qa import main\ntry:\n  main()\nexcept SystemExit:\n  pass"
    env = {'_QA_COMPLETE': 'bash_complete', 'COMP_WORDS': 'qa batch --runner ', 'COMP_CWORD': '3'}
    self.assertNotImported(imported(code, env=env))

  def test_excepthook_shows_rich_tracebacks(self):
    p = subprocess.run(
      [sys.executable, '-c', "import qaboard.qa\nraise ValueError('boom')"],
      cwd=str(SAMPLE_PROJECT), capture_output=True, text=True,
      env={**os.environ, 'PYTHONPATH': str(ROOT), 'QA_NO_CHECK_FOR_UPDATES': '1', 'COLUMNS': '120'},
    )
    self.assertEqual(p.returncode, 1)
    self.assertIn('ValueError: boom', p.stderr)
    # rich's frame
    self.assertIn('Traceback (most recent call last)', p.stderr)
    self.assertIn('╭', p.stderr)


if __name__ == '__main__':
  unittest.main()
