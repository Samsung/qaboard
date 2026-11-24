"""
Tests for qaboard/local_changes.py: what local runs record of how their code differs from their commit.
"""
import ast
import os
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from qaboard import local_changes as lc


def git(*args, cwd):
  env = {
    **os.environ,
    'GIT_AUTHOR_NAME': 'test', 'GIT_AUTHOR_EMAIL': 'test@example.com',
    'GIT_COMMITTER_NAME': 'test', 'GIT_COMMITTER_EMAIL': 'test@example.com',
  }
  return subprocess.run(['git', *args], cwd=cwd, env=env, check=True, encoding='utf8', capture_output=True).stdout.strip()


class Repository(unittest.TestCase):
  def setUp(self):
    self.tmp = Path(tempfile.mkdtemp())
    self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
    self.repo = self.tmp / 'repo'
    self.repo.mkdir()
    git('init', '-q', '-b', 'main', cwd=self.repo)
    (self.repo / 'train.py').write_text("lr = 0.1\n")
    (self.repo / 'README.md').write_text("# project\n")
    git('add', '.', cwd=self.repo)
    git('commit', '-q', '-m', 'first', cwd=self.repo)
    self.head = git('rev-parse', 'HEAD', cwd=self.repo)

  def push(self):
    remote = self.tmp / 'remote.git'
    git('init', '-q', '--bare', str(remote), cwd=self.tmp)
    git('remote', 'add', 'origin', str(remote), cwd=self.repo)
    git('push', '-q', '-u', 'origin', 'main', cwd=self.repo)

  def index(self) -> bytes:
    return (self.repo / '.git' / 'index').read_bytes()


