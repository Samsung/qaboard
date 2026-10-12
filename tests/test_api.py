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


if __name__ == '__main__':
  unittest.main()
