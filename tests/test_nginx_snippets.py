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

  def test_files_being_received_arent_served(self):
    files = (SNIPPETS / "qaboard-files.conf").read_text()
    self.assertIn('if ($uri ~ "/\\.qaboard-upload-") {\n  return 404;', files)
    # before anything else can answer
    self.assertLess(files.index('qaboard-upload-'), files.index('include cors;'))
    uploads = Path(__file__).parent.parent / "backend" / "backend" / "uploads.py"
    self.assertIn("TEMPORARY_PREFIX = '.qaboard-upload-'", uploads.read_text())

  def test_files_are_served_with_nosniff(self):
    """add_header in an "if" drops the others: every block that sets the files' CSP sets nosniff too"""
    nginx = SNIPPETS.parent
    for text in ((nginx / "cors").read_text(), (SNIPPETS / "qaboard-files.conf").read_text()):
      self.assertEqual(text.count('$qaboard_files_csp always;'), text.count('add_header "X-Content-Type-Options" $qaboard_files_nosniff always;'))
    self.assertIn("map $uri $qaboard_files_nosniff {", (nginx / "conf.d" / "qaboard-files.conf").read_text())

  def test_xml_files_are_sandboxed(self):
    csp = (SNIPPETS.parent / "conf.d" / "qaboard-files.conf").read_text()
    pattern = re.findall(r'^\s*"(~\*\^on[^"]*)"', csp, re.M)
    self.assertEqual(len(pattern), 2)
    for regex in pattern:
      for content_type in ("text/html", "application/xhtml+xml", "image/svg+xml", "text/xml", "application/xml", "text/xsl", "application/rss+xml", "text/xml; charset=utf-8"):
        self.assertTrue(re.search(regex[2:], f"on|iframe|/s/a/b|{content_type}", re.I), (regex, content_type))
      for content_type in ("application/pdf", "image/png", "text/plain", "application/json"):
        self.assertFalse(re.search(regex[2:], f"on|iframe|/s/a/b|{content_type}", re.I), (regex, content_type))


if __name__ == '__main__':
  unittest.main()
