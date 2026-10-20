"""
The pure parts of user management: the format of tokens, project patterns, settings, redirects, the audit's redaction.
The flows themselves are tested end to end in integration_tests/, on a real database.
"""
import datetime
from types import SimpleNamespace

import pytest

from backend import tokens
from backend import settings
from backend.audit import without_secrets, diff, client_ip


def test_tokens_have_a_prefix_and_a_checksum():
  token = tokens.generate()
  assert token.startswith("qab_pat_") and len(token) == len("qab_pat_") + 40 + 6
  assert tokens.is_well_formed(token)
  typo = token[:20] + ("a" if token[20] != "a" else "b") + token[21:]
  assert not tokens.is_well_formed(typo)
  assert not tokens.is_well_formed(token + "x")
  assert tokens.generate() != token


def test_legacy_tokens_are_well_formed():
  assert tokens.is_well_formed("ab" * 32)
  assert not tokens.is_well_formed("AB" * 32)


def test_tokens_are_hashed():
  assert tokens.hash_token("abc") == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"


def token(**fields):
  now = datetime.datetime(2026, 10, 20)
  defaults = dict(revoked=False, revoked_at=None, expires_at=None, idle_expiry_days=None, last_used_at=None, created_at=now, kind='personal', scopes=['read'])
  return SimpleNamespace(**{**defaults, **fields})


def test_token_status():
  now = datetime.datetime(2026, 10, 21)
  assert tokens.status(token(), now) == 'active'
  assert tokens.status(token(revoked=True), now) == 'revoked'
  assert tokens.status(token(revoked_at=now), now) == 'revoked'
  assert tokens.status(token(expires_at=now), now) == 'expired'
  assert tokens.status(token(expires_at=now + datetime.timedelta(seconds=1)), now) == 'active'
  # unused for 30 days, since its creation or its last use
  assert tokens.status(token(idle_expiry_days=1), now) == 'idle_expired'
  assert tokens.status(token(idle_expiry_days=2), now) == 'active'
  assert tokens.status(token(idle_expiry_days=1, last_used_at=now - datetime.timedelta(hours=1)), now) == 'active'


def test_legacy_tokens_have_the_scopes_of_before():
  # not the admin API, which came after them
  assert tokens.scopes_of(token(kind='legacy', scopes=[])) == ['read', 'ingest', 'act']
  assert tokens.scopes_of(token(scopes=['read', 'ingest'])) == ['read', 'ingest']


@pytest.mark.parametrize("patterns, project, expected", [
  ([], "any/project", True),
  (["group/repo"], "group/repo", True),
  (["group/repo"], "group/repo/sub", True),
  (["group/repo"], "group/repository", False),
  (["group/*"], "group/repo", True),
  (["group/*"], "group/repo/sub", True),
  (["group/*"], "other/repo", False),
  (["group/repo/"], "group/repo", True),
  (["group/repo"], None, False),
])
def test_matches_project(patterns, project, expected):
  assert tokens.matches_project(patterns, project) is expected


def test_clean_project_patterns():
  assert tokens.clean_project_patterns(None) == []
  assert tokens.clean_project_patterns("group/a, group/b\ngroup/a") == ["group/a", "group/b"]
  assert tokens.clean_project_patterns(["/group/a/", " "]) == ["group/a"]
  with pytest.raises(ValueError):
    tokens.clean_project_patterns([1])


@pytest.fixture
def no_database(monkeypatch):
  values = {}
  monkeypatch.setattr(settings, "_database_values", lambda: values)
  for definition in settings.DEFINITIONS.values():
    if definition.env:
      monkeypatch.delenv(definition.env, raising=False)
  monkeypatch.delenv('QABOARD_LOGIN_TYPE', raising=False)
  return values


