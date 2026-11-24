"""`qa completion` and what qa's options complete with (qaboard/completion.py)"""
import os
import sys
import json
import tempfile
import subprocess
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parent.parent
SAMPLE_PROJECT = ROOT / 'qaboard' / 'sample_project'


def qa(*args, env=None, cwd=SAMPLE_PROJECT):
  return subprocess.run(
    [sys.executable, '-m', 'qaboard', *args],
    cwd=str(cwd), capture_output=True, text=True,
    env={**os.environ, 'PYTHONPATH': str(ROOT), 'QA_NO_CHECK_FOR_UPDATES': '1', **(env or {})},
  )


def complete(line: str, cwd=SAMPLE_PROJECT, shell='bash'):
  """The candidates for the line, with the cursor at its end"""
  words = line.split(' ')
  if shell == 'powershell':
    env = {'_QA_COMPLETE': 'powershell_complete', 'COMP_WORDS': line, 'COMP_INCOMPLETE': words[-1]}
  elif shell == 'fish':
    # fish gives the incomplete word
    env = {'_QA_COMPLETE': 'fish_complete', 'COMP_WORDS': line, 'COMP_CWORD': words[-1]}
  else:
    env = {'_QA_COMPLETE': f'{shell}_complete', 'COMP_WORDS': line, 'COMP_CWORD': str(len(words) - 1)}
  p = qa(env=env, cwd=cwd)
  assert p.returncode == 0, p.stderr
  # nothing else: the shells would show it
  assert p.stderr == '', p.stderr
  if shell == 'powershell':
    return [l for l in p.stdout.splitlines() if l]
  return [l.split(',', 1)[1] for l in p.stdout.splitlines() if ',' in l]


class TestCandidates(unittest.TestCase):
  def test_commands(self):
    self.assertEqual(complete('qa ba'), ['batch'])
    self.assertIn('install', complete('qa completion '))

  def test_batches(self):
    self.assertIn('ci', complete('qa batch '))
    self.assertEqual(complete('qa batch c'), ['ci'])
    self.assertEqual(complete('qa batch --batch c'), ['ci'])
    self.assertEqual(complete('qa optimize --batch c'), ['ci'])

  def test_batches_from_batches_file(self):
    with tempfile.TemporaryDirectory() as d:
      path = Path(d) / 'b.yaml'
      path.write_text('other-batch:\n  inputs: [a]\naliases:\n  everything: [other-batch]\ndatabase: /\n')
      self.assertEqual(complete(f'qa batch --batches-file {path} '), ['other-batch', 'everything'])

  def test_choices(self):
    self.assertEqual(complete('qa batch --runner l'), ['local', 'lsf'])
    self.assertEqual(complete('qa doctor --runner k'), ['kubernetes'])
    self.assertEqual(complete('qa batch --action-on-existing s'), ['sync', 'skip'])
    self.assertEqual(complete('qa batch --action-on-pending w'), ['wait'])
    self.assertIn('linux', complete('qa --platform '))
    self.assertEqual(complete('qa --type '), ['default'])

  def test_inputs(self):
    with tempfile.TemporaryDirectory() as d:
      (Path(d) / 'images').mkdir()
      (Path(d) / 'images' / 'a.jpg').write_text('')
      (Path(d) / 'images' / 'b.jpg').write_text('')
      (Path(d) / '.hidden').write_text('')
      self.assertEqual(complete(f'qa --database {d} run -i '), ['images/'])
      self.assertEqual(complete(f'qa --database {d} run -i images/'), ['images/a.jpg', 'images/b.jpg'])
      self.assertEqual(complete(f'qa --database {d} run --input images/b'), ['images/b.jpg'])

  def test_paths_are_left_to_the_shell(self):
    p = qa(env={'_QA_COMPLETE': 'bash_complete', 'COMP_WORDS': 'qa batch --runs-file ru', 'COMP_CWORD': '3'})
    self.assertEqual(p.stdout.strip(), 'file,ru')

  def test_shells(self):
    self.assertEqual(complete('qa batch --runner l', shell='zsh'), [])  # zsh's format: value, help, on lines
    p = qa(env={'_QA_COMPLETE': 'zsh_complete', 'COMP_WORDS': 'qa batch --runner l', 'COMP_CWORD': '3'})
    self.assertIn('local', p.stdout.splitlines())
    self.assertEqual(complete('qa batch --runner l', shell='fish'), ['local', 'lsf'])
    self.assertEqual(complete('qa batch --runner l', shell='powershell'), ['local', 'lsf'])
    self.assertEqual(complete('qa batch --runner ', shell='powershell'), ['local', 'lsf', 'celery', 'dask', 'windows', 'kubernetes'])

  def test_outside_a_project(self):
    with tempfile.TemporaryDirectory() as d:
      self.assertEqual(complete('qa batch ', cwd=d), [])
      self.assertEqual(complete('qa ver', cwd=d), ['version'])

  def test_runners(self):
    from qaboard.completion import RUNNERS
    from qaboard.runners import runners
    self.assertEqual(set(RUNNERS), set(runners))


