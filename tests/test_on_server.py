"""
`qa batch --commit` and `qa optimize --commit`: QA-Board starts the batch on the commit (qaboard/on_server.py)
"""
import os
import json
import subprocess
import unittest
from importlib import import_module, reload
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest import mock

import click
from click.testing import CliRunner

from tests.test_auth import response

os.environ['QA_TESTING'] = 'true'


def git(cwd, *args):
  return subprocess.run(["git", "-c", "user.name=t", "-c", "user.email=t@example.com", *args], cwd=cwd, check=True,
                        stdout=subprocess.PIPE, stderr=subprocess.PIPE, encoding='utf-8').stdout.strip()


class TestGit(unittest.TestCase):
  """Finding the commit, and what differs locally, with git"""
  def setUp(self):
    tmp = TemporaryDirectory()
    self.addCleanup(tmp.cleanup)
    self.remote, self.repo = Path(tmp.name) / "remote.git", Path(tmp.name) / "repo"
    git(tmp.name, "init", "-q", "--bare", "-b", "main", str(self.remote))
    git(tmp.name, "clone", "-q", str(self.remote), str(self.repo))
    git(self.repo, "checkout", "-q", "-b", "main")
    (self.repo / "batches.yaml").write_text("night: {inputs: [a]}\n")
    git(self.repo, "add", ".")
    git(self.repo, "commit", "-q", "-m", "first")
    git(self.repo, "push", "-q", "-u", "origin", "main")
    self.pushed = git(self.repo, "rev-parse", "HEAD")

  def test_resolves_pushed_commits(self):
    from qaboard.on_server import resolve_commit
    assert resolve_commit("main", cwd=self.repo) == (self.pushed, [])
    assert resolve_commit(self.pushed[:8], cwd=self.repo) == (self.pushed, [])

  def test_warns_about_commits_that_were_not_pushed(self):
    from qaboard.on_server import resolve_commit
    git(self.repo, "commit", "-q", "--allow-empty", "-m", "local")
    local = git(self.repo, "rev-parse", "HEAD")
    sha, warnings = resolve_commit("main", cwd=self.repo)
    assert sha == local
    assert f"Your branch main is at {local[:10]}, but origin/main is at {self.pushed[:10]}" in warnings[0]
    assert "on none of the remote branches you fetched" in warnings[1]

  def test_unknown_commits(self):
    from qaboard.on_server import resolve_commit, StartError
    with self.assertRaisesRegex(StartError, "Unknown commit 'nope'.*git fetch"):
      resolve_commit("nope", cwd=self.repo)
    # QA-Board may know commits that were not fetched
    assert resolve_commit("ABCDEF1234", cwd=self.repo) == ("abcdef1234", [])
    with TemporaryDirectory() as outside:
      with self.assertRaisesRegex(StartError, "from your repository"):
        resolve_commit("main", cwd=Path(outside))

  def test_local_batch_files_that_differ_from_the_commits(self):
    from qaboard.on_server import changed_batches_files
    files = [Path("batches.yaml"), Path("new.yaml"), Path("missing.yaml"), Path("/abs/outside.yaml")]
    assert changed_batches_files(self.pushed, files, self.repo) == []
    (self.repo / "batches.yaml").write_text("night: {inputs: [b]}\n")
    (self.repo / "new.yaml").write_text("mine: {}\n")
    assert changed_batches_files(self.pushed, files, self.repo) == [Path("batches.yaml"), Path("new.yaml")]


