import unittest
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
    with mock.patch("requests.post", return_value=response), redirect_stderr(stderr):
      notify_qa_database(object_type="batch", share=True, batch_label="default")
    self.assertIn("Failed to update QA-Board", stderr.getvalue())
    self.assertIn("Authorization", stderr.getvalue())
    self.assertNotIn("secret-token", stderr.getvalue())

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
    self.assertIn("not-json", stderr.getvalue())


class TestServerUrl(unittest.TestCase):
  def stderr_of_import(self, **env):
    import os
    import sys
    import subprocess
    import tempfile
    clean_env = {k: v for k, v in os.environ.items() if not k.startswith(('QABOARD_', 'QA_'))}
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
    self.assertIn('not sure where to find your QA-Board server', self.stderr_of_import())

  def test_no_warning_for_a_server_on_localhost(self):
    self.assertNotIn('not sure where', self.stderr_of_import(QABOARD_URL='http://localhost:5151'))


if __name__ == '__main__':
  unittest.main()
