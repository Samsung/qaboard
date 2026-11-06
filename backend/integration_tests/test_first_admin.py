"""
A new server's first admin (backend/first_admin.py): the setup page and its token, QABOARD_ADMIN_PASSWORD,
and how admins and users manage local accounts' passwords.
"""
import pytest

from .conftest import login


PASSWORD = 'correct-horse'


@pytest.fixture
def setup_on(monkeypatch):
  monkeypatch.setenv('QABOARD_SETUP', 'on')


def token():
  from backend.first_admin import setup_token
  return setup_token()


def events(action):
  from backend.models import AuditEvent
  return AuditEvent.query.filter(AuditEvent.action == action).order_by(AuditEvent.id).all()


def setup(client, **body):
  return client.post('/api/v1/setup', json={"token": token(), "user_name": "admin", "password": PASSWORD, **body})


# ---------------------------------------------------------------------------
# The setup page
# ---------------------------------------------------------------------------

def test_new_server_needs_setup(setup_on, client):
  assert client.get('/api/v1/setup').get_json()["open"] is True
  assert client.get('/api/v1/config').get_json()["setup_required"] is True
  assert client.get('/api/v1/auth/providers').get_json()["setup_required"] is True


def test_setup_token_is_stable_and_readable():
  # every process and replica computes the same, from SECRET_KEY
  assert token() == token()
  assert len(token().replace('-', '')) == 24
  from backend.first_admin import check_setup_token
  assert check_setup_token(token().upper().replace('-', ' '))
  assert not check_setup_token('') and not check_setup_token(None) and not check_setup_token('0000-0000')


def test_setup_creates_the_first_admin_and_signs_in(setup_on, client):
  response = setup(client, full_name="Ada Admin", email="ada@example.com")
  assert response.status_code == 201, response.get_json()
  assert response.get_json()["is_admin"] is True
  me = client.get('/api/v1/user/me/').get_json()
  assert me["user_name"] == "admin" and me["is_admin"] is True
  assert client.get('/api/v1/admin/overview').status_code == 200
  # once done, it's closed
  assert client.get('/api/v1/setup').get_json()["open"] is False
  assert client.get('/api/v1/config').get_json()["setup_required"] is False
  [event] = events('setup.first_admin')
  assert event.target_label == 'admin' and PASSWORD not in str((event.meta, event.changes))


def test_setup_needs_the_token(setup_on, client):
  response = client.post('/api/v1/setup', json={"token": "nope", "user_name": "eve", "password": PASSWORD})
  assert response.status_code == 403 and response.get_json()["reason"] == "invalid_setup_token"
  response = client.post('/api/v1/setup', json={"user_name": "eve", "password": PASSWORD})
  assert response.status_code == 403
  from backend.models import User
  assert User.query.count() == 0
  rejected = events('setup.token_rejected')
  assert len(rejected) == 2 and all('nope' not in str(e.meta) for e in rejected)
  # still open for whoever has the token
  assert client.get('/api/v1/setup').get_json()["open"] is True


def test_setup_runs_once(setup_on, make_client):
  assert setup(make_client()).status_code == 201
  response = setup(make_client(), user_name="eve")
  assert response.status_code == 409 and response.get_json()["reason"] == "setup_done"


@pytest.mark.parametrize("body, field", [
  ({"password": "short"}, "password"),
  ({"password": ""}, "password"),
  ({"user_name": ""}, "user_name"),
  ({"user_name": "ci[bot]"}, "user_name"),
  ({"user_name": "a b"}, "user_name"),
  ({"email": "not-an-email"}, "email"),
])
def test_setup_validates(setup_on, client, body, field):
  response = setup(client, **body)
  assert response.status_code == 400 and response.get_json()["field"] == field
  assert client.get('/api/v1/setup').get_json()["open"] is True


def test_signup_waits_for_the_setup(setup_on, make_client):
  """Else whoever reaches a new server first would get its first account"""
  response = make_client().post('/api/v1/user/signup/', data={"user_name": "eve", "password": "pw"})
  assert response.status_code == 403 and response.get_json()["reason"] == "setup_required"
  setup(make_client())
  assert make_client().post('/api/v1/user/signup/', data={"user_name": "eve", "password": "pw"}).status_code == 200


def test_setup_works_when_sign_in_is_required(setup_on, monkeypatch, client):
  monkeypatch.setenv('QABOARD_LOGIN_REQUIRED', 'true')
  from backend import settings
  settings.invalidate_cache()
  assert client.get('/api/v1/setup').status_code == 200
  assert setup(client).status_code == 201


