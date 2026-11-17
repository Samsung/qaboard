"""
qa reads and writes its text files as UTF-8, whatever the locale's encoding: on Windows it is often cp1252 or, in
Korea, Japan or China, cp949/cp932/cp936, where UTF-8 files with non-ASCII characters fail to read or are garbled.

The tests run Python in a subprocess with an ASCII locale, where reading or writing anything non-ASCII with the
locale's encoding fails.
"""
import json
import os
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path


def run_with_ascii_locale(code: str, cwd, **environ) -> subprocess.CompletedProcess:
  env = {k: v for k, v in os.environ.items() if not k.startswith(('LC_', 'QA_', 'QABOARD_')) and k not in ('LANG', 'LANGUAGE', 'CI', 'GITHUB_ACTIONS')}
  env.update({
    # without UTF-8 mode and locale coercion, the C locale's encoding is ASCII
    'PYTHONUTF8': '0', 'PYTHONCOERCECLOCALE': '0', 'LC_ALL': 'C', 'LANG': 'C',
    'PYTHONIOENCODING': 'utf-8',  # what we print
    'QA_NO_CHECK_FOR_UPDATES': '1', 'QA_OFFLINE': '1', 'QABOARD_SITE_CONFIG': '', 'QABOARD_IGNORE_SITE': '1',
    **environ,
  })
  return subprocess.run([sys.executable, '-c', textwrap.dedent(code)], cwd=cwd, env=env, capture_output=True, encoding='utf-8', timeout=60)


@unittest.skipIf(os.name == 'nt', 'the C locale is a POSIX locale')
class TestNonUtf8Locale(unittest.TestCase):
  def setUp(self):
    tmp = tempfile.TemporaryDirectory()
    self.addCleanup(tmp.cleanup)
    self.dir = Path(tmp.name)

  def check(self, code, **environ):
    process = run_with_ascii_locale(code, self.dir, **environ)
    self.assertEqual(process.returncode, 0, process.stderr)
    return process.stdout

  def test_the_locale_is_ascii(self):
    self.assertEqual(self.check("import locale; print(locale.getpreferredencoding(False))").strip(), 'ANSI_X3.4-1968')

  def test_reads_the_project_configuration(self):
    (self.dir / 'qaboard.yaml').write_text(textwrap.dedent("""\
      root: true
      # Réglages du projet
      include: common.yaml
      project:
        name: équipe/projet
        url: git@github.com:equipe/projet
      inputs:
        batches: batches.yaml
      outputs:
        metrics: metrics.yaml
      storage:
        linux: {storage}
    """).format(storage=self.dir / 'storage'), encoding='utf-8')
    (self.dir / 'common.yaml').write_text("project:\n  description: Débruitage\n", encoding='utf-8')
    (self.dir / 'metrics.yaml').write_text(textwrap.dedent("""\
      available_metrics:
        latency:
          label: Latence
          suffix: µs
    """), encoding='utf-8')
    (self.dir / 'batches.yaml').write_text(textwrap.dedent("""\
      # Images de nuit 🌙
      nuit:
        inputs:
          - a.txt
    """), encoding='utf-8')
    (self.dir / 'a.txt').write_text('a')
    (self.dir / 'runs.json').write_text(json.dumps({"runs": [{"input_path": "é.txt", "database": "."}]}, ensure_ascii=False), encoding='utf-8')
    out = self.check("""
      import json
      from pathlib import Path
      from qaboard.config import config, available_metrics
      from qaboard.iterators import iter_inputs, load_runs_file, _input_line
      runs = list(iter_inputs(['nuit'], [Path('batches.yaml')], Path('.'), [], 'linux', {"type": "local"}, config))
      print(json.dumps({
        "name": config['project']['name'],
        "description": config['project']['description'],
        "suffix": available_metrics['latency']['suffix'],
        "runs": [str(run.rel_input_path) for run in runs],
        "line": _input_line('batches.yaml', 'nuit', 0),
        "runs_file": [run['input_path'] for run in load_runs_file('runs.json')],
      }))
    """)
    self.assertEqual(json.loads(out.splitlines()[-1]), {
      "name": "équipe/projet", "description": "Débruitage", "suffix": "µs", "runs": ["a.txt"], "line": 4, "runs_file": ["é.txt"],
    })

  def test_reads_the_github_event(self):
    """In pull request workflows, qa saves results for the pull request's head, read from GitHub's event file"""
    event = self.dir / 'event.json'
    event.write_text(json.dumps({'pull_request': {'title': 'Débruitage 🌙', 'head': {'sha': 'abc123'}}}, ensure_ascii=False), encoding='utf-8')
    (self.dir / 'qaboard.yaml').write_text(f"project:\n  name: p\n  url: git@github.com:o/p\nstorage:\n  linux: {self.dir / 'storage'}\n")
    out = self.check("from qaboard.config import github_pull_request_head; print(github_pull_request_head())",
                     GITHUB_EVENT_NAME='pull_request', GITHUB_EVENT_PATH=str(event))
    self.assertEqual(out.strip().splitlines()[-1], 'abc123')

  def test_reads_branch_names(self):
    env = {**os.environ, 'GIT_AUTHOR_NAME': 'test', 'GIT_AUTHOR_EMAIL': 'test@example.com', 'GIT_COMMITTER_NAME': 'test', 'GIT_COMMITTER_EMAIL': 'test@example.com'}
    git = lambda *args: subprocess.run(['git', *args], cwd=self.dir, env=env, check=True, capture_output=True, encoding='utf-8').stdout.strip()  # noqa: E731
    git('init', '-q', '-b', 'débruitage')
    git('-c', 'commit.gpgsign=false', 'commit', '-q', '--allow-empty', '-m', 'first commit')
    git('pack-refs', '--all')  # .git/HEAD and .git/packed-refs have the branch's name
    sha = git('rev-parse', 'HEAD')
    out = self.check(f"from pathlib import Path; from qaboard.git import git_head; print(git_head(Path({str(self.dir)!r})))")
    self.assertEqual(out.strip().splitlines()[-1], str(('débruitage', sha)))