class TestCapture(Repository):
  def test_a_clean_tree(self):
    state = lc.capture(self.repo).state
    self.assertIs(state['dirty'], False)
    self.assertEqual((state['head'], state['branch'], state['files']), (self.head, 'main', []))
    self.assertNotIn('patch', state)

  def test_changed_and_new_files_are_in_the_patch(self):
    (self.repo / 'train.py').write_text("lr = 0.2\n")
    (self.repo / 'model.py').write_text("layers = 3\n")
    index = self.index()
    captured = lc.capture(self.repo)
    state = captured.state
    self.assertIs(state['dirty'], True)
    self.assertEqual(state['files'], [
      {'path': 'model.py', 'status': '?', 'added': 1, 'deleted': 0},
      {'path': 'train.py', 'status': 'M', 'added': 1, 'deleted': 1},
    ])
    self.assertEqual((state['files_total'], state['added'], state['deleted'], state['untracked']), (2, 2, 1, 1))
    patch = captured.patch.decode()
    self.assertIn('+lr = 0.2', patch)
    self.assertIn('+++ b/model.py', patch)
    self.assertEqual(state['patch'], {'path': lc.PATCH_FILE, 'bytes': len(captured.patch)})
    self.assertRegex(state['sha256'], '^[0-9a-f]{64}$')
    # the user's index is untouched: model.py is still untracked
    self.assertEqual(self.index(), index)
    self.assertIn('?? model.py', git('status', '--short', cwd=self.repo))

  def test_the_patch_applies_on_the_commit(self):
    (self.repo / 'train.py').write_text("lr = 0.2\n")
    (self.repo / 'model.py').write_text("layers = 3\n")
    (self.repo / 'README.md').unlink()
    captured = lc.capture(self.repo)
    clone = self.tmp / 'clone'
    git('clone', '-q', str(self.repo), str(clone), cwd=self.tmp)
    (self.tmp / 'p.patch').write_bytes(captured.patch)
    git('apply', str(self.tmp / 'p.patch'), cwd=clone)
    self.assertEqual((clone / 'train.py').read_text(), "lr = 0.2\n")
    self.assertEqual((clone / 'model.py').read_text(), "layers = 3\n")
    self.assertFalse((clone / 'README.md').exists())

  def test_new_files_change_the_hash(self):
    (self.repo / 'a.py').write_text("a\n")
    first = lc.capture(self.repo).state['sha256']
    (self.repo / 'a.py').write_text("b\n")
    self.assertNotEqual(lc.capture(self.repo).state['sha256'], first)

  def test_the_same_changes_have_the_same_hash(self):
    (self.repo / 'train.py').write_text("lr = 0.2\n")
    self.assertEqual(lc.capture(self.repo).state['sha256'], lc.capture(self.repo).state['sha256'])

  def test_the_users_git_configuration_doesnt_change_the_patch(self):
    (self.repo / 'train.py').write_text("lr = 0.2\n")
    expected = lc.capture(self.repo).patch
    git('config', 'diff.noprefix', 'true', cwd=self.repo)
    git('config', 'color.diff', 'always', cwd=self.repo)
    git('config', 'diff.external', 'false', cwd=self.repo)
    self.assertEqual(lc.capture(self.repo).patch, expected)

  def test_no_textconv_runs(self):
    marker = self.tmp / 'ran'
    git('config', 'diff.evil.textconv', f'touch {marker}; cat', cwd=self.repo)
    (self.repo / '.gitattributes').write_text("*.py diff=evil\n")
    git('add', '.gitattributes', cwd=self.repo)
    git('commit', '-q', '-m', 'attributes', cwd=self.repo)
    (self.repo / 'train.py').write_text("lr = 0.2\n")
    lc.capture(self.repo)
    self.assertFalse(marker.exists())

  def test_untracked_secrets_are_left_out(self):
    (self.repo / '.env').write_text("TOKEN=hunter2\n")
    (self.repo / 'deploy.pem').write_text("-----BEGIN-----\n")
    captured = lc.capture(self.repo)
    self.assertIs(captured.state['dirty'], False)
    self.assertEqual(captured.state['excluded'], ['.env', 'deploy.pem'])
    self.assertIsNone(captured.patch)

  def test_edits_right_after_the_index_was_written(self):
    # git trusts the index's stat data unless the file is as recent as the index ("racy git"): the copy keeps its time
    (self.repo / 'train.py').write_text("lr = 0.2\n")
    git('add', 'train.py', cwd=self.repo)
    git('commit', '-q', '-m', 'second', cwd=self.repo)
    (self.repo / 'train.py').write_text("lr = 0.3\n")
    captured = lc.capture(self.repo)
    self.assertIn(b'+lr = 0.3', captured.patch)
    self.assertEqual(captured.state['files'], [{'path': 'train.py', 'status': 'M', 'added': 1, 'deleted': 1}])

  def test_nothing_is_written_in_the_repository(self):
    git('config', 'core.splitIndex', 'true', cwd=self.repo)
    git('update-index', '--split-index', cwd=self.repo)
    (self.repo / 'model.py').write_text("layers = 3\n")
    before = sorted(p.name for p in (self.repo / '.git').iterdir())
    lc.capture(self.repo)
    self.assertEqual(sorted(p.name for p in (self.repo / '.git').iterdir()), before)

  def test_what_looks_like_a_secret(self):
    for path in ('.env', 'deploy/prod.env', 'id_rsa', 'my_api_token.txt', '.aws/config', 'secrets/db.yaml', 'infra/main.tfvars'):
      self.assertTrue(lc._looks_secret(path), path)
    for path in ('tokenizer.py', 'auth/password_policy.cpp', 'README.md', 'train.py', 'notes/secret_sauce.md'):
      self.assertFalse(lc._looks_secret(path), path)

  def test_what_git_ignores_isnt_a_change(self):
    (self.repo / '.gitignore').write_text("build/\n*.log\n")
    git('add', '.gitignore', cwd=self.repo)
    git('commit', '-q', '-m', 'ignore', cwd=self.repo)
    (self.repo / 'build').mkdir()
    (self.repo / 'build' / 'model.bin').write_bytes(b'\0' * 10)
    (self.repo / 'train.log').write_text("loss 1\n")
    (self.repo / '.git' / 'info').mkdir(exist_ok=True)
    (self.repo / '.git' / 'info' / 'exclude').write_text("scratch.py\n")
    (self.repo / 'scratch.py').write_text("x = 1\n")
    captured = lc.capture(self.repo)
    self.assertIs(captured.state['dirty'], False)
    self.assertIsNone(captured.patch)
    # with a real change, the ignored files are still out of the summary and the patch
    (self.repo / 'train.py').write_text("lr = 0.2\n")
    captured = lc.capture(self.repo)
    self.assertEqual([f['path'] for f in captured.state['files']], ['train.py'])
    for name in (b'build/', b'train.log', b'scratch.py'):
      self.assertNotIn(name, captured.patch)
    # the fingerprint ignores them too: a batch's runs writing logs don't look changed
    before = lc.fingerprint(self.repo)
    (self.repo / 'train.log').write_text("loss 0.5\n")
    self.assertEqual(lc.fingerprint(self.repo), before)

  def test_excluded_tracked_files_are_out_of_the_patch(self):
    (self.repo / 'models').mkdir()
    (self.repo / 'models' / 'a.ckpt').write_text("v1\n")
    git('add', '.', cwd=self.repo)
    git('commit', '-q', '-m', 'checkpoint', cwd=self.repo)
    (self.repo / 'models' / 'a.ckpt').write_text("v2\n")
    (self.repo / 'train.py').write_text("lr = 0.2\n")
    captured = lc.capture(self.repo, lc.Settings(exclude=('*.ckpt',)))
    self.assertNotIn(b'a.ckpt', captured.patch)
    self.assertEqual([f['path'] for f in captured.state['files']], ['train.py'])
    self.assertEqual(captured.state['excluded'], ['models/a.ckpt'])

  def test_renamed_files_are_added_and_deleted(self):
    git('mv', 'train.py', 'fit.py', cwd=self.repo)
    files = {f['path']: f['status'] for f in lc.capture(self.repo).state['files']}
    self.assertEqual(files, {'fit.py': 'A', 'train.py': 'D'})

  def test_staged_then_reverted_is_not_a_change(self):
    (self.repo / 'train.py').write_text("lr = 0.2\n")
    git('add', 'train.py', cwd=self.repo)
    (self.repo / 'train.py').write_text("lr = 0.1\n")
    state = lc.capture(self.repo).state
    self.assertIs(state['dirty'], False)
    self.assertNotIn('patch', state)

  def test_a_local_upstream_isnt_pushed(self):
    git('checkout', '-q', '-b', 'feature', '--track', 'main', cwd=self.repo)
    (self.repo / 'train.py').write_text("lr = 0.3\n")
    git('commit', '-q', '-am', 'local', cwd=self.repo)
    self.assertNotIn('pushed', lc.capture(self.repo).state)

  def test_excluded_globs(self):
    (self.repo / 'data').mkdir()
    (self.repo / 'data' / 'big.csv').write_text("1,2\n")
    (self.repo / 'train.py').write_text("lr = 0.2\n")
    captured = lc.capture(self.repo, lc.Settings(exclude=('data/**',)))
    self.assertNotIn(b'big.csv', captured.patch)
    self.assertEqual(captured.state['excluded'], ['data/big.csv'])

  def test_ignored_folders_like_the_runs_outputs(self):
    (self.repo / 'output' / 'run').mkdir(parents=True)
    (self.repo / 'output' / 'run' / 'metrics.json').write_text("{}")
    self.assertIs(lc.capture(self.repo, ignore=['output']).state['dirty'], False)
    self.assertIs(lc.capture(self.repo).state['dirty'], True)

  def test_too_large_patches_are_hashed_not_kept(self):
    (self.repo / 'train.py').write_text("x = 1\n" * 2000)
    captured = lc.capture(self.repo, lc.Settings(max_patch_bytes=1000))
    self.assertIsNone(captured.patch)
    self.assertEqual(captured.state['patch']['omitted'], 'too_large')
    self.assertGreater(captured.state['patch']['bytes'], 1000)
    self.assertRegex(captured.state['sha256'], '^[0-9a-f]{64}$')

  def test_summary_keeps_no_code(self):
    (self.repo / 'train.py').write_text("lr = 0.2\n")
    captured = lc.capture(self.repo, lc.Settings(level='summary'))
    self.assertIsNone(captured.patch)
    self.assertNotIn('patch', captured.state)
    self.assertEqual(captured.state['files'][0]['path'], 'train.py')
    self.assertIn('sha256', captured.state)

  def test_off(self):
    self.assertIsNone(lc.capture(self.repo, lc.Settings(level='off')))

  def test_binary_files(self):
    (self.repo / 'weights.bin').write_bytes(b'\0\1\2')
    state = lc.capture(self.repo).state
    self.assertEqual(state['files'], [{'path': 'weights.bin', 'status': '?', 'added': None, 'deleted': None, 'binary': True}])

  def test_many_untracked_files_arent_read(self):
    (self.repo / 'build').mkdir()
    for i in range(lc.MAX_UNTRACKED_CONTENTS + 1):
      (self.repo / 'build' / f'{i}.o').write_text("x")
    captured = lc.capture(self.repo)
    self.assertEqual(captured.state['untracked_contents'], 'too_many')
    self.assertEqual(captured.state['untracked'], lc.MAX_UNTRACKED_CONTENTS + 1)

  def test_unpushed_commits(self):
    self.push()
    self.assertIs(lc.capture(self.repo).state['pushed'], True)
    (self.repo / 'train.py').write_text("lr = 0.3\n")
    git('commit', '-q', '-am', 'local', cwd=self.repo)
    captured = lc.capture(self.repo)
    state = captured.state
    self.assertEqual((state['pushed'], state['unpushed_commits'], state['base'], state['upstream']), (False, 1, self.head, 'origin/main'))
    self.assertIs(state['dirty'], False)
    self.assertIn(b'+lr = 0.3', captured.unpushed)
    self.assertEqual([c['subject'] for c in state['unpushed_log']], ['local'])
    self.assertEqual(state['unpushed']['path'], lc.UNPUSHED_FILE)

  def test_unpushed_without_upstream(self):
    self.push()
    git('checkout', '-q', '-b', 'feature', cwd=self.repo)
    (self.repo / 'train.py').write_text("lr = 0.3\n")
    git('commit', '-q', '-am', 'local', cwd=self.repo)
    state = lc.capture(self.repo).state
    self.assertEqual((state['pushed'], state['unpushed_commits'], state['base']), (False, 1, self.head))

  def test_without_remotes_we_dont_know(self):
    self.assertNotIn('pushed', lc.capture(self.repo).state)

  def test_a_repository_without_commits(self):
    empty = self.tmp / 'empty'
    empty.mkdir()
    git('init', '-q', cwd=empty)
    (empty / 'a.py').write_text("a\n")
    state = lc.capture(empty).state
    self.assertIs(state['dirty'], True)
    self.assertIsNone(state['head'])

  def test_outside_git(self):
    folder = self.tmp / 'nogit'
    folder.mkdir()
    state = lc.capture(folder).state
    self.assertIsNone(state['dirty'])
    self.assertIn('error', state)

  def test_out_of_time(self):
    (self.repo / 'train.py').write_text("lr = 0.2\n")
    state = lc.capture(self.repo, lc.Settings(timeout=1e-9)).state
    self.assertTrue(state['timed_out'])
    self.assertIsNone(state['dirty'])
    self.assertIn('unknown', lc.describe(state))


