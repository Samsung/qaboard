"""
`qa check-bit-accuracy` finds runs from their context (input, configurations, platform, tuning) instead of guessing paths:
QA-Board knows where they are, otherwise we follow the storage conventions, where {user} can be any user.
The CLI is tested in test_cli.py
"""
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


from qaboard import bit_accuracy
from qaboard.bit_accuracy import CommitRuns, USER_WILDCARD, glob_user, is_bit_accurate, matching_run
from qaboard.api import dir_to_url
from qaboard.conventions import make_batch_conf_dir, output_dirs_for_input_part, run_dir_in_commit
from qaboard.run import RunContext


def run_context(input='dir/a.jpg', database='/db', platform='linux', configurations=('base',), extra_parameters=None):
  return RunContext(
    type='default',
    input_path=Path(database) / input,
    database=Path(database),
    platform=platform,
    configurations=list(configurations),
    extra_parameters=extra_parameters or {},
  )

def qaboard_run(output_dir, input='dir/a.jpg', database='/db', platform='linux', configurations=('base',), extra_parameters=None):
  return {
    'test_input_path': input,
    'test_input_database': database,
    'platform': platform,
    'configurations': list(configurations),
    'extra_parameters': extra_parameters or {},
    'output_dir_url': dir_to_url(Path(output_dir)),
  }

def write_manifests(output_dir, files, inputs=None):
  output_dir.mkdir(parents=True, exist_ok=True)
  (output_dir / 'manifest.outputs.json').write_text(json.dumps({f: {'md5': md5} for f, md5 in files.items()}))
  (output_dir / 'manifest.inputs.json').write_text(json.dumps(inputs or {'input.jpg': {'md5': 'input'}}))


class TestGlobUser(unittest.TestCase):
  def test_without_user(self):
    with tempfile.TemporaryDirectory() as tmp:
      self.assertEqual(glob_user(Path(tmp)), [Path(tmp)])
      self.assertEqual(glob_user(Path(tmp) / 'missing'), [])

  def test_any_user(self):
    with tempfile.TemporaryDirectory() as tmp:
      for user in ['alice', 'bob', 'carol']:
        (Path(tmp) / f'{user}_outputs' / 'project').mkdir(parents=True)
      (Path(tmp) / 'dave_outputs').mkdir() # without the project
      found = glob_user(Path(tmp) / f'{USER_WILDCARD}_outputs' / 'project')
      self.assertEqual(found, [Path(tmp) / f'{user}_outputs' / 'project' for user in ['alice', 'bob', 'carol']])

  def test_the_rest_of_the_path_is_not_a_pattern(self):
    with tempfile.TemporaryDirectory() as tmp:
      (Path(tmp) / '[x]' / 'alice').mkdir(parents=True)
      (Path(tmp) / 'x' / 'bob').mkdir(parents=True)
      self.assertEqual(glob_user(Path(tmp) / '[x]' / USER_WILDCARD), [Path(tmp) / '[x]' / 'alice'])


class TestRunDirInCommit(unittest.TestCase):
  def test_like_qa_batch(self):
    config = {}
    run = run_context(extra_parameters={'gain': 2})
    expected = make_batch_conf_dir(Path('/commit'), 'my-label', run.platform, run.configurations, run.extra_parameters, save_with_ci=True) / \
               output_dirs_for_input_part(run.rel_input_path, run.database, config)
    self.assertEqual(Path('/commit') / run_dir_in_commit('my-label', run.platform, run.configurations, run.extra_parameters, run.rel_input_path, run.database, config), expected)

  def test_forwarded_arguments_are_not_part_of_it(self):
    run = run_context()
    self.assertEqual(
      run_dir_in_commit('default', 'linux', ['base'], {}, run.rel_input_path, run.database, {}),
      run_dir_in_commit('default', 'linux', ['base'], {'forwarded_args': ['--verbose']}, run.rel_input_path, run.database, {}),
    )

  def test_platform_configurations_and_tuning_are_part_of_it(self):
    run = run_context()
    run_dir = lambda *args: run_dir_in_commit('default', *args, run.rel_input_path, run.database, {})
    dirs = {run_dir('linux', ['base'], {}), run_dir('hw', ['base'], {}), run_dir('linux', ['other'], {}), run_dir('linux', ['base'], {'gain': 2})}
    self.assertEqual(len(dirs), 4)