class TestHelpers(unittest.TestCase):
  def test_batch_files_to_send(self):
    from qaboard.on_server import batches_file_to_send, StartError
    with TemporaryDirectory() as tmp:
      root, elsewhere = Path(tmp) / "project", Path(tmp) / "elsewhere"
      (root / "qa").mkdir(parents=True)
      elsewhere.mkdir()
      (root / "qa/local.yaml").write_text("a: {}\n")
      (elsewhere / "mine.yaml").write_text("b: {}\n")
      # like `qa batch`, relative to the root qaboard.yaml, else to where qa was started
      assert batches_file_to_send(Path("qa/local.yaml"), root, elsewhere) == {"path": "qa/local.yaml", "content": "a: {}\n"}
      assert batches_file_to_send(Path("mine.yaml"), root, elsewhere) == {"path": "mine.yaml", "content": "b: {}\n"}
      assert batches_file_to_send(elsewhere / "mine.yaml", root) == {"path": "mine.yaml", "content": "b: {}\n"}
      with self.assertRaisesRegex(StartError, "Could not find the batch file nope.yaml"):
        batches_file_to_send(Path("nope.yaml"), root, elsewhere)

  def test_describe_definitions(self):
    from qaboard.on_server import describe_definitions
    assert describe_definitions([
      {"name": "night", "files": ["qa/batches.yaml", "extra-batches.yml", "local.yaml"], "sources": ["commit", "qaboard", "sent"]},
      {"name": "smoke", "files": ["qa/batches.yaml"], "sources": ["commit"]},
    ]) == [
      "night: qa/batches.yaml, QA-Board's extra-batches.yml, then local.yaml (sent), which wins",
      "smoke: qa/batches.yaml",
    ]

  def test_request_body(self):
    from qaboard.on_server import request_body, StartError
    assert request_body("x", None, ["a", "b"], [], None, None) == {"batch_label": "x", "selected_group": ["a", "b"], "notify": False}
    body = request_body("x", "linux", ["a"], [{"path": "l.yaml", "content": ""}], {"search_type": "grid"}, "run")
    assert body["platform"] == "linux" and body["batches_files"] and body["tuning_search"] == {"search_type": "grid"} and body["overwrite"] is True
    assert request_body("x", None, ["a"], [], None, "sync")["overwrite"] is False
    with self.assertRaisesRegex(StartError, "only be run.*or sync"):
      request_body("x", None, ["a"], [], None, "skip")

  def test_missing_artifacts(self):
    from qaboard.on_server import check_artifacts, StartError
    check_artifacts({"ok": True})
    # QA-Board asks the CI to recreate them when we start
    check_artifacts({"ok": False, "problems": ["Deleted."], "recreate": "the GitLab CI job build"})
    with self.assertRaisesRegex(StartError, "being recreated"):
      check_artifacts({"ok": False, "problems": ["Deleted."], "recreating": True, "recreate": "the GitLab CI job build"})
    # it would only restore the source code: runs that need binaries would fail
    with self.assertRaisesRegex(StartError, "wait for its CI.*recreate_artifacts"):
      check_artifacts({"ok": False, "problems": ["Deleted."]})
    with self.assertRaisesRegex(StartError, "recreate_artifacts"):
      check_artifacts({"ok": False, "problems": ["Deleted."], "recreate": "x", "recreate_errors": ["unknown ${variable}"]})


CHECK_OK = {"errors": [], "warnings": [], "artifacts": {"ok": True}, "batches": ["images"],
            "definitions": [{"name": "images", "files": ["image.batches.yaml"], "sources": ["sent"]}]}