def test_settings_env_then_database_then_default(no_database, monkeypatch):
  assert settings.setting('ingest.auth') == 'off' and settings.source('ingest.auth') == 'default'
  no_database['ingest.auth'] = 'warn'
  assert settings.setting('ingest.auth') == 'warn' and settings.source('ingest.auth') == 'database'
  monkeypatch.setenv('QABOARD_INGEST_AUTH', 'token')
  assert settings.setting('ingest.auth') == 'token' and settings.source('ingest.auth') == 'env'
  assert not settings.describe('ingest.auth')['editable']
  # a wrong value in the environment is ignored
  monkeypatch.setenv('QABOARD_INGEST_AUTH', 'maybe')
  assert settings.setting('ingest.auth') == 'warn'
  # empty values are unset, as docker-compose.yml passes them
  monkeypatch.setenv('QABOARD_INGEST_AUTH', '')
  assert settings.source('ingest.auth') == 'database'


@pytest.mark.parametrize("value, expected", [("1", True), ("true", True), ("True", True), ("false", False), ("False", False), ("0", False)])
def test_login_required_from_the_environment(no_database, monkeypatch, value, expected):
  # before, any value, even "False", required signing in
  monkeypatch.setenv('QABOARD_LOGIN_REQUIRED', value)
  assert settings.setting('auth.require_sign_in') is expected


def test_local_signup_is_off_by_default_with_ldap_or_saml(no_database, monkeypatch):
  assert settings.setting('auth.local_signup') is True
  monkeypatch.setenv('QABOARD_LOGIN_TYPE', 'LDAP')
  assert settings.setting('auth.local_signup') is False
  monkeypatch.setenv('QABOARD_DISABLE_SIGNUP', 'False')
  assert settings.setting('auth.local_signup') is True
  monkeypatch.setenv('QABOARD_DISABLE_SIGNUP', 'True')
  assert settings.setting('auth.local_signup') is False


@pytest.mark.parametrize("key, value, error", [
  ('auth.require_sign_in', 'yes', 'true or false'),
  ('tokens.default_lifetime_days', 0, 'at least 1'),
  ('tokens.default_lifetime_days', True, 'whole number'),
  ('tokens.default_lifetime_days', None, "can't be empty"),
  ('ingest.auth', 'maybe', 'one of'),
  ('auth.allowed_origins', 'https://a', 'list'),
  ('nope', 1, 'Unknown'),
])
def test_invalid_settings(key, value, error):
  with pytest.raises(ValueError, match=error):
    settings.validate(key, value)


def test_valid_settings():
  assert settings.validate('tokens.max_lifetime_days', None) is None
  assert settings.validate('auth.allowed_origins', ['https://a']) == ['https://a']


def test_audit_events_never_contain_secrets():
  assert without_secrets({"user": "a", "password": "x", "nested": [{"token": "y", "ok": 1}]}) == {
    "user": "a", "password": "[redacted]", "nested": [{"token": "[redacted]", "ok": 1}],
  }


def test_diff():
  assert diff({"a": 1, "b": 2}, {"a": 1, "b": 3, "c": 4}) == {"b": {"from": 2, "to": 3}, "c": {"from": None, "to": 4}}


def test_client_ip_behind_nginx(dummy_app):
  # QA-Board's nginx talks uwsgi: REMOTE_ADDR is the client, X-Forwarded-For is what the client sent (forgeable)
  with dummy_app.test_request_context('/', headers={"X-Forwarded-For": "6.6.6.6"}, environ_base={"REMOTE_ADDR": "172.17.0.1"}):
    assert client_ip() == "172.17.0.1"


def test_client_ip_behind_another_proxy(dummy_app, monkeypatch):
  # e.g. a Kubernetes ingress, that appends the address it sees: the last one (the first can be forged)
  import backend.audit
  monkeypatch.setattr(backend.audit, "trusted_proxy_hops", 1)
  with dummy_app.test_request_context('/', headers={"X-Forwarded-For": "1.2.3.4, 10.0.0.1"}, environ_base={"REMOTE_ADDR": "172.17.0.1"}):
    assert client_ip() == "10.0.0.1"
