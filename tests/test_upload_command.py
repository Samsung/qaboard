"""
Tests for `qa upload` (qaboard/upload_command.py), and for `qa run` without a storage shared with the server:
real `qa` commands in a temporary folder, against the fake server of test_active_run.py.
"""
import json
import os
import subprocess
import sys
import unittest
from pathlib import Path

from .test_active_run import ActiveRunTestCase, ROOT, git

REPORT = """<?xml version="1.0"?>
<testsuites>
  <testsuite name="codec">
    <testcase classname="tests.codec" name="test_roundtrip" time="0.25"/>
    <testcase classname="tests.codec" name="test_varint" time="0.5"><failure message="expected 3">trace</failure></testcase>
    <testcase classname="tests.codec" name="test_slow"><skipped/></testcase>
  </testsuite>
</testsuites>
"""
COMMIT = 'c' * 40


class QaTestCase(ActiveRunTestCase):
  def setUp(self):
    super().setUp()
    self.work = Path(self.tmp.name).resolve() / 'work'
    self.work.mkdir()
    (self.work / 'junit.xml').write_text(REPORT)

  def qa(self, *args, cwd=None, server=None, ci=True, **env):
    """Runs `qa`, by default like a CI job of the repository kitefin/planner, outside a QA-Board project"""
    from qaboard.config import ci_env_variables
    environ = {k: v for k, v in os.environ.items() if not k.startswith(('QA', 'CI_', 'GITHUB_')) and k not in ci_env_variables}
    environ.update({
      'PYTHONPATH': str(ROOT), 'HOME': str(self.home), 'XDG_CONFIG_HOME': str(self.home), 'QABOARD_IGNORE_SITE': '1', 'QA_USER': 'alice',
      'QA_NO_CHECK_FOR_UPDATES': '1',
      **({'CI': 'true', 'GITHUB_ACTIONS': 'true', 'GITHUB_REPOSITORY': 'kitefin/planner', 'GITHUB_SHA': COMMIT, 'GITHUB_JOB': 'unit-tests'} if ci else {}),
      **({'QABOARD_URL': server.url} if server else {}),
      **env,
    })
    return subprocess.run([sys.executable, '-m', 'qaboard', *args], cwd=cwd or self.work, env=environ, capture_output=True, text=True, timeout=120)