class TestMatchingRun(unittest.TestCase):
  def test_matches_the_run_context(self):
    runs = [
      qaboard_run('/other-input', input='dir/b.jpg'),
      qaboard_run('/other-platform', platform='hw'),
      qaboard_run('/other-configurations', configurations=['base', 'delta']),
      qaboard_run('/other-tuning', extra_parameters={'gain': 2}),
      qaboard_run('/same', extra_parameters={'forwarded_args': ['--verbose']}),
    ]
    self.assertEqual(matching_run(run_context(), runs)['output_dir_url'], dir_to_url(Path('/same')))
    self.assertEqual(matching_run(run_context(platform='hw'), runs)['output_dir_url'], dir_to_url(Path('/other-platform')))
    self.assertIsNone(matching_run(run_context(input='dir/c.jpg'), runs))
    self.assertIsNone(matching_run(run_context(), []))

  def test_prefers_the_same_database(self):
    runs = [qaboard_run('/in-db1', database='/db1'), qaboard_run('/in-db2', database='/db2')]
    self.assertEqual(matching_run(run_context(database='/db2'), runs)['output_dir_url'], dir_to_url(Path('/in-db2')))

  def test_closest(self):
    runs = [
      qaboard_run('/other-input', input='dir/b.jpg'),
      qaboard_run('/far', configurations=['base', {'gain': 100}]),
      qaboard_run('/close', configurations=['base', {'gain': 4}]),
      qaboard_run('/close-other-platform', platform='hw', configurations=['base', {'gain': 4}]),
    ]
    run = run_context(configurations=['base', {'gain': 3}])
    self.assertIsNone(matching_run(run, runs))
    self.assertEqual(matching_run(run, runs, 'closest')['output_dir_url'], dir_to_url(Path('/close')))
    self.assertEqual(matching_run(run_context(platform='hw', configurations=['base', {'gain': 3}]), runs, 'closest')['output_dir_url'], dir_to_url(Path('/close-other-platform')))
    # the same run when there is one
    same = qaboard_run('/same', configurations=['base', {'gain': 3}], extra_parameters={'forwarded_args': ['-v']})
    self.assertEqual(matching_run(run, [*runs, same], 'closest')['output_dir_url'], dir_to_url(Path('/same')))
    self.assertIsNone(matching_run(run_context(input='dir/c.jpg'), runs, 'closest'))


class TestCommitRuns(unittest.TestCase):
  def setUp(self):
    tmp = tempfile.TemporaryDirectory()
    self.addCleanup(tmp.cleanup)
    self.tmp = Path(tmp.name)
    self.run = run_context()
    self.run_dir = run_dir_in_commit('default', 'linux', ['base'], {}, self.run.rel_input_path, self.run.database, {})
    patcher = mock.patch.object(sys.modules['qaboard.config'], 'config', {})
    patcher.start()
    self.addCleanup(patcher.stop)

  def storage(self, *users):
    """The commit's outputs directory for each user"""
    commit_dirs = [self.tmp / 'storage' / user / 'commit' for user in users]
    for d in commit_dirs:
      (d / self.run_dir).mkdir(parents=True)
    return mock.patch.object(bit_accuracy, 'commit_outputs_dirs', return_value=commit_dirs)

  def test_asks_qaboard_first(self):
    anywhere = self.tmp / 'anywhere'
    with self.storage('ci'), mock.patch.object(bit_accuracy, 'runs_known_by_qaboard', return_value=(qaboard_run(anywhere),)) as known:
      self.assertEqual(CommitRuns('a' * 40, 'default').find(self.run), [anywhere])
      known.assert_called_once_with('a' * 40, 'default')

  def test_storage_for_every_user(self):
    with self.storage('alice', 'ci'), mock.patch.object(bit_accuracy, 'runs_known_by_qaboard', return_value=None):
      found = CommitRuns('a' * 40, 'default').find(self.run)
    self.assertEqual(found, [self.tmp / 'storage' / user / 'commit' / self.run_dir for user in ['alice', 'ci']])

  def test_storage_when_qaboard_doesnt_know_the_run(self):
    with self.storage('ci'), mock.patch.object(bit_accuracy, 'runs_known_by_qaboard', return_value=(qaboard_run('/x', input='dir/b.jpg'),)):
      found = CommitRuns('a' * 40, 'default').find(self.run)
    self.assertEqual(found, [self.tmp / 'storage' / 'ci' / 'commit' / self.run_dir])

  def test_local_dir_first(self):
    local_dir = self.tmp / 'local'
    (local_dir / self.run_dir).mkdir(parents=True)
    with self.storage('ci'), mock.patch.object(bit_accuracy, 'runs_known_by_qaboard', side_effect=AssertionError):
      self.assertEqual(CommitRuns('a' * 40, 'default', ask_qaboard=False, local_dir=local_dir).find(self.run), [local_dir / self.run_dir])

  def test_local_runs_are_not_in_the_storage(self):
    with self.storage('ci'):
      runs = CommitRuns('a' * 40, 'default', ask_qaboard=False, local_dir=self.tmp / 'local', in_storage=False)
      self.assertEqual(runs.find(self.run), [])
      self.assertEqual(runs.looked_at(self.run), [self.tmp / 'local' / self.run_dir])

  def test_label(self):
    with self.storage('ci'):
      self.assertEqual(CommitRuns('a' * 40, 'other-label', ask_qaboard=False).find(self.run), [])


  def save_run(self, root, configurations, platform='linux', input='dir/a.jpg'):
    """A run saved by `qa run` under `root`"""
    run = run_context(input=input, platform=platform, configurations=configurations)
    output_dir = root / run_dir_in_commit('default', platform, configurations, {}, run.rel_input_path, run.database, {})
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / 'run.json').write_text(json.dumps({'database': '/db', 'input_path': input, 'platform': platform, 'configurations': configurations, 'extra_parameters': {}}))
    return output_dir

  def test_closest_saved_runs(self):
    run = run_context(configurations=['base', {'gain': 3}])
    storage = [self.tmp / 'storage' / user / 'commit' for user in ['alice', 'ci']]
    far = self.save_run(storage[1], ['base', {'gain': 100}])
    close = self.save_run(storage[1], ['base', {'gain': 4}])
    # another input with the same folder name: it would be the closest
    self.save_run(storage[1], ['base', {'gain': 3.1}], input='dir/a.png')
    with mock.patch.object(bit_accuracy, 'commit_outputs_dirs', return_value=storage):
      runs = CommitRuns('a' * 40, 'default', ask_qaboard=False, match='closest')
      self.assertEqual(runs.find(run), [close])
      self.assertEqual(runs.find_runs(run)[0][1]['configurations'], ['base', {'gain': 4}])
      self.assertEqual(CommitRuns('a' * 40, 'default', ask_qaboard=False).find(run), [])
      # the same run in each user's folder
      same = [self.save_run(d, ['base', {'gain': 3}]) for d in storage]
      self.assertEqual(runs.find(run), same)
      self.assertEqual(CommitRuns('a' * 40, 'other-label', ask_qaboard=False, match='closest').find(run), [])
      self.assertIn(far, [d for d, _ in runs.saved_runs_on_input(storage[1], run)])
      self.assertEqual(runs.looked_at(run_context(input='dir/c.jpg'))[0].parts[-3:], ('output', '*', 'dir-c'))

  def test_closest_asks_qaboard_first(self):
    run = run_context(configurations=['base', {'gain': 3}])
    self.save_run(self.tmp / 'storage', ['base', {'gain': 3}])
    known = (qaboard_run(self.tmp / 'anywhere', configurations=['base', {'gain': 4}]),)
    with mock.patch.object(bit_accuracy, 'commit_outputs_dirs', return_value=[self.tmp / 'storage']), \
         mock.patch.object(bit_accuracy, 'runs_known_by_qaboard', return_value=known):
      self.assertEqual(CommitRuns('a' * 40, 'default', match='closest').find(run), [self.tmp / 'anywhere'])


