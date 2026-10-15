"""
Tests for /api/v1/config in backend/api/api.py
"""
import sys
import json
import types
import importlib
from unittest.mock import MagicMock

import pytest


SITE_MAPPINGS = [["\\\\netapp\\algo_data", "/stage/algo_data"]]


@pytest.fixture
def reload_config(monkeypatch, tmp_path):
  """Re-import the site config and the route module, as they read the configuration at import time."""
  monkeypatch.setenv('QABOARD_DATA_DIR', str(tmp_path))
  monkeypatch.delenv('QABOARD_PATH_MAPPINGS', raising=False)
  import qaboard.site_config
  monkeypatch.setattr(qaboard.site_config, 'secrets', {})
  # conftest.py replaces sqlalchemy with an empty module
  for name in ('func', 'and_', 'asc', 'or_', 'text'):
    monkeypatch.setattr(sys.modules['sqlalchemy'], name, MagicMock(), raising=False)
  sa_sql = types.ModuleType('sqlalchemy.sql')
  sa_sql.label = MagicMock()
  monkeypatch.setitem(sys.modules, 'sqlalchemy.sql', sa_sql)

  def reload(site_defaults):
    monkeypatch.setattr(qaboard.site_config, '_site_defaults', site_defaults)
    sys.modules.pop('qaboard.compat', None)
    sys.modules.pop('backend.api.api', None)
    return importlib.import_module('backend.api.api')

  yield reload
  # Don't leak the patched configuration to other tests
  sys.modules.pop('qaboard.compat', None)
  sys.modules.pop('backend.api.api', None)


def test_path_mappings_from_site_package(dummy_app, reload_config):
  api = reload_config({'QABOARD_PATH_MAPPINGS': json.dumps(SITE_MAPPINGS)})
  with dummy_app.test_request_context('/api/v1/config'):
    assert api.get_site_config().get_json()['path_mappings'] == SITE_MAPPINGS


def test_path_mappings_env_wins_over_site_package(dummy_app, reload_config, monkeypatch):
  env_mappings = [["\\\\mars\\raid", "/raid"]]
  monkeypatch.setenv('QABOARD_PATH_MAPPINGS', json.dumps(env_mappings))
  api = reload_config({'QABOARD_PATH_MAPPINGS': json.dumps(SITE_MAPPINGS)})
  with dummy_app.test_request_context('/api/v1/config'):
    assert api.get_site_config().get_json()['path_mappings'] == env_mappings


def test_path_mappings_default(dummy_app, reload_config):
  api = reload_config({})
  with dummy_app.test_request_context('/api/v1/config'):
    assert api.get_site_config().get_json()['path_mappings'] == []


def test_git_hosts(dummy_app, reload_config, monkeypatch):
  import backend.git_hosts as git_hosts
  env = {"GITLAB_HOST": "https://gitlab.example.com", "GITLAB_ACCESS_TOKEN": "secret", "GITHUB_ACCESS_TOKEN": "secret"}
  monkeypatch.setattr(git_hosts, 'git_hosts', git_hosts.load_git_hosts(lambda key, default=None: env.get(key, default)))
  api = reload_config({})
  with dummy_app.test_request_context('/api/v1/config'):
    config = api.get_site_config().get_json()
  assert config['git_web_url'] == "https://gitlab.example.com"
  assert config['git_hosts'] == [
    {"type": "gitlab", "url": "https://gitlab.example.com", "name": "gitlab.example.com"},
    {"type": "github", "url": "https://github.com", "name": "github.com"},
  ]
  assert "secret" not in json.dumps(config)


def test_sentry(dummy_app, reload_config, monkeypatch):
  for key in ('SENTRY_DSN', 'SENTRY_FRONTEND_DSN', 'SENTRY_ENVIRONMENT', 'SENTRY_TRACES_SAMPLE_RATE', 'SENTRY_SAMPLE_RATE'):
    monkeypatch.delenv(key, raising=False)
  api = reload_config({})
  with dummy_app.test_request_context('/api/v1/config'):
    config = api.get_site_config().get_json()
  assert config['sentry_dsn'] is None
  assert config['sentry_environment'] == 'production'
  assert config['sentry_traces_sample_rate'] == 0.2

  monkeypatch.setenv('SENTRY_DSN', 'https://backend@sentry.example.com/1')
  monkeypatch.setenv('SENTRY_ENVIRONMENT', 'staging')
  monkeypatch.setenv('SENTRY_SAMPLE_RATE', '0.5') # the former name
  with dummy_app.test_request_context('/api/v1/config'):
    config = api.get_site_config().get_json()
  assert config['sentry_dsn'] == 'https://backend@sentry.example.com/1'
  assert config['sentry_environment'] == 'staging'
  assert config['sentry_traces_sample_rate'] == 0.5

  monkeypatch.setenv('SENTRY_FRONTEND_DSN', 'https://frontend@sentry.example.com/2')
  monkeypatch.setenv('SENTRY_TRACES_SAMPLE_RATE', '1')
  with dummy_app.test_request_context('/api/v1/config'):
    config = api.get_site_config().get_json()
  assert config['sentry_dsn'] == 'https://frontend@sentry.example.com/2'
  assert config['sentry_traces_sample_rate'] == 1.0


def test_site_texts(dummy_app, reload_config, monkeypatch):
  monkeypatch.setenv('QABOARD_LOGIN_HINT', 'Use your Windows credentials')
  monkeypatch.setenv('QABOARD_WEBCDE_INSTALLER', '\\\\server\\share\\WebCDE_Setup.exe')
  api = reload_config({})
  with dummy_app.test_request_context('/api/v1/config'):
    config = api.get_site_config().get_json()
  assert config['login_hint'] == 'Use your Windows credentials'
  assert config['webcde_installer'] == '\\\\server\\share\\WebCDE_Setup.exe'


def test_site_texts_default(dummy_app, reload_config, monkeypatch):
  monkeypatch.delenv('QABOARD_LOGIN_HINT', raising=False)
  monkeypatch.delenv('QABOARD_WEBCDE_INSTALLER', raising=False)
  api = reload_config({})
  with dummy_app.test_request_context('/api/v1/config'):
    config = api.get_site_config().get_json()
  assert config['login_hint'] is None
  assert config['webcde_installer'] is None
