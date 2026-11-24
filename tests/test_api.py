import unittest
import click
from pathlib import PureWindowsPath
from unittest import mock


class TestBatchInfo(unittest.TestCase):
  def test_windows_project_uses_forward_slashes(self):
    from qaboard.api import batch_info
    response = mock.Mock()
    response.json.return_value = {"batches": {"default": {"outputs": {}}}}
    with mock.patch("requests.get", return_value=response) as get:
      batch_info("0123456789", "default", project=PureWindowsPath("group/subgroup/repo") / "subproject", metrics=["none"])
    self.assertEqual(get.call_args.kwargs["params"]["project"], "group/subgroup/repo/subproject")


class TestNotifyQaDatabase(unittest.TestCase):
  def test_failed_request_does_not_print_the_token(self):
    import io
    import requests
    from contextlib import redirect_stderr
    from qaboard.api import notify_qa_database
    response = mock.Mock()
    response.raise_for_status.side_effect = requests.HTTPError("401 Client Error")
    response.status_code, response.text = 401, "You need to be logged-in to do this."
    response.request.headers = {"Content-Type": "application/json", "Authorization": "Bearer secret-token"}
    stderr = io.StringIO()
    # the request's headers are shown with --verbose
    with mock.patch("requests.post", return_value=response), redirect_stderr(stderr), mock.patch.dict("os.environ", {"QA_VERBOSE": "1"}):
      notify_qa_database(object_type="batch", share=True, batch_label="default")
    self.assertIn("Failed to update QA-Board", stderr.getvalue())
    self.assertIn("You need to be logged-in to do this.", stderr.getvalue())
    self.assertIn("Authorization", stderr.getvalue())
    self.assertNotIn("secret-token", stderr.getvalue())

  def test_the_end_of_a_run_is_tried_again(self):
    import io
    import requests
    from contextlib import redirect_stderr
    from qaboard.api import notify_qa_database
    busy, ok = mock.Mock(status_code=522, text='origin timed out'), mock.Mock(status_code=200)
    ok.json.return_value = {'id': 1}
    with mock.patch("requests.post", side_effect=[busy, requests.ConnectionError('reset'), ok]) as post, \
         mock.patch("time.sleep") as sleep, redirect_stderr(io.StringIO()):
      self.assertEqual(notify_qa_database(share=True, batch_label="default", is_pending=False, is_running=False), {'id': 1})
    self.assertEqual((post.call_count, sleep.call_count), (3, 2))
    # not when it starts: `qa run` decides what to do
    with mock.patch("requests.post", return_value=busy) as post, mock.patch("time.sleep"), redirect_stderr(io.StringIO()):
      notify_qa_database(share=True, batch_label="default", is_pending=True, is_running=True)
    self.assertEqual(post.call_count, 1)
    # no server there: we don't wait long
    with mock.patch("requests.post", side_effect=requests.ConnectionError('refused')) as post, mock.patch("time.sleep"), redirect_stderr(io.StringIO()):
      self.assertIsNone(notify_qa_database(share=True, batch_label="default", is_pending=False, is_running=False))
    self.assertEqual(post.call_count, 3)

  def test_requests_have_a_timeout(self):
    """A hung server must not block CI jobs forever"""
    from qaboard.api import notify_qa_database, get_output, batch_info, api_timeout
    self.assertGreaterEqual(api_timeout[1], 300) # uwsgi's harakiri: saving big manifests can take that long
    response = mock.Mock()
    response.json.return_value = {"batches": {"default": {"outputs": {}}}}
    with mock.patch("requests.post", return_value=response) as post, mock.patch("requests.get", return_value=response) as get:
      notify_qa_database(object_type="batch", share=True, batch_label="default")
      get_output(1)
      batch_info("0123456789", "default", project="group/repo", metrics=["none"])
    self.assertEqual(post.call_args.kwargs["timeout"], api_timeout)
    self.assertEqual([c.kwargs["timeout"] for c in get.call_args_list], [api_timeout, api_timeout])

  def test_data_that_does_not_serialize(self):
    import io
    from contextlib import redirect_stderr
    from qaboard.api import notify_qa_database
    stderr = io.StringIO()
    with mock.patch("requests.post") as post, redirect_stderr(stderr):
      notify_qa_database(object_type="batch", share=True, batch_label="default", data={"not-json": object()})
    post.assert_not_called()
    self.assertIn("Failed to update QA-Board", stderr.getvalue())
    self.assertIn("is not JSON serializable", stderr.getvalue())
    self.assertIn("`qa --verbose` shows what was sent", stderr.getvalue())
    # what was sent, with --verbose
    stderr = io.StringIO()
    with mock.patch("requests.post") as post, redirect_stderr(stderr), mock.patch.dict("os.environ", {"QA_VERBOSE": "1"}):
      notify_qa_database(object_type="batch", share=True, batch_label="default", data={"not-json": object()})
    self.assertIn("not-json", stderr.getvalue())


