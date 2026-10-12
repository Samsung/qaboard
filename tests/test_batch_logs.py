"""
Tests for the logs that `qa batch` saves when it's started from a terminal.
"""
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import click
from click.testing import CliRunner


class TestTeeStdStreams(unittest.TestCase):
  def test_tee(self):
    from qaboard.utils import tee_std_streams
    with tempfile.TemporaryDirectory() as tmp:
      path = Path(tmp) / 'log.txt'
      previous = sys.stdout, sys.stderr
      with path.open('a') as file:
        with self.assertRaises(ValueError):
          with tee_std_streams(file):
            print('hello')
            print('oops', file=sys.stderr)
            raise ValueError('bad input')
      self.assertEqual((sys.stdout, sys.stderr), previous)
      log = path.read_text()
      self.assertTrue(log.startswith('hello\noops\n'))
      # Python prints the error after the block: we saved it
      self.assertIn('Traceback (most recent call last)', log)
      self.assertIn('ValueError: bad input', log)

  def test_exit(self):
    from qaboard.utils import tee_std_streams
    with tempfile.TemporaryDirectory() as tmp:
      path = Path(tmp) / 'log.txt'
      with path.open('a') as file:
        with self.assertRaises(SystemExit):
          with tee_std_streams(file):
            click.secho('3 runs failed', fg='red', err=True)
            sys.exit(1)
      self.assertEqual(path.read_text(), '3 runs failed\n')


@click.command()
@click.option('--list-inputs', is_flag=True)
@click.pass_context
def fake_batch(ctx, list_inputs):
  from qaboard.batch_logs import saves_logs, batch_log
  @saves_logs
  def body(ctx, list_inputs):
    print('starting 2 runs')
    log = batch_log(ctx)
    print(f"log: {log['path'] if log else None}")
  body(ctx, list_inputs)


class TestSavesLogs(unittest.TestCase):
  def invoke(self, *args, is_ci=False, env=None, **obj):
    tmp = tempfile.TemporaryDirectory()
    self.addCleanup(tmp.cleanup)
    obj = {'share': True, 'offline': False, 'dryrun': False, 'batch_dir': Path(tmp.name), **obj}
    environ = {k: v for k, v in os.environ.items() if k not in ('QA_BATCH', 'QA_BATCH_COMMAND_HIDE_LOGS', 'QA_NO_STREAM_REDIRECT')}
    with mock.patch('qaboard.batch_logs.is_ci', is_ci), mock.patch.dict(os.environ, {**environ, **(env or {})}, clear=True):
      result = CliRunner().invoke(fake_batch, args, obj=obj)
    self.assertEqual(result.exit_code, 0, result.output)
    logs = list(Path(tmp.name).glob('qa-batch-logs/*/log.txt'))
    return result, logs

  def test_saves_logs_from_terminals(self):
    result, logs = self.invoke()
    self.assertEqual(len(logs), 1)
    self.assertIn('starting 2 runs', result.output)
    path = result.output.splitlines()[-1].replace('log: ', '')
    self.assertRegex(path, r'^qa-batch-logs/\d{8}-\d{6}-[0-9a-f]{8}/log\.txt$')
    self.assertEqual(logs[0].read_text(), f'starting 2 runs\nlog: {path}\n')

  def test_logs_saved_elsewhere(self):
    # the CI, or QA-Board, have the logs
    self.assertEqual(self.invoke(is_ci=True)[1], [])
    # QA-Board doesn't know about the batch
    self.assertEqual(self.invoke(share=False)[1], [])
    self.assertEqual(self.invoke(offline=True)[1], [])
    self.assertEqual(self.invoke('--list-inputs')[1], [])
    # a run started the batch, our logs are in its log
    self.assertEqual(self.invoke(env={'QA_BATCH': 'true'})[1], [])

  def test_unwritable_batch_dir(self):
    result, logs = self.invoke(batch_dir=Path('/proc/qaboard-tests'))
    self.assertIn('WARNING: Could not save the logs', result.output)
    self.assertIn('log: None', result.output)


if __name__ == '__main__':
  unittest.main()
