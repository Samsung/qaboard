"""
Tests for qaboard/attempts.py: runs that are done again get their own directory.
"""
import os
import stat
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from qaboard import attempts
from qaboard.attempts import POINTER


def run_in(output_dir: Path, **files):
  """What `qa run` leaves in a directory"""
  output_dir.mkdir(parents=True, exist_ok=True)
  (output_dir / 'run.json').write_text('{}')
  for name, content in files.items():
    (output_dir / name).write_text(content)


class TestAttemptDirs(unittest.TestCase):
  def setUp(self):
    tmp = tempfile.TemporaryDirectory()
    self.addCleanup(tmp.cleanup)
    self.first = Path(tmp.name) / 'output' / 'linux' / 'night-scene'

  def test_names(self):
    self.assertEqual(attempts.attempt_dir(self.first, 1), self.first)
    self.assertEqual(attempts.attempt_dir(self.first, 3).name, 'night-scene_attempt3')
    self.assertEqual(attempts.split(self.first.with_name('night-scene_attempt3')), (self.first, 3))
    self.assertEqual(attempts.split(self.first), (self.first, 1))
    self.assertEqual(attempts.split('/storage/output/night-scene_attempt12'), (Path('/storage/output/night-scene'), 12))
    # not attempts: the first attempt has no suffix, and numbers don't start with 0
    for name in ('night-scene_attempt1', 'night-scene_attempt0', 'night-scene_attempt02', 'night-scene_attempt', '_attempt2'):
      self.assertEqual(attempts.split(self.first.with_name(name)), (self.first.with_name(name), 1))

  def test_names_cant_be_inputs_names(self):
    """Run directories are named by slugify_hash: no "_", so a suffix is never part of an input's name"""
    from qaboard.conventions import slugify_hash
    for name in ('night_scene_attempt2', 'a/b_attempt3.jpg', 'x' * 100 + '_attempt2'):
      self.assertNotIn('_', slugify_hash(name, maxlength=70))

  def test_the_first_attempt_is_where_runs_always_were(self):
    self.assertEqual(attempts.latest_dir(self.first), self.first)
    self.assertEqual(attempts.reserve(self.first), self.first)
    self.assertFalse(self.first.exists())
    # reserved again, e.g. by the job's `qa run` after `qa batch`: the same, until a run starts in it
    self.first.mkdir(parents=True)
    (self.first / 'log.lsf.txt').write_text('the runner sends its log before the run starts')
    self.assertEqual(attempts.reserve(self.first), self.first)
    self.assertFalse((self.first / POINTER).exists())

  def test_a_run_done_again_gets_a_new_directory(self):
    run_in(self.first)
    second = attempts.reserve(self.first)
    self.assertEqual(second, self.first.with_name('night-scene_attempt2'))
    self.assertEqual((self.first / POINTER).read_text(), '2\n')
    self.assertEqual(attempts.latest_dir(self.first), second)
    # nothing else is written: runners create the directory, or `qa run`
    self.assertFalse(second.exists())
    self.assertEqual(attempts.reserve(self.first), second)
    second.mkdir()
    (second / 'log.lsf.txt').write_text('')
    self.assertEqual(attempts.reserve(self.first), second)
    run_in(second)
    third = attempts.reserve(self.first)
    self.assertEqual(third.name, 'night-scene_attempt3')
    self.assertEqual(attempts.latest_dir(self.first), third)
    self.assertEqual(attempts.latest_attempt(self.first), 3)
    self.assertEqual([p.name for p in self.first.iterdir() if p.name.endswith('.tmp')], [])

  def test_a_run_whose_files_were_deleted_is_not_done_again_at_the_same_paths(self):
    """Deleting a run's files keeps its manifest: images served from its paths may be cached"""
    self.first.mkdir(parents=True)
    (self.first / 'manifest.outputs.json').write_text('{}')
    self.assertEqual(attempts.reserve(self.first).name, 'night-scene_attempt2')

  def test_paths_are_not_used_twice(self):
    run_in(self.first)
    run_in(self.first.with_name('night-scene_attempt2')) # latest_attempt.txt was removed by hand
    self.assertEqual(attempts.reserve(self.first).name, 'night-scene_attempt3')

  def test_unreadable_pointer(self):
    run_in(self.first)
    for content in ('', 'three', '-2', '0'):
      (self.first / POINTER).write_text(content)
      self.assertEqual(attempts.latest_attempt(self.first), 1, content)
    (self.first / POINTER).write_text(' 4 \n')
    self.assertEqual(attempts.latest_attempt(self.first), 4)

  def test_stale_pointer_on_nfs(self):
    """Replaced on another host: this one's first read can fail with ESTALE, the next one reads the new file"""
    import errno
    run_in(self.first)
    (self.first / POINTER).write_text('3\n')
    read_text = Path.read_text
    calls = []
    def stale_once(path, *args, **kwargs):
      calls.append(path)
      if len(calls) == 1:
        raise OSError(errno.ESTALE, 'Stale file handle')
      return read_text(path, *args, **kwargs)
    with mock.patch.object(Path, 'read_text', stale_once):
      self.assertEqual(attempts.latest_attempt(self.first), 3)
    self.assertEqual(len(calls), 2)
    # not forever
    with mock.patch.object(Path, 'read_text', side_effect=OSError(errno.ESTALE, 'Stale file handle')):
      self.assertEqual(attempts.latest_attempt(self.first), 1)

  def test_remove_previous(self):
    run_in(self.first, **{'out.txt': '1'})
    (self.first / 'debug').mkdir()
    (self.first / 'debug' / 'a.txt').write_text('')
    second = attempts.reserve(self.first)
    attempts.remove_previous(second)
    # the first attempt's directory stays: it says where the run is
    self.assertEqual([p.name for p in self.first.iterdir()], [POINTER])
    run_in(second, **{'out.txt': '2'})
    third = attempts.reserve(self.first)
    attempts.remove_previous(third)
    self.assertFalse(second.exists())
    self.assertEqual([p.name for p in self.first.iterdir()], [POINTER])
    # nothing to do for a first attempt, or when the previous attempt is gone
    attempts.remove_previous(self.first)
    attempts.remove_previous(third)

  def test_the_logs_of_earlier_attempts_are_kept(self):
    """A failed attempt's log is often all that says why a run was done again"""
    run_in(self.first, **{'log.txt': 'one', 'out.txt': ''})
    second = attempts.reserve(self.first)
    attempts.remove_previous(second)
    self.assertEqual((second / 'log.attempt1.txt').read_text(), 'one')
    self.assertEqual([p.name for p in self.first.iterdir()], [POINTER])
    run_in(second, **{'log.txt': 'two'})
    third = attempts.reserve(self.first)
    attempts.remove_previous(third)
    self.assertEqual(attempts.kept_logs(third), [1, 2])
    self.assertEqual((third / 'log.attempt1.txt').read_text(), 'one')
    self.assertEqual((third / 'log.attempt2.txt').read_text(), 'two')
    self.assertFalse(second.exists())
    # only the last ones, and an attempt without a log (it never started) leaves none
    run_in(third, **{'log.txt': 'three'})
    fourth = attempts.reserve(self.first)
    with mock.patch.object(attempts, 'MAX_KEPT_LOGS', 2):
      attempts.remove_previous(fourth)
    self.assertEqual(attempts.kept_logs(fourth), [2, 3])
    run_in(fourth)
    fifth = attempts.reserve(self.first)
    attempts.remove_previous(fifth)
    self.assertEqual(attempts.kept_logs(fifth), [2, 3])
    self.assertEqual(attempts.kept_logs(self.first / 'missing'), [])
    # other files named like logs are not ours
    (fifth / 'log.attempt.txt').write_text('')
    (fifth / 'log.attempt02.txt').write_text('')
    self.assertEqual(attempts.kept_logs(fifth), [2, 3])

  @unittest.skipIf(os.name == 'nt' or (hasattr(os, 'geteuid') and os.geteuid() == 0), "needs permissions that hold")
  def test_files_that_cant_be_removed_stay(self):
    run_in(self.first)
    second = attempts.reserve(self.first)
    run_in(second, **{'out.txt': '2'})
    third = attempts.reserve(self.first)
    second.chmod(stat.S_IRUSR | stat.S_IXUSR)
    self.addCleanup(second.chmod, stat.S_IRWXU)
    with mock.patch('click.secho') as secho:
      attempts.remove_previous(third)
    self.assertTrue((second / 'out.txt').exists())
    self.assertIn('Could not remove the files of the previous attempt', secho.call_args[0][0])

  @unittest.skipIf(os.name == 'nt' or (hasattr(os, 'geteuid') and os.geteuid() == 0), "needs permissions that hold")
  def test_reruns_in_place_when_the_pointer_cant_be_written(self):
    """e.g. the first attempt's directory belongs to someone else"""
    run_in(self.first)
    self.first.chmod(stat.S_IRUSR | stat.S_IXUSR)
    self.addCleanup(self.first.chmod, stat.S_IRWXU)
    with self.assertRaises(OSError):
      attempts.reserve(self.first)
    with mock.patch('click.secho') as secho:
      self.assertEqual(attempts.reserve_or_keep(self.first), self.first)
    self.assertIn('in place', secho.call_args[0][0])

  def test_reserve_or_keep_from_any_attempt(self):
    run_in(self.first)
    second = attempts.reserve_or_keep(self.first)
    run_in(second)
    self.assertEqual(attempts.reserve_or_keep(second).name, 'night-scene_attempt3')

  def test_forget(self):
    run_in(self.first)
    second = attempts.reserve(self.first)
    attempts.remove_previous(second)
    run_in(second)
    # the run's files are still there, or it's a first attempt
    self.assertIsNone(attempts.forget(self.first))
    self.assertTrue((self.first / POINTER).exists())
    (self.first / 'kept.txt').write_text('')
    self.assertIsNone(attempts.forget(second))
    (self.first / 'kept.txt').unlink()
    self.assertEqual(attempts.forget(second), self.first)
    self.assertFalse(self.first.exists())
    self.assertIsNone(attempts.forget(second))

  def test_reruns_mode(self):
    with mock.patch.dict(os.environ, {k: v for k, v in os.environ.items() if k != 'QA_RERUNS'}, clear=True):
      self.assertEqual(attempts.reruns_mode({}), 'new-directory')
      self.assertEqual(attempts.reruns_mode(None), 'new-directory')
      self.assertEqual(attempts.reruns_mode({'outputs': None}), 'new-directory')
      self.assertEqual(attempts.reruns_mode({'outputs': {'reruns': 'in-place'}}), 'in-place')
      self.assertEqual(attempts.reruns_mode({'outputs': {'reruns': 'new-directory'}}), 'new-directory')
      with mock.patch.dict(os.environ, {'QA_RERUNS': 'in_place'}):
        self.assertEqual(attempts.reruns_mode({}), 'in-place')
      with mock.patch.dict(os.environ, {'QA_RERUNS': 'new-directory'}):
        self.assertEqual(attempts.reruns_mode({'outputs': {'reruns': 'in-place'}}), 'new-directory')


class TestCleanOutputDirKeeps(unittest.TestCase):
  def test_keep(self):
    from qaboard.utils import clean_output_dir
    with tempfile.TemporaryDirectory() as tmp:
      output_dir = Path(tmp) / 'run'
      run_in(output_dir, **{POINTER: '2\n', 'out.txt': ''})
      (output_dir / 'sub').mkdir()
      # only directly in the directory
      (output_dir / 'sub' / POINTER).write_text('')
      clean_output_dir(output_dir, keep=(POINTER,))
      self.assertEqual([p.name for p in output_dir.iterdir()], [POINTER])
      clean_output_dir(output_dir)
      # the directory itself stays when our output goes to a file (it may be in it), e.g. in CI
      self.assertEqual(list(output_dir.iterdir()) if output_dir.exists() else [], [])


if __name__ == '__main__':
  unittest.main()