class TestSettings(unittest.TestCase):
  def test_values(self):
    self.assertEqual(lc.settings(None, environ={})[0].level, 'patch')
    self.assertEqual(lc.settings('summary', environ={})[0].level, 'summary')
    self.assertEqual(lc.settings(False, environ={})[0].level, 'off')
    s, problems = lc.settings({'level': 'summary', 'max_patch_kb': 10, 'timeout': 2, 'exclude': ['*.ckpt']}, environ={})
    self.assertEqual((s, problems), (lc.Settings('summary', 10 * 1024, 2.0, ('*.ckpt',)), []))

  def test_ci_is_off_unless_asked(self):
    self.assertEqual(lc.settings('patch', environ={}, is_ci=True)[0].level, 'off')
    self.assertEqual(lc.settings('patch', environ={'QA_LOCAL_CHANGES': 'summary'}, is_ci=True)[0].level, 'summary')

  def test_the_environment_wins(self):
    self.assertEqual(lc.settings('patch', environ={'QA_LOCAL_CHANGES': 'off'})[0].level, 'off')

  def test_problems(self):
    s, problems = lc.settings({'level': 'all', 'max_patch_kb': -1}, environ={'QA_LOCAL_CHANGES': 'everything'})
    self.assertEqual(s.level, 'patch')
    self.assertEqual(len(problems), 3)

  def test_lowest(self):
    self.assertEqual(lc.lowest('patch', 'summary'), 'summary')
    self.assertEqual(lc.lowest('summary', None), 'summary')
    self.assertEqual(lc.lowest('patch', 'off'), 'off')


