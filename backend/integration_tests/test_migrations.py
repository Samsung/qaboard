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
  assert me["user_name"] == "alice" and me["token"]["kind"] == "legacy" and me["token"]["scopes"] == ["read", "ingest", "act"]
  assert make_client().get('/api/v1/user/me/', headers=bearer('cd' * 32)).status_code == 401


def test_users_keep_working(alembic, make_user, client):
  make_user('alice')
  alembic('downgrade', PREVIOUS_HEAD)
  assert not sql("SELECT 1 FROM information_schema.tables WHERE table_name = 'audit_events'")
  alembic('upgrade', 'head')
  assert sql("SELECT status, is_admin, kind, preferences::text FROM users") == [('active', False, 'human', '{}')]
  assert client.post('/api/v1/user/auth/', data={"username": "alice", "password": "password"}).status_code == 200


def test_identities_are_backfilled(alembic, make_user, client):
  """Users get an identity per their login type: the sign-in methods they have"""
  from backend.database import db_session
  from backend.models import User
  make_user('alice')
  make_user('bob', login_type='LDAP')
  alembic('downgrade', 'c3d5e7f9a1b2')
  assert not sql("SELECT 1 FROM information_schema.tables WHERE table_name = 'user_sessions'")
  alembic('upgrade', 'head')
  rows = sql("SELECT u.user_name, i.provider_id, i.subject FROM user_identities i JOIN users u ON u.id = i.user_id ORDER BY u.user_name")
  assert rows == [('alice', 'local', 'alice'), ('bob', 'ldap', 'bob')]
  assert client.post('/api/v1/user/auth/', data={"username": "alice", "password": "password"}).status_code == 200


def test_roles_groups_and_visibility(alembic, make_user, client):
  """Additive: the tables come and go, existing access requests keep working, nothing is seeded"""
  make_user('alice')
  alembic('downgrade', 'b8c0d2e4f6a8')
  assert not sql("SELECT 1 FROM information_schema.tables WHERE table_name = 'role_grants'")
  assert 'resource_id' not in {r[0] for r in sql("SELECT column_name FROM information_schema.columns WHERE table_name = 'access_requests'")}
  sql("INSERT INTO access_requests (user_id, kind, message, status, created_at) VALUES (1, 'instance', 'hi', 'pending', now())")
  alembic('upgrade', 'head')
  for table in ('groups', 'group_members', 'group_rules', 'role_grants', 'project_visibility'):
    assert sql("SELECT 1 FROM information_schema.tables WHERE table_name = :table", table=table), table
  assert sql("SELECT count(*) FROM role_grants")[0][0] == 0
  assert sql("SELECT kind, resource_id, role FROM access_requests") == [('instance', None, None)]
  assert client.post('/api/v1/user/auth/', data={"username": "alice", "password": "password"}).status_code == 200


def test_runs_activity_columns_and_indexes(alembic, make_user):
  """Nullable columns (no table rewrite) and partial indexes built CONCURRENTLY: the migration works again if it was interrupted"""
  alembic('downgrade', 'c1e3a5b7d9f2')
  assert 'finished_at' not in {r[0] for r in sql("SELECT column_name FROM information_schema.columns WHERE table_name = 'outputs'")}
  alembic('upgrade', 'head')
  assert {'queued_at', 'started_at', 'finished_at'} <= {r[0] for r in sql("SELECT column_name FROM information_schema.columns WHERE table_name = 'outputs'")}
  indexes = dict(sql("SELECT indexname, indexdef FROM pg_indexes WHERE indexname IN ('ix_outputs_active', 'ix_outputs_finished_at', 'ix_batches_submissions')"))
  assert 'WHERE is_pending' in indexes['ix_outputs_active']
  assert 'WHERE (finished_at IS NOT NULL)' in indexes['ix_outputs_finished_at']
  assert "WHERE (data ? 'submissions'::text)" in indexes['ix_batches_submissions']
  # an interrupted CONCURRENTLY build leaves an invalid index: it's built again
  sql("UPDATE pg_index SET indisvalid = false WHERE indexrelid = 'ix_outputs_active'::regclass")
  alembic('stamp', 'c1e3a5b7d9f2')
  alembic('upgrade', 'head')
  assert sql("SELECT indisvalid FROM pg_index WHERE indexrelid = 'ix_outputs_active'::regclass") == [(True,)]


def test_redundant_commits_index_is_dropped(alembic):
  def commits_indexes():
    return {r[0] for r in sql("SELECT indexname FROM pg_indexes WHERE tablename = 'ci_commits'")}
  alembic('downgrade', 'd2f4a6b8c0e1')
  assert 'ix_ci_commits_project_id' in commits_indexes()
  alembic('upgrade', 'head')
  assert 'ix_ci_commits_project_id' not in commits_indexes()
  assert 'ix_ci_commits_project_id_authored_datetime' in commits_indexes()
  # we keep it while what replaces it isn't there
  alembic('downgrade', 'd2f4a6b8c0e1')
  sql("DROP INDEX ix_ci_commits_project_id_authored_datetime")
  alembic('upgrade', 'head')
  assert 'ix_ci_commits_project_id' in commits_indexes()
  # once it's there (e.g. e7f3b2a91c40 again), the migration drops it
  sql("CREATE INDEX ix_ci_commits_project_id_authored_datetime ON ci_commits (project_id, authored_datetime DESC)")
  alembic('stamp', 'd2f4a6b8c0e1')
  alembic('upgrade', 'head')
  assert 'ix_ci_commits_project_id' not in commits_indexes()