class TestIsBitAccurate(unittest.TestCase):
  def setUp(self):
    tmp = tempfile.TemporaryDirectory()
    self.addCleanup(tmp.cleanup)
    self.new, self.ref = Path(tmp.name) / 'new', Path(tmp.name) / 'ref'
    self.config = {'bit_accuracy': {'ignore': ['debug/']}}
    patcher = mock.patch.object(sys.modules['qaboard.config'], 'config', self.config)
    patcher.start()
    self.addCleanup(patcher.stop)

  def check(self, **kwargs):
    with mock.patch('click.secho'), mock.patch('click.echo'):
      return is_bit_accurate(self.new, self.ref, run_context(), **kwargs)

  def test_manifests(self):
    write_manifests(self.new, {'out.txt': 'a', 'debug/x': '1'})
    write_manifests(self.ref, {'out.txt': 'a', 'debug/x': '2'})
    self.assertTrue(self.check())
    self.assertTrue(self.check(manifest_name='manifest.inputs.json'))
    write_manifests(self.ref, {'out.txt': 'b'})
    self.assertFalse(self.check())
    # the config is not changed
    self.assertEqual(self.config['bit_accuracy']['ignore'], ['debug/'])

  def test_strict(self):
    write_manifests(self.new, {'out.txt': 'a', 'more.txt': 'a'})
    write_manifests(self.ref, {'out.txt': 'a'})
    self.assertTrue(self.check())
    self.assertFalse(self.check(strict=True))

  def test_missing_runs(self):
    write_manifests(self.new, {'out.txt': 'a'})
    self.assertFalse(self.check())
    self.assertFalse(self.check(manifest_name='manifest.inputs.json'))

  def test_files_without_manifests(self):
    for d in [self.new, self.ref]:
      d.mkdir()
      (d / 'out.txt').write_text('same')
    self.assertTrue(self.check())
    (self.ref / 'out.txt').write_text('other')
    self.assertFalse(self.check())


if __name__ == '__main__':
  unittest.main()