class TestUpload(QaTestCase):
  def test_a_test_report_from_a_ci_job_without_a_project(self):
    server = self.server()
    result = self.qa('upload', 'junit.xml', server=server)
    self.assertEqual(result.returncode, 0, result.stderr)
    self.assertIn(f"finished: {server.url}/kitefin/planner/commit/{COMMIT}", result.stderr)
    started, finished = server.outputs()
    self.assertEqual((started['project'], started['commit_sha'], started['batch_label'], started['input_path'], started['storage']),
                     ('kitefin/planner', COMMIT, 'default', 'unit-tests/junit', 'upload'))
    # without a qaboard.yaml the project keeps its configuration
    self.assertNotIn('qaboard_config', started)
    # the report's metrics, with which way is better
    self.assertEqual({k: finished['metrics'][k] for k in ('tests', 'passed', 'failed', 'errors', 'skipped', 'flaky', 'test_time')},
                     {'tests': 3, 'passed': 1, 'failed': 1, 'errors': 0, 'skipped': 1, 'flaky': 0, 'test_time': 0.75})
    self.assertFalse(finished['metrics']['is_failed'])
    self.assertEqual(finished['metrics_definitions']['failed']['smaller_is_better'], True)
    self.assertEqual(server.files['junit.xml'], REPORT.encode())
    self.assertIn(b'qa upload junit.xml', server.files['log.txt'])
    self.assertIn('junit.xml', json.loads(server.files['manifest.outputs.json']))

  def test_names_batch_configurations_and_metrics(self):
    server = self.server()
    (self.work / 'extra.json').write_text('{"coverage": 0.81, "tests": 99}')
    result = self.qa('--label', 'nightly', '-c', 'O3', '-c', '{"threads": 4}', '--platform', 'arm', 'upload', '--input', 'codec', '--batch', 'unit-tests',
                     '-m', 'throughput=812.5', '-m', 'verdict=ship', '--metrics', 'extra.json', 'junit.xml', server=server)
    self.assertEqual(result.returncode, 0, result.stderr)
    finished = server.outputs()[-1]
    self.assertEqual((finished['batch_label'], finished['batch'], finished['input_path'], finished['configurations'], finished['platform']),
                     ('nightly', 'unit-tests', 'codec', ['O3', {'threads': 4}], 'arm'))
    # given metrics win over those read from the files
    self.assertEqual({k: finished['metrics'][k] for k in ('throughput', 'verdict', 'coverage', 'tests', 'failed')},
                     {'throughput': 812.5, 'verdict': 'ship', 'coverage': 0.81, 'tests': 99, 'failed': 1})

  def test_files_and_folders_keep_their_names(self):
    server = self.server()
    (self.work / 'build' / 'coverage' / 'html').mkdir(parents=True)
    (self.work / 'build' / 'coverage' / 'html' / 'index.html').write_text('<p>')
    (self.work / 'build' / 'cpu.folded').write_text('main;parse 3\n')
    result = self.qa('upload', 'junit.xml', 'build/coverage', 'build/cpu.folded', '--no-read', server=server)
    self.assertEqual(result.returncode, 0, result.stderr)
    self.assertEqual(sorted(name for name in server.files if '.json' not in name and name != 'log.txt'), ['coverage/html/index.html', 'cpu.folded', 'junit.xml'])
    # several paths: the run is named after the CI job, and --no-read leaves the report's metrics out
    self.assertEqual(server.outputs()[-1]['input_path'], 'unit-tests')
    self.assertNotIn('tests', server.outputs()[-1]['metrics'])

  def test_another_name_for_a_file(self):
    server = self.server()
    (self.work / 'results.xml').write_text(REPORT)
    result = self.qa('upload', 'results.xml', '--as', 'junit.xml', server=server)
    self.assertEqual(result.returncode, 0, result.stderr)
    self.assertIn('junit.xml', server.files)
    self.assertNotIn('results.xml', server.files)
    # named like a report, it is read like one
    self.assertEqual((server.outputs()[-1]['input_path'], server.outputs()[-1]['metrics']['tests']), ('unit-tests/results', 3))

  def test_a_run_per_path(self):
    server = self.server()
    reports = self.work / 'reports'
    reports.mkdir()
    for name in ('TEST-codec.xml', 'TEST-planner.xml'):
      (reports / name).write_text(REPORT)
    result = self.qa('upload', '--each', 'reports/*.xml', server=server)   # a pattern the shell didn't expand
    self.assertEqual(result.returncode, 0, result.stderr)
    finished = [body for body in server.outputs() if not body['is_pending']]
    self.assertEqual([(body['input_path'], body['metrics']['tests']) for body in finished], [('unit-tests/TEST-codec', 3), ('unit-tests/TEST-planner', 3)])

  def test_names_with_dots_are_different_runs(self):
    server = self.server()
    for name in ('TEST-com.kitefin.CodecTest.xml', 'TEST-com.kitefin.PlannerTest.xml'):
      (self.work / name).write_text(REPORT)
    result = self.qa('upload', '--each', 'TEST-com.kitefin.CodecTest.xml', 'TEST-com.kitefin.PlannerTest.xml', server=server)
    self.assertEqual(result.returncode, 0, result.stderr)
    folders = [line.split('run files: ')[1] for line in result.stderr.splitlines() if 'run files: ' in line]
    self.assertEqual(len(set(folders)), 2, folders)
    for folder, name in zip(folders, ('TEST-com.kitefin.CodecTest.xml', 'TEST-com.kitefin.PlannerTest.xml')):
      self.assertTrue((Path(folder) / name).exists())

  def test_outside_the_ci_the_run_is_named_after_its_file(self):
    server = self.server()
    result = self.qa('upload', 'junit.xml', '--project', 'kitefin/planner', server=server, ci=False)
    self.assertEqual(result.returncode, 0, result.stderr)
    self.assertEqual((server.outputs()[-1]['input_path'], server.outputs()[-1]['batch_label']), ('junit', '@alice| default'))

  def test_a_dry_run_sends_nothing(self):
    server = self.server()
    result = self.qa('--dryrun', 'upload', 'junit.xml', '-m', 'coverage=0.8', server=server)
    self.assertEqual(result.returncode, 0, result.stderr)
    self.assertIn('unit-tests/junit: 1 files', result.stdout)
    self.assertIn('"tests": 3', result.stdout)
    self.assertIn('"coverage": 0.8', result.stdout)
    self.assertEqual((server.outputs(), server.puts()), ([], []))
    self.assertFalse((self.work / 'output').exists())

  def test_a_dry_run_needs_no_server(self):
    result = self.qa('--dryrun', '--label', 'nightly', 'upload', 'junit.xml')
    self.assertEqual(result.returncode, 0, result.stderr)
    self.assertIn('project: kitefin/planner', result.stdout)
    self.assertIn(f'commit: {COMMIT}', result.stdout)
    self.assertIn('batch: nightly', result.stdout)
    self.assertIn('QABOARD_URL', result.stdout)
    self.assertIn('unit-tests/junit: 1 files', result.stdout)
    # outside the CI, runs go to the user's own batch
    result = self.qa('--dryrun', 'upload', 'junit.xml', '--project', 'kitefin/planner', '--commit', COMMIT, ci=False)
    self.assertEqual(result.returncode, 0, result.stderr)
    self.assertIn('batch: default (your own, "@alice| default"', result.stdout)

  def test_a_dry_run_says_what_the_upload_does(self):
    """--dryrun prints plan_run(), and the upload start_run() with the same arguments"""
    for ci, args in [(True, ('--label', 'nightly', '-c', 'O3', 'upload', '--batch', 'unit-tests', 'junit.xml')),
                     (False, ('upload', 'junit.xml', '--project', 'kitefin/planner', '--commit', COMMIT, '--input', 'codec'))]:
      with self.subTest(ci=ci):
        server = self.server()
        dryrun = self.qa('--dryrun', *args, server=server, ci=ci)
        self.assertEqual(dryrun.returncode, 0, dryrun.stderr)
        said = dict(line.split(': ', 1) for line in dryrun.stdout.splitlines() if ': ' in line and not line.startswith(' '))
        folder = next(line.split('folder: ', 1)[1] for line in dryrun.stdout.splitlines() if 'folder: ' in line)
        result = self.qa(*args, server=server, ci=ci)
        self.assertEqual(result.returncode, 0, result.stderr)
        started = server.outputs()[0]
        batch = f"{started['raw_batch_label']} (your own, \"{started['batch_label']}\": outside the CI)" if started['batch_label'] != started['raw_batch_label'] else started['batch_label']
        if started.get('batch'):
          batch += f", {started['batch']} on the runs' cards"
        self.assertEqual((said['project'], said['commit'], said['batch']), (started['project'], started['commit_sha'], batch))
        self.assertIn(f"{started['input_path']}: 1 files", dryrun.stdout)
        self.assertIn(f"run files: {folder}", result.stderr)

  def test_errors_name_the_options(self):
    server = self.server()
    for args, expected in [
      (('--input', '../up'), "--input ../up: name the run"),
      (('--commit', 'nope'), "--commit nope: give the commit's full id"),
    ]:
      with self.subTest(args=args):
        result = self.qa('upload', 'junit.xml', '--project', 'kitefin/planner', *args, server=server, ci=False, QA_STORAGE='upload')
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(expected, result.stderr)
        self.assertNotIn('start_run(', result.stderr)

  def test_a_folder_is_sent_without_hidden_folders_and_earlier_runs(self):
    server = self.server()
    (self.work / '.git').mkdir()
    (self.work / '.git' / 'config').write_text('secret')
    self.assertEqual(self.qa('upload', 'junit.xml', server=server).returncode, 0)   # leaves a copy in output/
    self.assertTrue(list((self.work / 'output').rglob('junit.xml')))
    result = self.qa('upload', '.', '--input', 'all', server=server)
    self.assertEqual(result.returncode, 0, result.stderr)
    sent = sorted(name for name in server.files if '/' in name)
    self.assertEqual(sent, ['work/junit.xml'])
    self.assertEqual(server.outputs()[-1]['metrics']['tests'], 3)

  def test_a_log_of_yours_is_kept(self):
    server = self.server()
    (self.work / 'log.txt').write_text('the build log\n')
    result = self.qa('upload', 'junit.xml', 'log.txt', server=server)
    self.assertEqual(result.returncode, 0, result.stderr)
    self.assertEqual(server.files['log.txt'], b'the build log\n')

  def test_a_report_under_another_name_gets_a_hint(self):
    server = self.server()
    (self.work / 'results.xml').write_text(REPORT)
    (self.work / 'pom.xml').write_text('<project/>')
    result = self.qa('upload', 'results.xml', 'pom.xml', server=server)
    self.assertEqual(result.returncode, 0, result.stderr)
    self.assertIn('results.xml looks like a test report', result.stderr)
    self.assertIn('--as junit.xml', result.stderr)
    self.assertNotIn('pom.xml looks like', result.stderr)

  def test_several_reports_add_up_and_benchmarks_are_metrics(self):
    server = self.server()
    (self.work / 'TEST-b.xml').write_text(REPORT)
    benchmarks = (ROOT / 'tests/fixtures/benchmarks/pytest-benchmark.json').read_bytes()
    (self.work / 'pytest.benchmarks.json').write_bytes(benchmarks)
    result = self.qa('upload', 'junit.xml', 'TEST-b.xml', 'pytest.benchmarks.json', server=server)
    self.assertEqual(result.returncode, 0, result.stderr)
    metrics = server.outputs()[-1]['metrics']
    self.assertEqual((metrics['tests'], metrics['failed']), (6, 2))
    from qaboard.benchmarks import benchmark_metrics
    expected = benchmark_metrics(ROOT / 'tests/fixtures/benchmarks/pytest-benchmark.json')
    self.assertTrue(expected)
    for key, value in expected.items():
      self.assertAlmostEqual(metrics[key], float(value))
    # with their definitions, grouped so that the web app charts them over commits
    definitions = server.outputs()[-1]['metrics_definitions']
    self.assertEqual((definitions['failed']['group'], definitions['failed']['aggregation'], definitions['failed']['part_of']), ('Tests', 'sum', 'tests'))
    self.assertEqual(definitions['tests_test_codec_py_test_encode_64']['group'], 'Benchmarks/codec')

  def test_several_benchmark_files_are_told_apart(self):
    from qaboard.upload_command import read_metrics
    fixtures = ROOT / 'tests/fixtures/benchmarks'
    metrics = read_metrics({'pytest.benchmarks.json': fixtures / 'pytest-benchmark.json', 'gbench.benchmarks.json': fixtures / 'google-benchmark.json'})
    self.assertEqual(metrics['pytest_tests_test_codec_py_test_encode_64'].definition['group'], 'Benchmarks/pytest/codec')
    self.assertEqual(metrics['gbench_bm_checksum'].definition['group'], 'Benchmarks/gbench')

  def test_a_file_that_isnt_what_its_name_says_is_still_saved(self):
    server = self.server()
    (self.work / 'junit.xml').write_text('<html>not a report</html>')
    result = self.qa('upload', 'junit.xml', server=server)
    self.assertEqual(result.returncode, 0, result.stderr)
    self.assertIn('no metrics read from junit.xml', result.stderr)
    self.assertIn('junit.xml', server.files)

  def test_failed(self):
    server = self.server()
    result = self.qa('upload', 'junit.xml', '--failed', server=server)
    self.assertEqual(result.returncode, 0, result.stderr)
    self.assertTrue(server.outputs()[-1]['is_failed'])

  def test_what_it_refuses(self):
    server = self.server()
    (self.work / 'other').mkdir()
    (self.work / 'other' / 'junit.xml').write_text(REPORT)
    (self.work / 'empty').mkdir()
    (self.work / 'metrics.json').write_text('{"a": 1}')
    for args, message, ci in [
      (('upload', 'missing.xml'), 'missing.xml: no such file or folder', True),
      (('upload', 'missing-*.xml'), 'no such file or folder', True),
      (('upload', 'empty'), 'Nothing to upload', True),
      (('upload', 'junit.xml', 'other/junit.xml'), 'would both be saved as junit.xml', True),
      (('upload', 'junit.xml', 'other', '--as', 'x.xml'), '--as names one file or folder', True),
      (('upload', '--each', '--input', 'a', 'junit.xml'), "can't be used with --input", True),
      (('upload', 'junit.xml', '-m', 'accuracy'), 'give metrics as name=value', True),
      (('upload', 'junit.xml', 'other', '--project', 'kitefin/planner'), 'Name the run with --input', False),
      (('upload', 'junit.xml'), "Which project? Give --project group/repo", False),
      (('--offline', 'upload', 'junit.xml'), "can't be --offline", True),
      (('upload', 'metrics.json'), 'every run has a metrics.json that QA-Board writes', True),
      (('upload', 'junit.xml', '--as', '../x.xml'), "give a name in the run's folder", True),
      (('upload', '--each', 'junit.xml', 'other/junit.xml'), 'would be the same run', True),
    ]:
      with self.subTest(args=args):
        result = self.qa(*args, server=server, ci=ci)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn(message, result.stderr)
    self.assertEqual((server.outputs(), server.puts()), ([], []))
    result = self.qa('upload', 'junit.xml')
    self.assertNotEqual(result.returncode, 0)
    self.assertIn('Set QABOARD_URL', result.stderr)

  def test_fails_when_the_server_doesnt_have_the_files(self):
    for options, message, missing in [
      ({'uploads': False}, "doesn't accept uploaded files", "the run"),
      ({'file_errors': {'junit.xml': [(413, {'error': 'junit.xml is larger than what this server accepts', 'reason': 'too_large'})]}}, 'larger than what this server accepts', "all the files of the run"),
      ({'output_status': 403, 'output_error': {'error': 'You need the developer role', 'reason': 'missing_role'}}, 'You need the developer role', "the run"),
    ]:
      with self.subTest(options=options):
        result = self.qa('upload', 'junit.xml', server=self.server(**options))
        self.assertEqual(result.returncode, 1, result.stderr)
        self.assertIn(message, result.stderr)
        self.assertEqual(result.stderr.count(message), 1, result.stderr)  # said once
        self.assertIn(f"QA-Board doesn't have {missing} unit-tests/junit", result.stderr)

  def test_in_a_project_with_a_shared_storage(self):
    server = self.server()
    (self.project / 'junit.xml').write_text(REPORT)
    result = self.qa('--label', 'nightly', 'upload', 'junit.xml', cwd=self.project, server=server, ci=False)
    self.assertEqual(result.returncode, 0, result.stderr)
    finished = server.outputs()[-1]
    # like `qa --share`: outside the CI, in the user's own batch; the project is the qaboard.yaml's
    self.assertEqual((finished['project'], finished['commit_sha'], finished['batch_label']), ('kitefin/detector', self.commit, '@alice| nightly'))
    self.assertNotIn('storage', finished)
    self.assertEqual(server.files, {})
    run_dir = Path(finished['output_directory'])
    self.assertTrue(run_dir.is_relative_to(self.storage))
    self.assertEqual((run_dir / 'junit.xml').read_text(), REPORT)
    self.assertEqual(json.loads((run_dir / 'metrics.json').read_text())['tests'], 3)

  def test_where_the_shared_storage_isnt_mounted_the_files_are_sent(self):
    # e.g. a GitHub-hosted runner, for a project that keeps its shared storage
    missing = Path(self.tmp.name).resolve() / 'not-mounted'
    yaml = (self.project / 'qaboard.yaml').read_text().replace(f"storage: {self.storage}", f"storage: {missing}")
    (self.project / 'qaboard.yaml').write_text(yaml)
    server = self.server()
    (self.project / 'junit.xml').write_text(REPORT)
    result = self.qa('upload', 'junit.xml', cwd=self.project, server=server)
    self.assertEqual(result.returncode, 0, result.stderr)
    self.assertIn("the shared storage isn't here", result.stderr)
    started, finished = server.outputs()
    self.assertEqual((finished['project'], finished['storage']), ('kitefin/detector', 'upload'))
    self.assertNotIn('output_directory', finished)
    self.assertEqual(server.files['junit.xml'], REPORT.encode())
    self.assertFalse(any(missing.rglob('junit.xml')))


