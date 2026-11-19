"""
Tests for qaboard/run_files.py: a run's files fetched from the server, here its manifests for `qa check-bit-accuracy`.
The server is the fake one of test_active_run.py, serving files like nginx under /s/.
"""
import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from qaboard import run_files
from qaboard.run_files import FETCHED_MARKER, fetched_manifests

from .test_active_run import FakeServer

RUN = {'id': 7, 'output_dir_url': '/s/runs/project/abc/ci/7', 'finished_at': '2026-11-19T10:00:00', 'is_pending': False}
OUTPUTS = b'{"result.bin": {"sha256": "00"}}'


class TestFetchedManifests(unittest.TestCase):
  def setUp(self):
    tmp = tempfile.TemporaryDirectory()
    self.addCleanup(tmp.cleanup)
    for patch in (mock.patch.dict(os.environ, {'XDG_CACHE_HOME': tmp.name}), mock.patch.object(run_files, 'RETRY_DELAYS', (0.0,))):
      patch.start()
      self.addCleanup(patch.stop)
    self.cache = Path(tmp.name)
    self.server = FakeServer()
    self.addCleanup(self.server.close)
    self.server.served[f"{RUN['output_dir_url']}/manifest.outputs.json"] = OUTPUTS
    self.warnings = []

  def fetch(self, run=RUN):
    return fetched_manifests(run, self.server.url, token='token', warn=self.warnings.append)

  def gets(self):
    return [path for method, path, _, _ in self.server.requests if method == 'GET']

  def test_fetches_the_manifests_once_per_finished_run(self):
    folder = self.fetch()
    self.assertTrue(folder.is_relative_to(self.cache / 'qaboard' / 'manifests'))
    self.assertEqual((folder / 'manifest.outputs.json').read_bytes(), OUTPUTS)
    # the run has no inputs' manifest: not an error
    self.assertFalse((folder / 'manifest.inputs.json').exists())
    self.assertTrue((folder / FETCHED_MARKER).exists())
    self.assertEqual(self.server.requests[0][3]['Authorization'], 'Bearer token')
    asked = len(self.server.requests)
    self.assertEqual(self.fetch(), folder)
    self.assertEqual(len(self.server.requests), asked)
    self.assertEqual(self.warnings, [])
    # nothing half-written left
    self.assertEqual(sorted(p.name for p in folder.iterdir()), sorted([FETCHED_MARKER, 'manifest.outputs.json']))

  def test_runs_done_again_are_fetched_again(self):
    first = self.fetch()
    again = self.fetch({**RUN, 'finished_at': '2026-11-20T10:00:00'})
    self.assertNotEqual(first, again)
    pending = {**RUN, 'is_pending': True}
    self.fetch(pending)
    asked = len(self.server.requests)
    # its manifests may still change
    self.fetch(pending)
    self.assertGreater(len(self.server.requests), asked)

  def test_runs_without_manifests(self):
    self.assertIsNone(self.fetch({**RUN, 'output_dir_url': '/s/runs/other'}))
    self.assertIsNone(fetched_manifests({**RUN, 'output_dir_url': None}, self.server.url))
    self.assertIsNone(fetched_manifests(RUN, None))
    self.assertEqual(self.warnings, [])

  def test_errors_are_warnings(self):
    refused = mock.Mock(status_code=403, headers={}, text='')
    refused.json.return_value = {'error': "You can't see this project", 'reason': 'missing_role'}
    with mock.patch('requests.Session.request', return_value=refused):
      self.assertIsNone(self.fetch())
    self.assertIn("You can't see this project", self.warnings[0])

  def test_busy_servers_are_asked_again(self):
    import requests
    original = requests.Session.request
    calls = []
    def flaky(method, url, **kwargs):
      calls.append(url)
      if len(calls) == 1:
        raise requests.ConnectionError('reset')
      return original(requests.Session(), method, url, **kwargs)
    with mock.patch('requests.Session.request', side_effect=flaky):
      folder = self.fetch()
    self.assertEqual((folder / 'manifest.outputs.json').read_bytes(), OUTPUTS)
    self.assertEqual(calls[0], calls[1])


if __name__ == '__main__':
  unittest.main()