def test_setup_closed_when_the_server_has_users(setup_on, make_user, client):
  make_user('alice')
  assert client.get('/api/v1/setup').get_json()["open"] is False
  assert setup(client).status_code == 409


def test_setup_off(client):
  # QABOARD_SETUP=off, like in the other tests: no setup page, sign-up works on an empty server
  assert client.get('/api/v1/setup').get_json()["open"] is False
  assert setup(client).status_code == 409


def test_setup_token_from_the_environment(setup_on, monkeypatch, client):
  monkeypatch.setenv('QABOARD_SETUP_TOKEN', 'my-chosen-token')
  assert client.post('/api/v1/setup', json={"token": "my-chosen-token", "user_name": "admin", "password": PASSWORD}).status_code == 201


def test_setup_token_cli(setup_on):
  from click.testing import CliRunner
  from backend.scripts.admin import cli
  result = CliRunner().invoke(cli, ['setup-token'])
  assert result.exit_code == 0 and token() in result.output


def test_first_start_logs_the_token(setup_on, capsys, monkeypatch):
  import backend.first_admin as first_admin
  monkeypatch.setattr(first_admin, '_started', False)
  first_admin.first_start()
  assert token() in capsys.readouterr().out


# ---------------------------------------------------------------------------
# QABOARD_ADMIN_PASSWORD
# ---------------------------------------------------------------------------

def test_env_admin_is_created_once(monkeypatch, make_client):
  monkeypatch.setenv('QABOARD_ADMIN_PASSWORD', PASSWORD)
  from backend.first_admin import create_env_admin
  assert "Created the admin admin" in create_env_admin()
  client = login(make_client(), 'admin', PASSWORD)
  assert client.get('/api/v1/user/me/').get_json()["is_admin"] is True
  # restarts don't change it, even with another password
  monkeypatch.setenv('QABOARD_ADMIN_PASSWORD', 'another-password')
  assert create_env_admin() is None
  login(make_client(), 'admin', PASSWORD)
  [event] = events('user.create')
  assert event.actor_kind == 'system' and event.actor_label == 'QABOARD_ADMIN_PASSWORD'


def test_env_admin_user_name_and_file(monkeypatch, tmp_path, make_client):
  secret = tmp_path / 'admin_password'
  secret.write_text(PASSWORD + '\n')
  monkeypatch.setenv('QABOARD_ADMIN_USER', 'root')
  monkeypatch.setenv('QABOARD_ADMIN_PASSWORD_FILE', str(secret))
  from backend.first_admin import create_env_admin
  assert create_env_admin()
  login(make_client(), 'root', PASSWORD)


def test_env_admin_never_takes_over_an_account(monkeypatch, make_user):
  make_user('admin', password='their-own-password')
  monkeypatch.setenv('QABOARD_ADMIN_PASSWORD', PASSWORD)
  from backend.first_admin import create_env_admin
  assert "ignored" in create_env_admin()
  from backend.models import User
  assert User.query.filter(User.user_name == 'admin').one().is_admin is False


def test_env_admin_not_created_when_there_are_admins(monkeypatch, make_user):
  make_user('alice', is_admin=True)
  monkeypatch.setenv('QABOARD_ADMIN_PASSWORD', PASSWORD)
  from backend.first_admin import create_env_admin
  assert create_env_admin() is None
  from backend.models import User
  assert User.query.filter(User.user_name == 'admin').one_or_none() is None


def test_env_admin_short_password(monkeypatch):
  monkeypatch.setenv('QABOARD_ADMIN_PASSWORD', 'short')
  from backend.first_admin import create_env_admin
  assert "ignored" in create_env_admin()


# ---------------------------------------------------------------------------
# Admins create local accounts, and reset their passwords
# ---------------------------------------------------------------------------

@pytest.fixture
def admin(logged_in):
  return logged_in('root', is_admin=True)


def test_admin_creates_a_user_with_a_generated_password(admin, make_client):
  response = admin.post('/api/v1/admin/users', json={"user_name": "bob", "full_name": "Bob B", "email": "bob@example.com"})
  assert response.status_code == 201, response.get_json()
  data = response.get_json()
  assert data["user"]["user_name"] == "bob" and data["user"]["status"] == "active" and data["user"]["is_admin"] is False
  assert data["user"]["login_type"] == "LOCAL"
  assert len(data["password"]) >= 16
  bob = login(make_client(), 'bob', data["password"])
  assert bob.get('/api/v1/user/me/').get_json()["full_name"] == "Bob B"
  [event] = events('user.create')
  assert event.actor_label == 'root' and data["password"] not in str((event.meta, event.changes))