class TestServerUrl(unittest.TestCase):
  def stderr_of_import(self, **env):
    import os
    import sys
    import subprocess
    import tempfile
    from qaboard.config import ci_env_variables
    # outside a CI, like people's terminals: tests give CI=true when they need it
    clean_env = {k: v for k, v in os.environ.items() if (k == 'QABOARD_IGNORE_SITE' or not k.startswith(('QABOARD_', 'QA_'))) and k not in ci_env_variables}
    # Without the defaults of an installed site package (e.g. qaboard-site-sirc gives the server's URL)
    without_site_packages = (
      "import importlib.metadata as m; entry_points = m.entry_points\n"
      "class NoSite:\n  def select(self, **kwargs): return []\n  def get(self, group, default=None): return []\n"
      "m.entry_points = lambda **kwargs: entry_points(**kwargs) if kwargs else NoSite()\n"
      "import qaboard.api\n"
    )
    with tempfile.TemporaryDirectory() as tmp:
      process = subprocess.run(
        [sys.executable, '-c', without_site_packages],
        cwd=tmp, capture_output=True, text=True, check=True,
        # secrets files can also say where the server is
        env={**clean_env, 'QA_NO_CHECK_FOR_UPDATES': '1', 'QA_USER_SECRETS': f'{tmp}/secrets.yaml', **env},
      )
    return process.stderr

  def test_warns_without_a_server(self):
    # in CI, or with --share: else results stay local, and `qa` says it in one line
    self.assertIn('warning: No QA-Board server is set: qa uses http://localhost:5151.', click.unstyle(self.stderr_of_import(CI='true')))
    self.assertNotIn('No QA-Board server is set', self.stderr_of_import())

  def test_no_warning_for_a_server_on_localhost(self):
    self.assertNotIn('not sure where', self.stderr_of_import(QABOARD_URL='http://localhost:5151'))


class TestGetBatchStorageScript(unittest.TestCase):
  def test_requests_have_a_timeout_and_go_to_the_server_qa_uses(self):
    import os
    from qaboard.scripts import get_batch_storage
    response = mock.Mock(status_code=200)
    response.json.return_value = {"batches": {}}
    session = mock.Mock()
    session.request.return_value = response
    env = {k: v for k, v in os.environ.items() if k != 'QABOARD_HOST'}
    with mock.patch.dict(os.environ, env, clear=True), \
         mock.patch('qaboard.credentials.default_server', return_value=('https://qa.example', '$QABOARD_URL')), \
         mock.patch('qaboard.http_client._session', return_value=session), mock.patch('qaboard.results._token_for', return_value=None):
      self.assertEqual(get_batch_storage.fetch_commit('0123456789', 'group/repo'), {"batches": {}})
      # QABOARD_HOST was the script's variable, with a URL
      with mock.patch.dict(os.environ, {'QABOARD_HOST': 'http://localhost:5152'}):
        get_batch_storage.fetch_commit('0123456789', 'group/repo')
    (_, url), kwargs = session.request.call_args_list[0]
    self.assertEqual(url, 'https://qa.example/api/v1/commit/')
    self.assertTrue(kwargs['timeout'])
    self.assertEqual(session.request.call_args_list[1].args[1], 'http://localhost:5152/api/v1/commit/')


if __name__ == '__main__':
  unittest.main()