class TestSaving(Repository):
  def test_at_the_servers_level(self):
    (self.repo / 'train.py').write_text("lr = 0.2\n")
    captured = lc.capture(self.repo)
    run = self.tmp / 'run'
    state = lc.save(captured, run, 'summary')
    self.assertEqual(state['patch'], {'omitted': 'level'})
    self.assertFalse((run / lc.PATCH_FILE).exists())
    state = lc.save(captured, run, 'patch')
    self.assertEqual((run / lc.PATCH_FILE).read_bytes(), captured.patch)
    self.assertEqual(state['patch']['path'], lc.PATCH_FILE)
    self.assertEqual(lc.save(captured, run, 'off'), {})

  def test_batches_share_one_capture(self):
    (self.repo / 'train.py').write_text("lr = 0.2\n")
    captured = lc.capture(self.repo)
    cache = self.tmp / 'cache'
    old = os.environ.get('XDG_CACHE_HOME')
    os.environ['XDG_CACHE_HOME'] = str(cache)
    try:
      path = lc.share(captured)
    finally:
      if old is None:
        del os.environ['XDG_CACHE_HOME']
      else:
        os.environ['XDG_CACHE_HOME'] = old
    self.assertEqual(path.stat().st_mode & 0o777, 0o600)
    environ = {lc.ENV_STATE: str(path)}
    run = lc.ForRun('patch', repo_root=self.repo, is_ci=False, commit=self.head, environ=environ)
    self.assertEqual(run.capture.state['scope'], 'batch')
    self.assertEqual(run.capture.patch, captured.patch)
    # what's sent before the server answers has no patch
    self.assertNotIn('patch', run.data()['local_changes'])
    run.save(self.tmp / 'run', server_level=None)
    self.assertEqual((self.tmp / 'run' / lc.PATCH_FILE).read_bytes(), captured.patch)
    self.assertIs(run.data()['dirty'], True)
    # runs that can't read the patch keep the summary
    for patch in cache.rglob('*.patch'):
      patch.unlink()
    run = lc.ForRun('patch', repo_root=self.repo, is_ci=False, commit=self.head, environ=environ)
    self.assertEqual(run.capture.state['patch']['omitted'], 'unreadable')

  def test_runs_of_a_batch_see_when_the_code_changed(self):
    (self.repo / 'train.py').write_text("lr = 0.2\n")
    captured = lc.capture(self.repo)
    old = os.environ.get('XDG_CACHE_HOME')
    os.environ['XDG_CACHE_HOME'] = str(self.tmp / 'cache')
    try:
      path = lc.share(captured)
    finally:
      if old is None:
        del os.environ['XDG_CACHE_HOME']
      else:
        os.environ['XDG_CACHE_HOME'] = old
    environ = {lc.ENV_STATE: str(path)}
    same = lc.ForRun('patch', repo_root=self.repo, is_ci=False, commit=self.head, environ=environ)
    self.assertEqual((same.capture.state['scope'], same.changed_since_batch), ('batch', False))
    # edited while the batch runs: the run records what it ran
    (self.repo / 'train.py').write_text("lr = 0.9\n")
    changed = lc.ForRun('patch', repo_root=self.repo, is_ci=False, commit=self.head, environ=environ)
    self.assertTrue(changed.changed_since_batch)
    self.assertEqual(changed.capture.state['scope'], 'run')
    self.assertIn(b'+lr = 0.9', changed.capture.patch)
    self.assertIn('the code changed since the batch started', lc.describe(changed.capture.state))

  def test_without_the_servers_answer_no_patch_is_saved(self):
    (self.repo / 'train.py').write_text("lr = 0.2\n")
    run = lc.ForRun('patch', repo_root=self.repo, is_ci=False, commit=self.head, environ={})
    state = run.save(self.tmp / 'run', None, unanswered=True)
    self.assertEqual(state['patch'], {'omitted': 'no_answer'})
    self.assertFalse((self.tmp / 'run' / lc.PATCH_FILE).exists())

  def test_runs_of_another_commit_record_nothing(self):
    (self.repo / 'train.py').write_text("lr = 0.2\n")
    run = lc.ForRun('patch', repo_root=self.repo, is_ci=False, commit='a' * 40, environ={})
    self.assertEqual(run.data(), {})

  def test_the_server_allows_less(self):
    (self.repo / 'train.py').write_text("lr = 0.2\n")
    run = lc.ForRun('patch', repo_root=self.repo, is_ci=False, commit=self.head, environ={})
    state = run.save(self.tmp / 'run', server_level='summary')
    self.assertEqual(state['level'], 'summary')
    self.assertFalse((self.tmp / 'run' / lc.PATCH_FILE).exists())

  def test_describe(self):
    self.assertEqual(lc.describe({'dirty': False}), "none, the code is the commit's")
    self.assertEqual(lc.describe({'dirty': True, 'files_total': 3, 'added': 40, 'deleted': 12, 'files': [{'status': '?'}], 'patch': {'path': 'x'}}),
                     '3 files (1 new), +40 -12, saved with the run')
    self.assertEqual(lc.describe({'dirty': False, 'pushed': False, 'unpushed_commits': 2, 'unpushed': {'path': 'x'}}, batch=True),
                     "none, the code is the commit's; 2 commits not pushed, saved with each run")
    self.assertIn('too large to save', lc.describe({'dirty': True, 'files_total': 1, 'patch': {'omitted': 'too_large', 'bytes': 10}}))
    self.assertIn('the server keeps no code', lc.describe({'dirty': True, 'files_total': 1, 'level': 'summary', 'patch': {'omitted': 'level'}}))
    self.assertEqual(lc.describe({'dirty': True, 'timed_out': True}), "the code differs from the commit, but git took too long to say how")
    self.assertIn('without their contents', lc.describe({'dirty': True, 'files_total': 300, 'untracked': 300, 'untracked_contents': 'too_many', 'patch': {'path': 'x'}}))


