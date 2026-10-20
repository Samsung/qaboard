"""
The latest migration, down and up, on a database with data. Databases created by the app are stamped at the head
by backend/migrate.sh, like here.
"""
from pathlib import Path

import pytest

from .conftest import bearer


PREVIOUS_HEAD = 'f2c8d4a6b1e9'


@pytest.fixture
def alembic(app):
  from alembic.config import Config
  from alembic import command
  from backend.database import db_session, engine
  directory = Path(__file__).parent.parent / 'backend'
  config = Config(str(directory / 'alembic.ini'))
  config.set_main_option('script_location', str(directory / 'alembic'))
  def run(name, *args):
    db_session.remove()
    engine.dispose()
    getattr(command, name)(config, *args)
  run('stamp', 'head')
  yield run
  # the other tests need the latest schema
  run('upgrade', 'head')


def sql(statement, **params):
  from sqlalchemy import text
  from backend.database import engine
  with engine.begin() as connection:
    result = connection.execute(text(statement), params)
    return result.fetchall() if result.returns_rows else None


def test_tokens_in_clear_are_hashed_and_keep_working(alembic, make_user, make_client):
  make_user('alice')
  alembic('downgrade', PREVIOUS_HEAD)
  assert 'token_hash' not in {r[0] for r in sql("SELECT column_name FROM information_schema.columns WHERE table_name = 'tokens'")}
  legacy = 'ab' * 32
  # like databases created by the 2024 migration: no `data`, `expires_at` required
  sql("ALTER TABLE tokens DROP COLUMN data")
  sql("ALTER TABLE tokens ALTER COLUMN expires_at SET NOT NULL")
  sql("INSERT INTO tokens (user_id, token, expires_at, revoked, created_at) VALUES (1, :token, now() + interval '1 year', false, now())", token=legacy)
  sql("INSERT INTO tokens (user_id, token, expires_at, revoked, created_at) VALUES (1, :token, now() + interval '1 year', true, now())", token='cd' * 32)

  alembic('upgrade', 'head')
  rows = sql("SELECT token, token_hash, prefix, kind, revoked_at IS NOT NULL FROM tokens ORDER BY id")
  assert [(r[0], r[2], r[3], r[4]) for r in rows] == [(None, 'abababab', 'legacy', False), (None, 'cdcdcdcd', 'legacy', True)]
  from backend.tokens import hash_token
  assert rows[0][1] == hash_token(legacy)
  sql("INSERT INTO tokens (user_id, created_at) VALUES (1, now())")  # `expires_at` can be empty now

  me = make_client().get('/api/v1/user/me/', headers=bearer(legacy)).get_json()
  assert me["user_name"] == "alice" and me["token"]["kind"] == "legacy" and "admin" in me["token"]["scopes"]
  assert make_client().get('/api/v1/user/me/', headers=bearer('cd' * 32)).status_code == 401


def test_users_keep_working(alembic, make_user, client):
  make_user('alice')
  alembic('downgrade', PREVIOUS_HEAD)
  assert not sql("SELECT 1 FROM information_schema.tables WHERE table_name = 'audit_events'")
  alembic('upgrade', 'head')
  assert sql("SELECT status, is_admin, kind, preferences::text FROM users") == [('active', False, 'human', '{}')]
  assert client.post('/api/v1/user/auth/', data={"username": "alice", "password": "password"}).status_code == 200