ENTRYPOINT = """
import os, time
def run(context):
  time.sleep(float(os.environ.get('RUN_SECONDS') or 0))
  (context.output_dir / "result.txt").write_text(context.input_path.read_text().upper())
  print("processed", context.input_path.name)
  return {"is_failed": False, "length": len(context.input_path.read_text())}
"""


class TestQaRunWithoutASharedStorage(QaTestCase):
  def setUp(self):
    super().setUp()
    (self.project / 'qaboard.yaml').write_text(
      "project:\n  name: kitefin/detector\n  url: git@example.com:kitefin/detector.git\n  entrypoint: qa_main.py\n"
      f"inputs:\n  database:\n    linux: {self.project}\n    windows: {self.project}\n"
    )
    (self.project / 'qa_main.py').write_text(ENTRYPOINT)
    (self.project / 'inputs').mkdir()
    (self.project / 'inputs' / 'a.txt').write_text('hello')
    git(self.project, 'add', '.')
    git(self.project, 'commit', '-q', '-m', 'An entrypoint')
    self.commit = git(self.project, 'rev-parse', 'HEAD')

  def qa_in_project(self, *args, server=None, **env):
    return self.qa(*args, cwd=self.project, server=server, ci=False, **env)

  def test_a_shared_run_sends_its_files(self):
    server = self.server()
    result = self.qa_in_project('--share', 'run', '-i', 'inputs/a.txt', server=server)
    self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
    started, finished = server.outputs()
    for body in (started, finished):
      self.assertEqual(body['storage'], 'upload')
      self.assertNotIn('output_directory', body)
    self.assertEqual((finished['is_pending'], finished['metrics']['length']), (False, 5))
    self.assertEqual(server.files['result.txt'], b'HELLO')
    self.assertIn(b'processed a.txt', server.files['log.txt'])
    for name in ('run.json', 'metrics.json', 'manifest.outputs.json'):
      self.assertIn(name, server.files)
    # saved in the project's output/ folder, like a run that isn't shared, and sent before the run shows as finished
    self.assertTrue(list((self.project / 'output').rglob('result.txt')))
    kinds = [method for method, path, *_ in server.requests if method == 'PUT' or path.rstrip('/') == '/api/v1/output']
    self.assertEqual((kinds[0], kinds[-1], kinds[-2]), ('POST', 'POST', 'PUT'))
    self.assertIn('files to QA-Board', result.stderr)

  def test_a_run_says_it_still_runs(self):
    server = self.server()
    result = self.qa_in_project('--share', 'run', '-i', 'inputs/a.txt', server=server, RUN_SECONDS='1.5', QA_HEARTBEAT_INTERVAL='0.3')
    self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
    started, finished = server.outputs()
    self.assertTrue(started['heartbeat'])
    self.assertNotIn('heartbeat', finished)
    self.assertGreaterEqual(len(server.progress()), 2)
    # no metrics: only what the run uses of its machine so far (qaboard/system_metrics.py)
    self.assertTrue(all(set(body) == {'resources'} for body in server.progress()))
    self.assertEqual(finished['data']['resources']['version'], 1)

  def test_runs_are_shared_by_default(self):
    server = self.server()
    result = self.qa_in_project('run', '-i', 'inputs/a.txt', server=server)
    self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
    self.assertEqual({body['batch_label'] for body in server.outputs()}, {'@alice| default'})
    self.assertEqual(len(server.puts('result.txt')), 1)

  def test_a_local_run_sends_nothing(self):
    server = self.server()
    result = self.qa_in_project('--offline', 'run', '-i', 'inputs/a.txt', server=server)
    self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
    self.assertEqual((server.outputs(), server.puts()), ([], []))
    # --share is the default: scripts that still give it work
    result = self.qa_in_project('--share', '--offline', 'run', '-i', 'inputs/a.txt', server=server)
    self.assertEqual(result.returncode, 0, result.stderr + result.stdout)

  def test_without_a_server_runs_stay_here_and_it_says_so(self):
    result = self.qa_in_project('run', '-i', 'inputs/a.txt')
    self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
    self.assertIn('results stay in output/, not shown in QA-Board (no QA-Board server is set', result.stderr)
    self.assertNotIn('not sure where', result.stderr)
    self.assertNotIn('stay in output/', self.qa_in_project('--offline', 'run', '-i', 'inputs/a.txt').stderr)

  def test_a_local_batch_runs_locally(self):
    # the runs `qa batch` starts decide as it did, not by themselves
    server = self.server()
    (self.project / 'batches.yaml').write_text("texts:\n  inputs:\n    - inputs/a.txt\n")
    result = self.qa_in_project('--offline', 'batch', '--batches-file', 'batches.yaml', 'texts', '--runner=local', server=server)
    self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
    self.assertEqual((server.outputs(), server.puts()), ([], []))
    self.assertTrue((self.project / 'output').is_dir())
    # a batch that can't share, without a server: its runs stay here too
    result = self.qa_in_project('batch', '--batches-file', 'batches.yaml', 'texts', '--runner=local')
    self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
    self.assertEqual(result.stderr.count('results stay in output/'), 1, result.stderr)

  def test_a_batch_sends_each_run(self):
    server = self.server()
    (self.project / 'inputs' / 'b.txt').write_text('hi')
    (self.project / 'batches.yaml').write_text("texts:\n  inputs:\n    - inputs/a.txt\n    - inputs/b.txt\n")
    result = self.qa_in_project('--share', 'batch', '--batches-file', 'batches.yaml', 'texts', '--runner=local', server=server)
    self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
    finished = [body for body in server.outputs() if not body.get('is_pending')]
    self.assertEqual(sorted(body['metrics']['length'] for body in finished), [2, 5])
    self.assertEqual(len([1 for path, _, content in server.puts('result.txt')]), 2)

  def test_files_that_cant_be_sent_fail_the_ci_job(self):
    too_large = (413, {'error': 'result.txt is larger than what this server accepts', 'reason': 'too_large'})
    server = self.server(file_errors={'result.txt': [too_large]})
    result = self.qa_in_project('run', '-i', 'inputs/a.txt', server=server, CI='true', GITHUB_SHA=self.commit)
    self.assertEqual(result.returncode, 1, result.stderr + result.stdout)
    self.assertIn("QA-Board doesn't have all the files of the run", result.stderr)
    self.assertIn('larger than what this server accepts', result.stderr)
    self.assertEqual(server.outputs()[-1]['data']['files_missing'], 1)

  def test_the_servers_log_has_how_the_run_ended(self):
    server = self.server()
    (self.project / 'qa_main.py').write_text("def run(context):\n  print('working')\n  return {'is_failed': True, 'length': 1}\n")
    result = self.qa_in_project('--share', 'run', '-i', 'inputs/a.txt', server=server)
    self.assertEqual(result.returncode, 1)
    self.assertIn(b'The run has failed', server.files['log.txt'])
    self.assertIn(b"'length': 1", server.files['log.txt'])

  def test_a_run_that_exits_still_sends_what_it_did(self):
    server = self.server()
    (self.project / 'qa_main.py').write_text("import sys\ndef run(context):\n  (context.output_dir / 'partial.txt').write_text('x')\n  print('about to exit')\n  sys.exit(3)\n")
    result = self.qa_in_project('--share', 'run', '-i', 'inputs/a.txt', server=server)
    self.assertEqual(result.returncode, 1, result.stderr + result.stdout)
    self.assertIn('exited with 3', result.stdout + result.stderr)
    self.assertTrue(server.outputs()[-1]['metrics']['is_failed'])
    self.assertFalse(server.outputs()[-1]['is_pending'])
    self.assertEqual(server.files['partial.txt'], b'x')
    self.assertIn(b'about to exit', server.files['log.txt'])

  def test_in_the_ci_a_server_that_doesnt_accept_files_fails_the_job(self):
    server = self.server(uploads=False)
    result = self.qa_in_project('run', '-i', 'inputs/a.txt', server=server, CI='true', GITHUB_SHA=self.commit)
    self.assertEqual(result.returncode, 1, result.stderr + result.stdout)
    self.assertEqual(result.stderr.count("doesn't accept uploaded files"), 1, result.stderr)
    self.assertIn('ERROR: QA-Board refused the results (uploads_disabled)', result.stderr)
    self.assertIn('Set `storage` in qaboard.yaml', result.stderr)
    self.assertNotIn('qaboard_config', result.stderr)   # not the request we sent
    self.assertNotIn('processed a.txt', result.stdout)  # in CI, results the server refuses aren't computed

  def test_nothing_needs_a_shared_storage(self):
    # save-artifacts sends the commit, then its artifacts (qaboard/commit_artifacts.py)
    from .test_commit_artifacts import FakeServer as ArtifactsServer
    server = ArtifactsServer(subproject='', project='kitefin/detector')
    self.addCleanup(server.close)
    result = self.qa_in_project('save-artifacts', server=server)
    self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
    self.assertEqual(server.commits[0]['git_commit_sha'], self.commit)
    self.assertEqual(server.files['qaboard.yaml'], (self.project / 'qaboard.yaml').read_bytes())
    self.assertIn('qaboard.yaml', json.loads(server.files['manifests/__qaboard.yaml.json']))
    self.assertIn('Sent 1 file (', result.stdout)
    self.assertIn(f'/kitefin/detector/commit/{self.commit}', result.stdout)
    # check-bit-accuracy compares the reference's manifests, optimize reads metrics from the API
    result = self.qa_in_project('check-bit-accuracy', '--batch', 'texts')
    self.assertNotIn('storage shared', result.stderr)
    self.assertIn('There are no runs to compare', result.stderr)


class TestTrendsUrl(unittest.TestCase):
  """qa upload prints where the branch's test reports and benchmarks show over its commits"""
  def run_like(self, **kwargs):
    from types import SimpleNamespace
    fields = dict(server='https://qa.example', project='group/sdk', sent=True, _setup=SimpleNamespace(commit_data={'commit_branch': 'feature/x'}))
    return SimpleNamespace(**{**fields, **kwargs})

  def test_for_grouped_metrics(self):
    from qaboard.metrics import Metric
    from qaboard.upload_command import trends_url
    grouped = {'tests': Metric(3, group='Tests')}
    self.assertEqual(trends_url(self.run_like(), grouped), 'https://qa.example/group/sdk/trends/feature/x')
    # nothing to see there: other metrics, a run the server doesn't have, no branch
    self.assertIsNone(trends_url(self.run_like(), {'psnr': Metric(30)}))
    self.assertIsNone(trends_url(self.run_like(sent=False), grouped))
    from types import SimpleNamespace
    self.assertIsNone(trends_url(self.run_like(_setup=SimpleNamespace(commit_data={})), grouped))
