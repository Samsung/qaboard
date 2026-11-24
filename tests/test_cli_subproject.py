import os
import shutil
import json
from importlib import import_module, reload
from pathlib import Path

import yaml
import unittest
import click
from click.testing import CliRunner

from qaboard._testing import reset_process_state
from tests.sample_project import forget_runs, sample_project_class_fixture

os.environ['QA_TESTING'] = 'true'

# Missing:
# - tests with --share
# - tests with CI=ON CI_COMMIT=XXXXXX


class TestQaCliSubproject(unittest.TestCase):
  @classmethod
  def setUpClass(cls):
    # a copy of qaboard/sample_project, committed in a git repository of its own, with a storage next to it
    database = str(Path())
    images = {'images': {
      "globs": ['*.jpg'],
      "inputs": ['cli_tests'],
      "database": {"linux": database, "windows": database},
      }
    }
    files = {'sub.batches.yaml': yaml.dump(images)}
    cls.project_dir = sample_project_class_fixture(cls, files, QA_DATABASE=database, QA_OFFLINE='true')
    cls.subproject_dir = cls.project_dir / 'subproject'

  def setUp(self):
    forget_runs(self)
    # the qa CLI chdirs to the project root without restoring the cwd
    os.chdir(self.subproject_dir)
    self.addCleanup(reset_process_state)
    # qaboard.config resolves the project from the cwd, and qa.py binds it at import time
    reload(import_module('qaboard.config'))
    reload(import_module('qaboard.qa'))
    import qaboard
    qaboard = reload(qaboard)
    def qa_(*argv):
      # as in a new process: earlier commands, here or in other tests, kept nothing
      reset_process_state()
      runner = CliRunner()
      result = runner.invoke(qaboard.qa, argv, obj={}, auto_envvar_prefix='QA', color=False)
      if result.exception:
        print("EXCEPTION: ", result.exception)
      if result.exc_info and result.exception:
        import traceback
        exc_type, exc_value, exc_traceback = result.exc_info
        click.secho(''.join(traceback.format_exception(exc_type, exc_value, exc_traceback)), fg='red')
        # traceback.print_exception(exc_type, exc_value, exc_traceback)
        # traceback.print_tb(exc_traceback)
      if result.exit_code:
        print("EXIT CODE:", result.exit_code)
        print('stdout:', result.stdout)
        print('stderr:', result.stderr)
      return result
    self.qa = qa_

  def test_sub_run(self):
    result = self.qa('run', '-i', 'cli_tests/a.jpg', 'echo "{input_path} => {output_dir}"')
    assert result.exit_code == 0
    assert 'a.jpg =>' in result.output
    assert "'is_failed': False" in result.output

  def test_sub_get(self):
    result = self.qa('get', 'subproject')
    assert 'subproject' in result.stdout
    assert result.exit_code == 0

  def test_sub_batch(self):
    result = self.qa('--dryrun', 'batch', 'cli_tests')
    assert result.exit_code == 0

  def test_sub_save_artifacts(self):
    result = self.qa('save-artifacts')
    from qaboard.config import artifacts_commit
    manifest_path = artifacts_commit / 'manifests' / '__sub-qaboard.yaml.json'
    # without its qaboard.yaml, runs started from the artifacts would use the parent project's configuration
    # (no cleanup: the folder also holds the outputs of the tests running in parallel)
    manifest = json.loads(manifest_path.read_text())
    assert 'subproject/qaboard.yaml' in manifest, manifest
    assert 'qaboard.yaml' in manifest, manifest

  def test_sub_batch_list(self):
    result = self.qa('--dryrun', 'batch', '--batches-file', 'sub.batches.yaml', 'images', '--list')
    tests = json.loads(result.stdout)
    assert len(tests) == 3
    assert result.exit_code == 0

  def test_sub_batch_list_output_dirs(self):
    result = self.qa('--dryrun', 'batch', '--batches-file', 'sub.batches.yaml', 'images', '--list-output-dirs')
    output_dirs = result.stdout.splitlines()
    assert len(output_dirs) == 3
    assert result.exit_code == 0

  def test_sub_batch_list_inputs(self):
    result = self.qa('--dryrun', 'batch', '--batches-file', 'sub.batches.yaml', 'images', '--list-inputs')
    output_dirs = result.stdout.splitlines()
    assert len(output_dirs) == 3
    assert result.exit_code == 0

  def test_sub_runner_local(self):
    result = self.qa('batch', '--batches-file', 'sub.batches.yaml', 'images', '--runner=local', 'echo "{input_path} => {output_dir}"')
    # print('stdout:', result.stdout)
    # print('stderr:', result.stderr)
    assert result.exit_code == 0

  @unittest.skipUnless(shutil.which('bsub'), 'needs LSF (bsub)')
  def test_sub_runner_lsf(self):
    result = self.qa('batch', '--batches-file', 'sub.batches.yaml', 'images', '--runner=lsf', 'echo "{input_path} => {output_dir}"')
    assert result.exit_code == 0


if __name__ == '__main__':
  unittest.main()
