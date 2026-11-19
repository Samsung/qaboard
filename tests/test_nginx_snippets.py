"""
The nginx snippets that check tokens fail closed (services/nginx/snippets). Here rather than in backend/tests: CI runs
those in the backend's image, which doesn't have the nginx configuration.
"""
import re
import unittest
from pathlib import Path

SNIPPETS = Path(__file__).parent.parent / "services" / "nginx" / "snippets"
# backend/backend/uploads.py PROXY_CHECKED_HEADER: the backend's answer to the upload check
PROXY_CHECKED_HEADER = 'X-QABoard-Upload-Checked'


class TestNginxSnippets(unittest.TestCase):
  def test_checks_refuse_without_their_server_snippet(self):
    """The checks nginx makes are locations of snippets/qaboard-files-server.conf: without it, they'd say yes to all"""
    server = (SNIPPETS / "qaboard-files-server.conf").read_text()
    self.assertIn("set $qaboard_files_server_included 1;", server)
    checked = []
    for snippet in SNIPPETS.glob("*.conf"):
      text = snippet.read_text()
      for uri in re.findall(r'^\s*auth_request\s+(\S+);', text, re.M):
        if f"location = {uri} " in text:
          continue  # e.g. pgadmin.conf: its own check
        self.assertIn(f"location = {uri} ", server, (snippet.name, uri))
        self.assertIn("if ($qaboard_files_server_included != 1) {", text, snippet.name)
        checked.append(snippet.name)
    self.assertLessEqual({"qaboard-uploads-auth.conf", "qaboard-files-auth.conf", "qaboard-admins-only.conf"}, set(checked))

  def test_the_backend_knows_nginx_checked_the_token(self):
    """The backend's yes reaches the endpoints that receive files (uploads.unchecked_by_proxy)"""
    uploads_auth = (SNIPPETS / "qaboard-uploads-auth.conf").read_text()
    header = PROXY_CHECKED_HEADER.lower().replace('-', '_')
    self.assertIn(f"auth_request_set $qaboard_upload_checked $upstream_http_{header};", uploads_auth)
    self.assertIn("uwsgi_param QABOARD_UPLOAD_CHECKED $qaboard_upload_checked;", uploads_auth)

  def test_the_header_name_is_the_backends(self):
    uploads = Path(__file__).parent.parent / "backend" / "backend" / "uploads.py"
    self.assertIn(f"PROXY_CHECKED_HEADER = '{PROXY_CHECKED_HEADER}'", uploads.read_text())


if __name__ == '__main__':
  unittest.main()
