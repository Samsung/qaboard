import os
import json
from pathlib import Path

import yaml
import unittest
import click
from click.testing import CliRunner

os.environ['QA_TESTING'] = 'true'

# Missing:
# - tests with --share
# - tests with CI=ON CI_COMMIT=XXXXXX


class TestQaCliSubproject(unittest.TestCase):
  @classmethod
  def setUpClass(self):
    self.previous_cwd = os.getcwd()
    os.chdir(Path(__file__).resolve().parent.parent / 'qaboard/sample_project' / 'subproject')
    # we create some files...
    os.system("mkdir -p cli_tests/dir; touch cli_tests/a.jpg; touch cli_tests/b.jpg; touch cli_tests/dir/c.jpg")
    database = str(Path())
    images = {'images': {
      "globs": ['*.jpg'],
      "inputs": ['cli_tests'],
      "database": {"linux": database, "windows": database} 
      }
    }
    # TODO: use a temp file?
    with Path('../sub.batches.yaml').open('w') as f:
      f.write(yaml.dump(images))
    os.environ['QA_DATABASE'] = database
    os.environ['QA_OFFLINE'] = 'true'
    os.environ['QA_CI_ROOT'] = '/tmp'

  @classmethod
  def TearDownClass(self):
    os.chdir(self.previous_cwd)

  def setUp(self):
    from importlib import reload
    import qaboard
    qaboard = reload(qaboard)
    def qa_(*argv):
      runner = CliRunner(mix_stderr=False)
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
    result = self.qa('run', '-i', 'cli_tests/a.jpg', 'echo "{absolute_input_path} => {output_directory}"')
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
    result = self.qa('batch', '--batches-file', 'sub.batches.yaml', 'images', '--runner=local', 'echo "{absolute_input_path} => {output_directory}"')
    # print('stdout:', result.stdout)
    # print('stderr:', result.stderr)
    assert result.exit_code == 0

  @unittest.skip("Not tested in the OSS version yet")
  def test_sub_runner_lsf(self):
    result = self.qa('batch', '--batches-file', 'sub.batches.yaml', 'images', '--runner=lsf', 'echo "{absolute_input_path} => {output_directory}"')
    assert result.exit_code == 0


if __name__ == '__main__':
  unittest.main()