def test_admin_creates_an_admin_with_a_password(admin, make_client):
  response = admin.post('/api/v1/admin/users', json={"user_name": "carol", "password": PASSWORD, "is_admin": True})
  assert response.status_code == 201 and "password" not in response.get_json()
  carol = login(make_client(), 'carol', PASSWORD)
  assert carol.get('/api/v1/user/me/').get_json()["is_admin"] is True


@pytest.mark.parametrize("body, field", [
  ({"user_name": "root"}, "user_name"),
  ({"user_name": "ROOT"}, "user_name"),
  ({"user_name": ""}, "user_name"),
  ({"user_name": "bob", "password": "short"}, "password"),
  ({"user_name": "bob", "email": "root@example.com"}, "email"),
  ({"user_name": "bob", "is_admin": "yes"}, "is_admin"),
])
def test_admin_create_user_validates(admin, body, field):
  response = admin.post('/api/v1/admin/users', json=body)
  assert response.status_code == 400 and response.get_json()["field"] == field


def test_only_admins_create_users(logged_in, client):
  assert client.post('/api/v1/admin/users', json={"user_name": "bob"}).status_code == 401
  alice = logged_in('alice')
  assert alice.post('/api/v1/admin/users', json={"user_name": "bob"}).status_code == 403


def test_admin_resets_a_password(admin, make_user, make_client):
  bob_user = make_user('bob', password=PASSWORD)
  bob = login(make_client(), 'bob', PASSWORD)
  response = admin.post(f'/api/v1/admin/users/{bob_user.id}/password', json={})
  assert response.status_code == 200, response.get_json()
  new_password = response.get_json()["password"]
  assert response.get_json()["signed_out"] == 1
  # signed out, and the old password doesn't work anymore
  assert bob.get('/api/v1/user/me/').get_json()["is_authenticated"] is False
  assert make_client().post('/api/v1/user/auth/', data={"username": "bob", "password": PASSWORD}).status_code == 403
  login(make_client(), 'bob', new_password)
  [event] = events('user.password_reset')
  assert new_password not in str((event.meta, event.changes))


def test_admin_reset_password_only_for_local_accounts(admin, make_user):
  from backend.database import db_session
  ldap_user = make_user('dave')
  ldap_user.login_type = 'LDAP'
  db_session.commit()
  response = admin.post(f'/api/v1/admin/users/{ldap_user.id}/password', json={"password": PASSWORD})
  assert response.status_code == 400 and "local account" in response.get_json()["error"]


def test_admin_cant_reset_their_own_password(admin):
  me = admin.get('/api/v1/user/me/').get_json()
  assert admin.post(f'/api/v1/admin/users/{me["user_id"]}/password', json={}).status_code == 400


# ---------------------------------------------------------------------------
# Users change their password
# ---------------------------------------------------------------------------

def test_user_changes_their_password(make_user, make_client):
  make_user('bob', password=PASSWORD)
  other_browser = login(make_client(), 'bob', PASSWORD)
  bob = login(make_client(), 'bob', PASSWORD)
  response = bob.post('/api/v1/user/password', json={"current_password": PASSWORD, "new_password": "a-new-password"})
  assert response.status_code == 200, response.get_json()
  assert response.get_json()["signed_out"] == 1
  # this browser stays signed in, the others are signed out
  assert bob.get('/api/v1/user/me/').get_json()["is_authenticated"] is True
  assert other_browser.get('/api/v1/user/me/').get_json()["is_authenticated"] is False
  login(make_client(), 'bob', 'a-new-password')


def test_change_password_needs_the_current_one(make_user, make_client):
  make_user('bob', password=PASSWORD)
  bob = login(make_client(), 'bob', PASSWORD)
  response = bob.post('/api/v1/user/password', json={"current_password": "wrong", "new_password": "a-new-password"})
  assert response.status_code == 403 and response.get_json()["field"] == "current_password"
  response = bob.post('/api/v1/user/password', json={"current_password": PASSWORD, "new_password": "short"})
  assert response.status_code == 400 and response.get_json()["field"] == "new_password"
  login(make_client(), 'bob', PASSWORD)


def test_change_password_needs_a_session(client):
  assert client.post('/api/v1/user/password', json={"current_password": "a", "new_password": "b"}).status_code == 401
