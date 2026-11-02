"""
Signing in with LDAP (backend/api/auth.py), against a fake directory.
"""
import sys
import importlib.util
from pathlib import Path
from unittest.mock import MagicMock

import pytest
import requests # before we stub simplejson, that requests would use


class INVALID_CREDENTIALS(Exception):
  pass

class OPERATIONS_ERROR(Exception):
  pass


ALICE_DN = "cn=alice,ou=people,dc=example,dc=com"
ALICE = {"cn": [b"Alice"], "mail": [b"alice@example.com"], "memberOf": [b"cn=camera,ou=groups,dc=example,dc=com"]}


class FakeDirectory:
  """Stands for python-ldap's connections: knows alice (password "secret"), refuses other binds"""
  def __init__(self):
    self.binds, self.searches, self.started_tls, self.uri = [], [], False, None

  def initialize(self, uri):
    self.uri = uri
    return self

  def set_option(self, option, value):
    pass

  def start_tls_s(self):
    self.started_tls = True

  def simple_bind_s(self, dn, password):
    self.binds.append((dn, password))
    if (dn, password) not in [("cn=qaboard,dc=example,dc=com", "service-password"), (ALICE_DN, "secret")]:
      raise INVALID_CREDENTIALS()

  def search_s(self, base, scope, search, attributes):
    self.searches.append(search)
    # referrals are entries without a DN
    return [(ALICE_DN, ALICE), (None, ["ldap://other/"])] if search == "(uid=alice)" else [(None, ["ldap://other/"])]

  def unbind_s(self):
    pass


@pytest.fixture
def ldap_auth(monkeypatch):
  """The real backend/api/auth.py, with QABOARD_LOGIN_TYPE=LDAP"""
  directory = FakeDirectory()
  ldap = MagicMock(initialize=directory.initialize, INVALID_CREDENTIALS=INVALID_CREDENTIALS, OPERATIONS_ERROR=OPERATIONS_ERROR)
  ldap_filter = MagicMock()
  # like ldap.filter.escape_filter_chars
  ldap_filter.escape_filter_chars = lambda value: value.replace('\\', r'\5c').replace('*', r'\2a').replace('(', r'\28').replace(')', r'\29').replace('\x00', r'\00')
  ldap.filter = ldap_filter
  monkeypatch.setitem(sys.modules, "ldap", ldap)
  monkeypatch.setitem(sys.modules, "ldap.filter", ldap_filter)
  models = sys.modules['backend.models']
  monkeypatch.setattr(models, "User", MagicMock(), raising=False)
  for name, value in {
    "QABOARD_LOGIN_TYPE": "LDAP", "QABOARD_LDAP_HOST": "ldap.example.com", "QABOARD_LDAP_USER_BASE": "dc=example,dc=com",
    "QABOARD_LDAP_BIND_DN": "cn=qaboard,dc=example,dc=com", "QABOARD_LDAP_PASSWORD": "service-password",
    "QABOARD_LDAP_USER_FILTER": "(uid={login})",
  }.items():
    monkeypatch.setenv(name, value)
  for name in ("QABOARD_LDAP_PORT", "QABOARD_LDAP_START_TLS", "QABOARD_LOGIN_RESTRICTED"):
    monkeypatch.delenv(name, raising=False)
  path = Path(__file__).parent.parent / "backend" / "api" / "auth.py"
  spec = importlib.util.spec_from_file_location("backend.api._ldap_auth_under_test", path)
  module = importlib.util.module_from_spec(spec)
  spec.loader.exec_module(module)
  module.User = MagicMock()
  module.User.query.filter_by.return_value.one_or_none.return_value = None
  module.create_user = MagicMock(return_value=MagicMock(id=1))
  module.update_user = MagicMock()
  module.directory = directory
  return module


def test_ldap_sign_in(ldap_auth, dummy_app):
  with dummy_app.test_request_context("/api/v1/user/auth/", method="POST"):
    info = ldap_auth.auth_ldap("alice", "secret")
  assert info["login_success"] is True
  assert (info["full_name"], info["email"]) == ("Alice", "alice@example.com")
  assert ldap_auth.directory.binds == [("cn=qaboard,dc=example,dc=com", "service-password"), (ALICE_DN, "secret")]
  assert ldap_auth.directory.uri == "ldap://ldap.example.com:389"
  ldap_auth.create_user.assert_called_once()


def test_ldap_refuses_empty_passwords(ldap_auth, dummy_app):
  """A bind with an empty password is an anonymous bind: many servers accept it"""
  for password in ["", None]:
    with dummy_app.test_request_context("/api/v1/user/auth/", method="POST"):
      info = ldap_auth.auth_ldap("alice", password)
    assert info["login_success"] is False and info["error"] == "invalid-password"
  assert ldap_auth.directory.binds == []


def test_ldap_wrong_password_and_unknown_users(ldap_auth, dummy_app):
  with dummy_app.test_request_context("/api/v1/user/auth/", method="POST"):
    assert ldap_auth.auth_ldap("alice", "wrong")["error"] == "invalid-password"
    # not an IndexError (500)
    assert ldap_auth.auth_ldap("bob", "secret")["error"] == "invalid-username"
  ldap_auth.create_user.assert_not_called()


def test_ldap_escapes_the_login_in_the_filter(ldap_auth, dummy_app):
  with dummy_app.test_request_context("/api/v1/user/auth/", method="POST"):
    info = ldap_auth.auth_ldap("*)(uid=alice", "secret")
  assert info["login_success"] is False and info["error"] == "invalid-username"
  assert ldap_auth.directory.searches == [r"(uid=\2a\29\28uid=alice)"]


@pytest.mark.parametrize("host, port, start_tls, uri", [
  ("ldap.example.com", None, None, "ldap://ldap.example.com:389"),
  ("ldap.example.com", "1389", None, "ldap://ldap.example.com:1389"),
  ("ldaps://ldap.example.com", None, None, "ldaps://ldap.example.com"),
  ("ldaps://ldap.example.com", "636", None, "ldaps://ldap.example.com:636"),
  ("ldap.example.com", None, "true", "ldap://ldap.example.com:389"),
])
def test_ldap_over_tls(ldap_auth, dummy_app, monkeypatch, host, port, start_tls, uri):
  monkeypatch.setattr(ldap_auth, "ldap_host", host)
  if port:
    monkeypatch.setenv("QABOARD_LDAP_PORT", port)
    monkeypatch.setattr(ldap_auth, "ldap_port", port)
  if start_tls:
    monkeypatch.setenv("QABOARD_LDAP_START_TLS", start_tls)
  with dummy_app.test_request_context("/api/v1/user/auth/", method="POST"):
    assert ldap_auth.auth_ldap("alice", "secret")["login_success"]
  assert ldap_auth.directory.uri == uri
  # before sending passwords
  assert ldap_auth.directory.started_tls is bool(start_tls)