class TestCli(unittest.TestCase):
  """`qa batch --commit` in the sample project, with a fake server"""
  @classmethod
  def setUpClass(cls):
    cls.previous_cwd = os.getcwd()
    cls.project_dir = Path(__file__).resolve().parent.parent / 'qaboard/sample_project'
    cls.head = git(cls.project_dir, "rev-parse", "HEAD")

  @classmethod
  def tearDownClass(cls):
    os.chdir(cls.previous_cwd)

  def setUp(self):
    os.chdir(self.project_dir)
    (self.project_dir / 'local.batches.yaml').write_text("images: {inputs: [cli_tests]}\n")
    self.addCleanup((self.project_dir / 'local.batches.yaml').unlink)
    (self.project_dir / 'tuning.yaml').write_text("search_type: grid\nparameter_search: {threshold: [1, 2]}\n")
    self.addCleanup((self.project_dir / 'tuning.yaml').unlink)
    self.calls = []
    storage = TemporaryDirectory()
    self.addCleanup(storage.cleanup)
    self.storage = storage.name

  def qa(self, *argv, check=CHECK_OK, started=(200, {"submission": {"status": "submitted"}}), env=None, obj=None):
    responses = {"/batch/check": check if isinstance(check, tuple) else (200, check), "/batch": started}
    def post(url, params=None, json=None, **kwargs):
      self.calls.append({"url": url, "params": params, "json": json})
      status, body = next(v for k, v in responses.items() if url.endswith(k))
      return response(status, body)
    environ = {k: v for k, v in os.environ.items() if not k.startswith(('QA_', 'QABOARD_')) or k == 'QA_TESTING'}
    environ.update({'QABOARD_URL': 'http://qaboard.example.com', 'QA_STORAGE': self.storage, **(env or {})})
    with mock.patch('requests.post', side_effect=post), mock.patch.dict(os.environ, environ, clear=True):
      # they read the server and the project when imported
      for module in ('qaboard.api', 'qaboard.config', 'qaboard.qa'):
        reload(import_module(module))
      import qaboard
      qaboard = reload(qaboard)
      result = CliRunner().invoke(qaboard.qa, list(argv), obj=obj or {}, auto_envvar_prefix='QA', color=False)
    result.unstyled_output = click.unstyle(result.output)
    return result

  def test_starts_the_batch_and_prints_its_page(self):
    result = self.qa('--label', 'my tuning', 'batch', '--commit', self.head, 'images', '--batch', 'more',
                     '--batches-file', 'local.batches.yaml', '--tuning-search-file', 'tuning.yaml', '--action-on-existing', 'run')
    assert result.exit_code == 0, result.output
    check, start = self.calls
    assert check["url"] == f"http://qaboard.example.com/api/v1/commit/{self.head}/batch/check"
    assert start["url"] == f"http://qaboard.example.com/api/v1/commit/{self.head}/batch"
    assert check["params"] == {"project": "user/sample_project"}
    assert start["json"] == check["json"] == {
      "batch_label": "my tuning",
      "selected_group": ["images", "more"],
      "notify": False,
      "batches_files": [{"path": "local.batches.yaml", "content": "images: {inputs: [cli_tests]}\n"}],
      "tuning_search": {"search_type": "grid", "parameter_search": {"threshold": [1, 2]}},
      "overwrite": True,
    }
    # scripts read the page on stdout
    assert result.stdout.strip() == f"http://qaboard.example.com/user/sample_project/commit/{self.head}?batch=my%20tuning"
    # where the server says the batches are defined
    assert "images: image.batches.yaml (sent)" in result.unstyled_output
    assert f"Started 'my tuning' on {self.head[:10]}" in result.unstyled_output

  def test_defaults_are_the_servers(self):
    # inputs.batches are the commit's, existing runs are kept, the platform is the commit's default
    result = self.qa('batch', '--commit', self.head, 'images', env={'QA_RUNNER': 'lsf', 'QA_BATCH_RUNNER': 'lsf', 'QA_LABEL': 'sweep', 'QA_SHARE': 'true'})
    assert result.exit_code == 0, result.output
    # not "@user| sweep" like `qa --share` would: these are the commit's results
    assert self.calls[0]["json"] == {"batch_label": "sweep", "selected_group": ["images"], "notify": False}

  def test_needs_a_label(self):
    # else the runs would be added to the commit's CI results
    result = self.qa('batch', '--commit', self.head, 'images')
    assert result.exit_code == 1 and "Name the batch with --label" in result.unstyled_output and "'default'" in result.unstyled_output
    assert self.calls == []

  def test_an_empty_commit_is_refused(self):
    # e.g. --commit "$SHA" without SHA: it must not run locally
    result = self.qa('--label', 'x', 'batch', '--commit', '', 'images')
    assert result.exit_code == 1 and "--commit is empty" in result.unstyled_output
    assert self.calls == []

  def test_doesnt_need_the_storage(self):
    from qaboard.config import ci_env_variables
    for command in (['batch', '--commit', self.head, 'images'], ['optimize', '--commit', self.head, '--batch', 'images', '--config-file', 'tuning.yaml']):
      result = self.qa('--label', 'x', *command, env={'QA_STORAGE': '/proc/no-storage-here', 'CI': 'true'})
      assert result.exit_code == 0, result.output
      assert "storage" not in result.unstyled_output.lower(), result.output
    assert 'CI' in ci_env_variables

  def test_bad_tuning_searches_are_clean_errors(self):
    result = self.qa('--label', 'x', 'batch', '--commit', self.head, 'images', '--tuning-search', '{bad')
    assert result.exit_code == 1 and result.unstyled_output.startswith("ERROR: Invalid tuning search") and "Traceback" not in result.output
    result = self.qa('--label', 'x', 'batch', '--commit', self.head, 'images', '--tuning-search-file', 'nope.yaml')
    assert result.exit_code == 1 and "Could not find the tuning search file nope.yaml" in result.unstyled_output
    assert self.calls == []

  def test_files_relative_to_where_qa_was_started(self):
    with TemporaryDirectory() as elsewhere:
      (Path(elsewhere) / 't.yaml').write_text("parameter_search: {a: [1]}\n")
      result = self.qa('--label', 'x', 'batch', '--commit', self.head, 'images', '--tuning-search-file', 't.yaml', obj={"previous_cwd": elsewhere})
    assert result.exit_code == 0, result.output
    assert self.calls[0]["json"]["tuning_search"] == {"parameter_search": {"a": [1]}}

  def test_dryrun_only_checks(self):
    result = self.qa('--dryrun', '--label', 'x', 'batch', '--commit', self.head, 'images')
    assert result.exit_code == 0, result.output
    assert [c["url"].rsplit("/", 1)[1] for c in self.calls] == ["check"]
    assert result.stdout == ""
    assert "nothing started" in result.unstyled_output

  def test_refuses_options_that_dont_apply(self):
    for argv in (['batch', '--runner', 'local'], ['batch', '--list'], ['--share', 'batch'], ['-c', 'base', 'batch'], ['--tuning', '{}', 'batch']):
      result = self.qa('--label', 'x', *argv[:argv.index('batch') + 1], '--commit', self.head, 'images', *argv[argv.index('batch') + 1:])
      assert result.exit_code == 1, (argv, result.output)
      assert "can't be used with --commit" in result.unstyled_output, (argv, result.output)
      assert self.calls == []
    result = self.qa('--label', 'x', 'batch', '--commit', self.head, 'images', obj={"forwarded_args": ["--verbose"]})
    assert result.exit_code == 1 and "can't forward arguments" in result.unstyled_output

  def test_says_why_the_server_refuses(self):
    error = "Unknown batch: imgs. Defined: images"
    result = self.qa('--label', 'x', 'batch', '--commit', self.head, 'imgs', check={**CHECK_OK, "errors": [error], "warnings": ["The entrypoint is not in the artifacts."]})
    assert result.exit_code == 1
    assert f"ERROR: {error}" in result.unstyled_output and "WARNING: The entrypoint is not in the artifacts." in result.unstyled_output
    assert len(self.calls) == 1
    unknown = "QA-Board doesn't know the commit abc1234 in user/sample_project."
    result = self.qa('--label', 'x', 'batch', '--commit', self.head, 'images', check=(404, {"error": unknown, "errors": [unknown]}))
    assert result.exit_code == 1 and f"ERROR: {unknown}" in result.unstyled_output
    # e.g. QA-Board asked the CI to recreate the artifacts
    result = self.qa('--label', 'x', 'batch', '--commit', self.head, 'images', started=(409, {"error": "Asked the GitLab CI job build to recreate the artifacts. Try again once it is done.", "artifacts": {"status": "recreating"}}))
    # scripts can try again later
    assert result.exit_code == 2 and "Try again once it is done" in result.unstyled_output
    assert result.stdout == ""

  def test_needs_to_sign_in(self):
    result = self.qa('--label', 'x', 'batch', '--commit', self.head, 'images', check=(401, {"error": "Sign in to do this.", "reason": "sign_in_required"}))
    assert result.exit_code == 1
    assert "QA-Board refused to start the batch: Sign in to do this." in result.unstyled_output

  def test_missing_artifacts_are_not_started(self):
    missing = {"ok": False, "problems": ["The artifacts were deleted."], "recreate_docs": "http://qaboard.example.com/docs/x#recreating-artifacts"}
    warning = "The artifacts are missing: [...] When you start, QA-Board will try to restore them from the source code"
    result = self.qa('--label', 'x', 'batch', '--commit', self.head, 'images', check={**CHECK_OK, "artifacts": missing, "warnings": [warning]})
    assert result.exit_code == 1 and "set `recreate_artifacts` in qaboard.yaml (http://qaboard.example.com/docs/x#recreating-artifacts)" in result.unstyled_output
    # we don't say the server would restore them: we don't start
    assert "When you start" not in result.unstyled_output
    assert len(self.calls) == 1
    result = self.qa('--label', 'x', 'batch', '--commit', self.head, 'images', check={**CHECK_OK, "artifacts": {**missing, "recreating": True}})
    assert result.exit_code == 2 and "being recreated" in result.unstyled_output

  def test_optimize(self):
    (self.project_dir / 'optim.yaml').write_text("objective: {psnr: {}}\nevaluations: 10\n")
    self.addCleanup((self.project_dir / 'optim.yaml').unlink)
    result = self.qa('--label', 'auto', 'optimize', '--commit', self.head, '--batch', 'images', '--config-file', 'optim.yaml')
    assert result.exit_code == 0, result.output
    assert self.calls[1]["json"] == {"batch_label": "auto", "selected_group": ["images"], "notify": False,
                                     "tuning_search": {"search_type": "optimize", "parameter_search": "objective: {psnr: {}}\nevaluations: 10\n"}}
    result = self.qa('--label', 'auto', 'optimize', '--commit', self.head, '--batch', 'images', '--config-file', 'optim.yaml', '--checkpoint', 'x.log')
    assert result.exit_code == 1 and "--checkpoint can't be used with --commit" in result.unstyled_output
