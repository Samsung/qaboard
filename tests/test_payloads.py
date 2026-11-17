"""
Tests for qaboard/payloads.py: what `qa` and `qaboard.start_run()` both send with results.
"""
import ast
import json
import unittest
from pathlib import Path

from qaboard.payloads import results_payload, serialize_paths

COMMIT = {'commit_branch': 'main', 'commit_authored_datetime': '2026-11-13T10:00:00+00:00', 'commit_message': 'Fix'}


class TestResultsPayload(unittest.TestCase):
  def payload(self, fields=None, **kwargs):
    options = dict(is_ci=False, run_context={'origin': 'local'}, commit_id='a' * 40, commit=COMMIT, config={'project': {'name': 'g/repo'}}, metrics_file={'main_metrics': []})
    return results_payload(fields or {'project': 'g/repo'}, **{**options, **kwargs})

  def test_what_the_server_reads(self):
    payload = self.payload({'project': 'g/repo', 'output_directory': Path('/mnt/qaboard/run'), 'data': {'paths': [Path('a/b')]}})
    self.assertEqual(payload['job_type'], 'local')
    self.assertEqual(payload['commit_sha'], payload['git_commit_sha'])
    self.assertEqual(payload['commit_branch'], 'main')
    self.assertEqual(payload['qaboard_config'], {'project': {'name': 'g/repo'}})
    self.assertEqual(payload['qaboard_metrics'], {'main_metrics': []})
    # paths as text, at any depth
    self.assertEqual((payload['output_directory'], payload['data']), ('/mnt/qaboard/run', {'paths': ['a/b']}))
    json.dumps(payload)
    self.assertEqual(self.payload(is_ci=True)['job_type'], 'ci')

  def test_what_we_know_about_the_commit_wins_over_the_fields(self):
    # `qa` sends its whole context: a stray commit_branch in it doesn't replace git's
    self.assertEqual(self.payload({'commit_branch': 'stale', 'job_type': 'other'})['commit_branch'], 'main')
    self.assertEqual(self.payload({'job_type': 'webapp'})['job_type'], 'webapp')

  def test_without_a_project_configuration_none_is_sent(self):
    # a notebook outside a project must not replace the project's qaboard.yaml on the server
    payload = self.payload(config=None, metrics_file=None)
    self.assertNotIn('qaboard_config', payload)
    self.assertNotIn('qaboard_metrics', payload)

  def test_the_configuration_is_not_changed(self):
    config = {'storage': Path('/mnt/qaboard'), 'inputs': {'batches': [Path('qa/batches.yaml')]}}
    self.assertEqual(self.payload(config=config)['qaboard_config'], {'storage': '/mnt/qaboard', 'inputs': {'batches': ['qa/batches.yaml']}})
    self.assertIsInstance(config['storage'], Path)
    self.assertEqual(serialize_paths({'a': [Path('x'), 1]}), {'a': ['x', 1]})

  def test_qa_and_the_sdk_build_it_here(self):
    root = Path(__file__).resolve().parent.parent / 'qaboard'
    for module in ('api.py', 'active_run.py'):
      names = {node.func.id for node in ast.walk(ast.parse((root / module).read_text())) if isinstance(node, ast.Call) and isinstance(node.func, ast.Name)}
      self.assertIn('results_payload', names, module)
    # no side effects: nothing read from the current project
    imported = {node.module for node in ast.walk(ast.parse((root / 'payloads.py').read_text())) if isinstance(node, ast.ImportFrom) and node.level}
    self.assertLessEqual(imported, {'compat'})


if __name__ == '__main__':
  unittest.main()
