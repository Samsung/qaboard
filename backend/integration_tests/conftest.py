"""
Integration tests: the real app, without mocks, on a real PostgreSQL. They check what the unit tests can't:
SQL, migrations, and how the request hooks (backend/actor.py) and the endpoints work together.

  BACKEND_TEST_MODE=no-mock QABOARD_TEST_DATABASE_URL=postgresql://qaboard:password@localhost:5432/qaboard \
    pytest integration_tests

The tests create their own database next to the one in the URL, and drop it at the end.
Without those variables, nothing runs: the unit tests' conftest.py would mock the app.
"""
import os
import uuid
import tempfile
from pathlib import Path
from urllib.parse import urlparse

import pytest


DATABASE_URL = os.environ.get('QABOARD_TEST_DATABASE_URL')
ENABLED = bool(DATABASE_URL) and os.environ.get('BACKEND_TEST_MODE') == 'no-mock'
if not ENABLED:
  print("Skipping the integration tests: set BACKEND_TEST_MODE=no-mock and QABOARD_TEST_DATABASE_URL")
  collect_ignore_glob = ["test_*.py"]
else:
  import psycopg2
  url = urlparse(DATABASE_URL)
  test_database = f"qaboard_tests_{uuid.uuid4().hex[:8]}"
  def admin_sql(sql):
    # CREATE/DROP DATABASE can't run in a transaction: no `with connection`
    connection = psycopg2.connect(DATABASE_URL)
    connection.autocommit = True
    try:
      connection.cursor().execute(sql)
    finally:
      connection.close()
  admin_sql(f'CREATE DATABASE "{test_database}"')
  data_dir = Path(tempfile.mkdtemp(prefix='qaboard-tests-'))
  # not inside the data folder: the server never writes there for clients (backend/storage.py)
  storage_dir = Path(tempfile.mkdtemp(prefix='qaboard-tests-storage-'))
  # backend/database.py and backend/config.py read them when they're imported
  os.environ.update({
    'QABOARD_DB_HOST': url.hostname or 'localhost',
    'QABOARD_DB_PORT': str(url.port or 5432),
    'QABOARD_DB_USER': url.username or 'qaboard',
    'QABOARD_DB_PASSWORD': url.password or '',
    'QABOARD_DB_NAME': test_database,
    'QABOARD_DATA_DIR': str(data_dir),
    'QABOARD_STORAGE_ROOTS': str(storage_dir),
    'SECRET_KEY': 'integration-tests',
    'QABOARD_HOST': 'localhost:5151',
    # tests of the jobs worker don't want its default jobs (test_storage_usage.py does)
    'QABOARD_STORAGE_USAGE_AUTO': '0',
    'QABOARD_GROUPS_SYNC_AUTO': '0',
  })
  for name in ['QABOARD_LOGIN_TYPE', 'QABOARD_LOGIN_REQUIRED', 'QABOARD_DISABLE_SIGNUP', 'QABOARD_INGEST_AUTH',
               'QABOARD_ADMINS', 'QABOARD_LOGIN_RESTRICTED', 'QABOARD_URL', 'QABOARD_ALLOWED_ORIGINS', 'SENTRY_DSN']:
    os.environ.pop(name, None)


@pytest.fixture(scope='session')
def app():
  import backend
  # Hashing passwords is slow on purpose: not in tests, where we create many users
  import backend.api.auth
  from werkzeug.security import generate_password_hash
  backend.api.auth.generate_password_hash = lambda password: generate_password_hash(password, method='pbkdf2:sha256:1')
  yield backend.app
  from backend.database import db_session, engine
  db_session.remove()
  engine.dispose()
  # the server runs PostgreSQL 12 (docker-compose.yml): no DROP DATABASE ... WITH (FORCE), it's 13+
  admin_sql(f"SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '{test_database}' AND pid <> pg_backend_pid()")
  admin_sql(f'DROP DATABASE IF EXISTS "{test_database}"')


@pytest.fixture(autouse=True)
def empty_database(app, monkeypatch):
  """Every test starts with empty tables and the default settings"""
  for name in ['QABOARD_LOGIN_REQUIRED', 'QABOARD_DISABLE_SIGNUP', 'QABOARD_INGEST_AUTH', 'QABOARD_ADMINS', 'QABOARD_ALLOWED_ORIGINS']:
    monkeypatch.delenv(name, raising=False)
  yield
  from sqlalchemy import text
  from backend.database import db_session, Base
  from backend import settings
  db_session.rollback()
  tables = ', '.join(f'"{t.name}"' for t in Base.metadata.sorted_tables)
  db_session.execute(text(f'TRUNCATE {tables} RESTART IDENTITY CASCADE'))
  db_session.commit()
  db_session.remove()
  settings.invalidate_cache()
  # /api/v1/projects keeps everyone's usage for a minute
  from backend.api import api
  api._usage_cache.update(at=None, value=None)


@pytest.fixture
def client(app):
  return app.test_client()


@pytest.fixture
def make_client(app):
  return app.test_client


@pytest.fixture
def make_user():
  """Creates a local user: make_user('alice', is_admin=True)"""
  def make(user_name, password='password', email=None, **fields):
    from backend.database import db_session
    from backend.api.auth import create_user
    user = create_user({
      "user_name": user_name, "full_name": user_name.title(), "email": email or f"{user_name}@example.com",
      "password": password, "login_type": "LOCAL", "data": {},
    })
    for key, value in fields.items():
      setattr(user, key, value)
    db_session.commit()
    return user
  return make


def login(client, user_name, password='password'):
  response = client.post('/api/v1/user/auth/', data={"username": user_name, "password": password})
  assert response.status_code == 200, response.get_json()
  return client


@pytest.fixture
def logged_in(make_user, make_client):
  """A client logged-in as a new user: alice_client = logged_in('alice')"""
  def make(user_name='alice', **fields):
    make_user(user_name, **fields)
    return login(make_client(), user_name)
  return make


def new_token(client, **body):
  """Creates a token from a logged-in client: returns the answer, whose "token" is the secret"""
  response = client.post('/api/v1/user/tokens', json={"name": "test", "scopes": ["read", "ingest", "act"], **body})
  assert response.status_code == 201, response.get_json()
  return response.get_json()


def bearer(token: str) -> dict:
  return {"Authorization": f"Bearer {token}"}


def make_projects(*project_ids):
  """Projects with a commit each, so they're listed"""
  import datetime
  from backend.database import db_session
  from backend.models import Project, CiCommit
  for project_id in project_ids:
    project = Project(id=project_id, data={})
    db_session.add(project)
    db_session.add(CiCommit('a' * 40, project=project, branch='master', authored_datetime=datetime.datetime.now(datetime.timezone.utc)))
  db_session.commit()