class TestIsolation(unittest.TestCase):
  """local_changes.py needs only the standard library"""
  def test_imports_only_the_standard_library(self):
    path = Path(__file__).resolve().parent.parent / 'qaboard' / 'local_changes.py'
    for node in ast.walk(ast.parse(path.read_text())):
      if isinstance(node, ast.ImportFrom):
        self.assertEqual(node.level, 0, f'local_changes.py imports from qaboard: {node.module}')
        names = [node.module or '']
      elif isinstance(node, ast.Import):
        names = [alias.name for alias in node.names]
      else:
        continue
      for name in names:
        self.assertIn(name.split('.')[0], sys.stdlib_module_names, f'local_changes.py imports {name}')



class TestQa(unittest.TestCase):
  """`qa run` and `qa batch` save the local changes in their runs' folders"""
  def setUp(self):
    self.tmp = Path(tempfile.mkdtemp())
    self.addCleanup(shutil.rmtree, self.tmp, ignore_errors=True)
    self.project = self.tmp / 'project'
    self.project.mkdir()
    (self.project / 'qaboard.yaml').write_text('project:\n  name: e2e/minimal\n  entrypoint: main.py\ninputs:\n  database: {linux: ., windows: .}\n')
    (self.project / 'main.py').write_text('def run(context):\n  return {"loss": 1}\n')
    (self.project / 'a.txt').write_text('a\n')
    (self.project / 'b.txt').write_text('b\n')
    (self.project / 'batches.yaml').write_text('both:\n  inputs: [a.txt, b.txt]\n')
    git('init', '-q', cwd=self.project)
    git('add', '.', cwd=self.project)
    git('commit', '-q', '-m', 'first', cwd=self.project)
    (self.project / 'main.py').write_text('def run(context):\n  return {"loss": 2}\n')

  def qa(self, *args, **env):
    environ = {k: v for k, v in os.environ.items() if not k.startswith(('QA_', 'QABOARD_', 'CI', 'GITHUB_', 'GITLAB_'))}
    environ.update({'QA_OFFLINE': '1', 'QA_TESTING': '1', 'QABOARD_IGNORE_SITE': '1', 'XDG_CACHE_HOME': str(self.tmp / 'cache'), **env})
    out = subprocess.run([sys.executable, '-m', 'qaboard', *args], cwd=self.project, env=environ,
                         stdout=subprocess.PIPE, stderr=subprocess.STDOUT, encoding='utf-8', timeout=120)
    self.assertEqual(out.returncode, 0, out.stdout)
    return out.stdout

  def patches(self):
    return sorted((self.project / 'output').rglob('local-changes.patch'))

  def test_qa_run(self):
    out = self.qa('run', '--input', 'a.txt')
    self.assertIn('Local changes: 1 file, +1 -1, saved in output/linux/a/.qaboard/local-changes.patch', out)
    patch, = self.patches()
    self.assertIn('+  return {"loss": 2}', patch.read_text())
    # the runs' own outputs aren't changes, and the patch isn't an output
    self.assertNotIn('output/', patch.read_text())
    manifest = json.loads((patch.parent.parent / 'manifest.outputs.json').read_text())
    self.assertFalse(any(name.startswith('.qaboard') for name in manifest))

  def test_qa_batch_captures_once(self):
    out = self.qa('batch', '--batches-file', 'batches.yaml', 'both', '--runner', 'local')
    # said once: the runs say nothing more when the code didn't change
    self.assertEqual(out.count('Local changes:'), 1, out)
    self.assertIn('Local changes: 1 file, +1 -1, saved with each run', out)
    patches = self.patches()
    self.assertEqual(len(patches), 2)
    self.assertEqual(patches[0].read_bytes(), patches[1].read_bytes())

  def test_in_ci_nothing(self):
    out = self.qa('run', '--input', 'a.txt', CI='true')
    self.assertNotIn('Local changes', out)
    self.assertEqual(self.patches(), [])


if __name__ == '__main__':
  unittest.main()
