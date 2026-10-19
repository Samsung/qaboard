"""
Tests for QA_NOTIFY=email: when `qa batch` asks QA-Board for an email at the end of its runs.
"""
import os
import unittest
from unittest import mock

import click


class TestNotifyChannel(unittest.TestCase):
  def channel(self, environ, is_ci=False, nested=False, started_by_qaboard=False):
    from qaboard.notify import notify_channel
    return notify_channel(is_ci, nested, started_by_qaboard, environ=environ)

  def test_opt_in(self):
    self.assertEqual(self.channel({'QA_NOTIFY': 'email'}), 'email')
    self.assertEqual(self.channel({'QA_NOTIFY': ' Email '}), 'email')
    for off in ('', '0', 'none', 'off', 'false'):
      self.assertIsNone(self.channel({'QA_NOTIFY': off}))
    self.assertIsNone(self.channel({}))

  def test_unknown_channels_warn(self):
    with mock.patch('click.secho') as secho:
      self.assertIsNone(self.channel({'QA_NOTIFY': 'slack'}))
    self.assertIn('QA_NOTIFY=slack', secho.call_args.args[0])

  def test_never_in_ci_nested_or_from_qaboard(self):
    environ = {'QA_NOTIFY': 'email'}
    self.assertIsNone(self.channel(environ, is_ci=True))
    # e.g. a pipeline's steps: only the first `qa batch` notifies, when all the runs end
    self.assertIsNone(self.channel(environ, nested=True))
    # QA-Board asks itself, when users chose "Email me when it ends"
    self.assertIsNone(self.channel(environ, started_by_qaboard=True))


class TestNested(unittest.TestCase):
  def test_nested(self):
    from qaboard.notify import is_nested
    self.assertFalse(is_nested({}))
    self.assertTrue(is_nested({'QA_BATCH': 'true'}))
    self.assertTrue(is_nested({'QA_BATCH_ROOT_COMMAND_ID': 'abc'}))

  def test_root_command_is_inherited_until_the_command_ends(self):
    from qaboard.notify import inherit_root_command
    with mock.patch.dict(os.environ, {}, clear=False):
      os.environ.pop('QA_BATCH_ROOT_COMMAND_ID', None)
      with click.Context(click.Command('batch')) as ctx:
        inherit_root_command(ctx, 'root-1')
        self.assertEqual(os.environ['QA_BATCH_ROOT_COMMAND_ID'], 'root-1')
      self.assertNotIn('QA_BATCH_ROOT_COMMAND_ID', os.environ)

      os.environ['QA_BATCH_ROOT_COMMAND_ID'] = 'outer'
      with click.Context(click.Command('batch')) as ctx:
        inherit_root_command(ctx, 'outer')
      self.assertEqual(os.environ['QA_BATCH_ROOT_COMMAND_ID'], 'outer')


class TestHint(unittest.TestCase):
  def hint(self, environ, waits=False, isatty=True, **kwargs):
    from qaboard.notify import shows_hint
    options = {'is_ci': False, 'nested': False, 'started_by_qaboard': False, **kwargs}
    with mock.patch('sys.stderr') as stderr:
      stderr.isatty.return_value = isatty
      return shows_hint(waits=waits, environ=environ, **options)

  def test_hint_for_people_at_a_terminal(self):
    self.assertTrue(self.hint({}))
    # they see when the runs end
    self.assertFalse(self.hint({}, waits=True))
    self.assertFalse(self.hint({}, isatty=False))
    # setting QA_NOTIFY, even to "none", hides it
    self.assertFalse(self.hint({'QA_NOTIFY': 'none'}))
    self.assertFalse(self.hint({}, is_ci=True))
    self.assertFalse(self.hint({}, nested=True))
    self.assertFalse(self.hint({}, started_by_qaboard=True))


class TestPrintNotification(unittest.TestCase):
  def test_print(self):
    from qaboard.notify import print_notification
    with mock.patch('click.secho') as secho:
      print_notification(None)
      secho.assert_not_called()
      print_notification({'channel': 'email', 'recipient': 'jdoe@example.com'})
      self.assertIn('jdoe@example.com', secho.call_args.args[0])
      print_notification({'error': "This QA-Board server can't send emails."})
      self.assertIn("can't send emails", secho.call_args.args[0])


if __name__ == '__main__':
  unittest.main()