class TestPowerShell(unittest.TestCase):
  def args(self, words, incomplete):
    from qaboard.completion import PowerShellComplete
    with mock.patch.dict(os.environ, {'COMP_WORDS': words, 'COMP_INCOMPLETE': incomplete}):
      return PowerShellComplete(None, {}, 'qa', '_QA_COMPLETE').get_completion_args()

  def test_args(self):
    self.assertEqual(self.args('qa batch my', 'my'), (['batch'], 'my'))
    self.assertEqual(self.args('qa batch ', ''), (['batch'], ''))
    self.assertEqual(self.args('qa --label "a b" batch m', 'm'), (['--label', 'a b', 'batch'], 'm'))

  def test_script(self):
    p = qa('completion', 'powershell')
    self.assertEqual(p.returncode, 0, p.stderr)
    self.assertIn('Register-ArgumentCompleter -Native -CommandName qa', p.stdout)
    self.assertIn("$env:_QA_COMPLETE = 'powershell_complete'", p.stdout)


class TestCompletionCommand(unittest.TestCase):
  def test_scripts(self):
    for shell, expected in (('bash', '_QA_COMPLETE=bash_complete'), ('zsh', '#compdef qa'), ('fish', 'fish_complete')):
      with self.subTest(shell=shell):
        p = qa('completion', shell)
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertIn(expected, p.stdout)

  def test_install(self):
    with tempfile.TemporaryDirectory() as home:
      env = {'HOME': home, 'XDG_CONFIG_HOME': str(Path(home) / '.config'), 'SHELL': '/bin/bash'}
      p = qa('completion', 'install', '--json', env=env)
      self.assertEqual(p.returncode, 0, p.stderr)
      installed = json.loads(p.stdout)
      self.assertEqual(installed['shell'], 'bash')
      self.assertTrue(installed['startup_file_changed'])
      self.assertIn('_QA_COMPLETE=bash_complete', Path(installed['script']).read_text())
      bashrc = Path(home) / '.bashrc'
      self.assertIn(installed['script'], bashrc.read_text())
      # again: only the script is written
      again = json.loads(qa('completion', 'install', '--json', env=env).stdout)
      self.assertFalse(again['startup_file_changed'])
      from qaboard.completion import MARKER
      self.assertEqual(bashrc.read_text().count(MARKER), 1)

      zsh = json.loads(qa('completion', 'install', 'zsh', '--json', env=env).stdout)
      self.assertEqual(zsh['startup_file'], str(Path(home) / '.zshrc'))
      self.assertIn('compinit', Path(zsh['startup_file']).read_text())

      fish = json.loads(qa('completion', 'install', 'fish', '--json', env=env).stdout)
      self.assertEqual(fish['script'], str(Path(home) / '.config' / 'fish' / 'completions' / 'qa.fish'))
      self.assertIsNone(fish['startup_file'])

  def test_startup_lines_quote_the_path(self):
    from qaboard.completion import startup_lines
    # e.g. XDG_CONFIG_HOME="/tmp/x'; touch pwned; '": the startup file must not run it
    script = Path("/home/o'; touch pwned; '$(id)/qaboard/completion/qa.bash")
    with tempfile.TemporaryDirectory() as tmp:
      for shell in ('bash', 'zsh'):
        with self.subTest(shell=shell):
          line = startup_lines(shell, script).splitlines()[-1]
          p = subprocess.run(['sh', '-c', line + '\necho done'], cwd=tmp, capture_output=True, text=True)
          self.assertEqual(p.stdout, 'done\n', p.stderr)
          self.assertEqual(os.listdir(tmp), [])
    self.assertEqual(startup_lines('powershell', Path("C:/Users/o'$(x)/qa.ps1")), ". 'C:/Users/o''$(x)/qa.ps1'")

  def test_install_says_what_it_did(self):
    with tempfile.TemporaryDirectory() as home:
      p = qa('completion', 'install', 'bash', env={'HOME': home, 'XDG_CONFIG_HOME': home})
      self.assertEqual(p.returncode, 0, p.stderr)
      self.assertEqual(p.stdout, '')
      self.assertIn('Installed completion for bash', p.stderr)

  def test_unknown_shell(self):
    with tempfile.TemporaryDirectory() as home:
      p = qa('completion', 'install', env={'HOME': home, 'SHELL': '/bin/tcsh', 'PSModulePath': ''})
      self.assertEqual(p.returncode, 2)
      self.assertIn('Could not tell your shell', p.stderr)


class TestVersion(unittest.TestCase):
  def test_version(self):
    from qaboard import __version__
    with tempfile.TemporaryDirectory() as d:
      p = qa('--version', cwd=d)
      self.assertEqual((p.returncode, p.stdout, p.stderr), (0, f'qa, version {__version__}\n', ''))
      p = qa('version', cwd=d)
      self.assertEqual((p.returncode, p.stdout), (0, f'qa, version {__version__}\n'))
      p = qa('version', '--json', cwd=d)
      info = json.loads(p.stdout)
      self.assertEqual(info['qaboard'], __version__)
      self.assertEqual(set(info), {'qaboard', 'python', 'click', 'platform', 'executable', 'package'})


if __name__ == '__main__':
  unittest.main()
