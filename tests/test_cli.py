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


class TestQaCli(unittest.TestCase):
  @classmethod
  def setUpClass(self):
    self.previous_cwd = os.getcwd()
    os.chdir(Path(__file__).resolve().parent.parent / 'qaboard/sample_project')
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
    with Path('image.batches.yaml').open('w') as f:
      f.write(yaml.dump(images))
    os.environ['QA_DATABASE'] = database
    os.environ['QA_OFFLINE'] = 'true'
    os.environ['QA_STORAGE'] = '/tmp'

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


  def test_help(self):
    result = self.qa('--help')
    assert result.exit_code == 0
    assert 'Usage:' in result.output

  def test_run(self):
    result = self.qa('run', '-i', 'cli_tests/a.jpg', 'echo "{absolute_input_path} => {output_directory}"')
    assert result.exit_code == 0
    assert 'a.jpg =>' in result.output
    assert "'is_failed': False" in result.output

  def test_get(self):
    result = self.qa('get', 'commit_id')
    assert result.exit_code == 0

  def test_batch(self):
    result = self.qa('--dryrun', 'batch', 'cli_tests')
    assert result.exit_code == 0

  def test_batch_list(self):
    result = self.qa('--dryrun', 'batch', '--batches-file', 'image.batches.yaml', 'images', '--list')
    tests = json.loads(result.stdout)
    assert len(tests) == 3
    assert result.exit_code == 0

  def test_batch_list_output_dirs(self):
    result = self.qa('--dryrun', 'batch', '--batches-file', 'image.batches.yaml', 'images', '--list-output-dirs')
    output_dirs = result.stdout.splitlines()
    assert len(output_dirs) == 3
    assert result.exit_code == 0

  def test_batch_list_inputs(self):
    result = self.qa('--dryrun', 'batch', '--batches-file', 'image.batches.yaml', 'images', '--list-inputs')
    output_dirs = result.stdout.splitlines()
    assert len(output_dirs) == 3
    assert result.exit_code == 0

  def test_runner_local(self):
    result = self.qa('batch', '--batches-file', 'image.batches.yaml', 'images', '--runner=local', 'echo "{absolute_input_path} => {output_directory}"')
    print('stdout:', result.stdout)
    print('stderr:', result.stderr)
    assert result.exit_code == 0
    # we test with --share, but really being offline is a problem here..
    result = self.qa('--share', 'batch', '--batches-file', 'image.batches.yaml', 'images', '--runner=local', 'echo "{absolute_input_path} => {output_directory}"')
    print('stdout:', result.stdout)
    print('stderr:', result.stderr)
    assert result.exit_code == 0


  @unittest.skip("Not tested in the OSS version yet")
  def test_runner_lsf(self):
    result = self.qa('batch', '--batches-file', 'image.batches.yaml', 'images', '--runner=lsf', 'echo "{absolute_input_path} => {output_directory}"')
    assert result.exit_code == 0
    # we also test subprojects
    os.chdir('subproject')
    result = self.qa('batch', '--batches-file', 'image.batches.yaml', 'images', '--runner=local', 'echo "{absolute_input_path} => {output_directory}"')

  @unittest.skip("FIXME: decide what to do by default with artifacts in the OSS version")
  def test_save_artifacts(self):
    result = self.qa('save-artifacts')
    print('stdout:', result.stdout)
    # print('stderr:', result.stderr)
    assert result.exit_code == 0
    # => Gitlab/QA-Board: 404: Project not found

  def test_init(self):
    import tempfile
    prev = os.getcwd()
    with tempfile.TemporaryDirectory() as tmp_dir:
      os.chdir(tmp_dir)
      assert not os.system('git init')
      assert not os.system('echo OK > file')
      assert not os.system('git add file')
      assert not os.system('git commit -m "first commit"')
      # assert not os.system('git remote add origin git@gitlab-srv:common-infrastructure/qaboard.git')
      # assert not os.system('git remote add origin git@github.com:Samsung/qaboard.git')
      assert not os.system('git remote add origin https://github.com/Samsung/qaboard.git')
      assert not os.system('qa init')
      assert not os.system('qa get project')
    os.chdir(prev)


  @unittest.skip("tendency to fail for no reason")
  def test_batch_lsf_interrupt(self):
      # https://stackoverflow.com/a/59303823/5993501
      from multiprocessing import Queue, Process
      from threading import Timer
      from time import sleep
      from os import kill, getpid
      from signal import SIGINT

      q = Queue()
      # Running out app in SubProcess and after a while using signal sending 
      # SIGINT, results passed back via channel/queue  
      def background():
          Timer(2, lambda: kill(getpid(), SIGINT)).start()
          result = self.qa('batch', '--batches-file', 'image.batches.yaml', 'images', '--runner=lsf', 'echo "{absolute_input_path} => {output_directory}"')
          q.put(('exit_code', result.exit_code))
          q.put(('output', result.output))
      p = Process(target=background)
      p.start()
      results = {}
      while p.is_alive():
          sleep(0.1)
      else:
          while not q.empty():
              key, value = q.get()
              results[key] = value
      # print(results['output'])
      assert "Aborted." in results['output']
      # we could also check for "bkill" if we run with QA_BATCH_VERBOSE=1



if __name__ == '__main__':
  unittest.main()
