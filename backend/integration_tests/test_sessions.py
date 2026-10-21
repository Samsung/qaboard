"""Browser sessions stored in the database: listed, revoked, sliding, and converted from the older cookies"""
import datetime

from .conftest import login, bearer, new_token


def test_sessions_are_listed_and_revoked(logged_in, make_client):
  alice = logged_in('alice')
  other = login(make_client(), 'alice')
  sessions = alice.get('/api/v1/user/sessions').get_json()["sessions"]
  assert len(sessions) == 2 and sum(s["current"] for s in sessions) == 1
  other_id = next(s["id"] for s in sessions if not s["current"])
  assert alice.delete(f'/api/v1/user/sessions/{other_id}').status_code == 200
  # the other browser is signed out at its next request
  assert other.get('/api/v1/user/tokens').status_code == 401
  assert alice.get('/api/v1/user/tokens').status_code == 200


def test_signing_out_everywhere_else(logged_in, make_client):
  alice = logged_in('alice')
  others = [login(make_client(), 'alice') for _ in range(2)]
  bob = logged_in('bob')
  assert alice.delete('/api/v1/user/sessions').get_json() == {"revoked": 2}
  assert all(other.get('/api/v1/user/tokens').status_code == 401 for other in others)
  assert alice.get('/api/v1/user/tokens').status_code == 200
  assert bob.get('/api/v1/user/tokens').status_code == 200
  # a token can't sign its user out of their browsers
  token = new_token(alice, scopes=["read", "act"])
  assert make_client().delete('/api/v1/user/sessions', headers=bearer(token["token"])).status_code == 403


def test_sign_out_revokes_the_session(logged_in):
  from backend.models import UserSession
  alice = logged_in('alice')
  cookie = alice.get_cookie('session')
  assert alice.post('/api/v1/user/logout/').status_code == 200
  assert UserSession.query.one().revoked_at is not None
  # a copy of the old cookie doesn't work
  alice.set_cookie('session', cookie.value)
  assert alice.get('/api/v1/user/tokens').status_code == 401


def test_idle_and_old_sessions_end(logged_in):
  from backend.database import db_session
  from backend.models import UserSession
  alice = logged_in('alice')
  UserSession.query.update({"last_seen_at": datetime.datetime.utcnow() - datetime.timedelta(days=31)})
  db_session.commit()
  response = alice.get('/api/v1/user/tokens')
  assert response.status_code == 401 and response.get_json()["reason"] == "session_expired"
  bob = logged_in('bob')
  UserSession.query.filter(UserSession.revoked_at.is_(None)).update({"expires_at": datetime.datetime.utcnow() - datetime.timedelta(seconds=1)})
  db_session.commit()
  assert bob.get('/api/v1/user/tokens').status_code == 401


def test_sessions_slide(logged_in):
  from backend.database import db_session
  from backend.models import UserSession
  alice = logged_in('alice')
  old = datetime.datetime.utcnow() - datetime.timedelta(days=29)
  UserSession.query.update({"last_seen_at": old})
  db_session.commit()
  assert alice.get('/api/v1/user/tokens').status_code == 200
  assert UserSession.query.one().last_seen_at > old


def test_disabling_a_user_revokes_their_sessions(logged_in, make_user, monkeypatch):
  monkeypatch.setenv('QABOARD_ADMINS', 'root')
  root = logged_in('root')
  alice = logged_in('alice')
  from backend.models import User, UserSession
  alice_id = User.query.filter(User.user_name == 'alice').one().id
  assert root.post(f'/api/v1/admin/users/{alice_id}', json={"status": "disabled"}).status_code == 200
  assert UserSession.query.filter(UserSession.user_id == alice_id, UserSession.revoked_at.is_(None)).count() == 0
  root.post(f'/api/v1/admin/users/{alice_id}', json={"status": "active"})
  # the old session doesn't come back
  assert alice.get('/api/v1/user/tokens').status_code == 401


def test_admins_revoke_sessions(logged_in, monkeypatch):
  monkeypatch.setenv('QABOARD_ADMINS', 'root')
  root = logged_in('root')
  alice = logged_in('alice')
  from backend.models import User
  alice_id = User.query.filter(User.user_name == 'alice').one().id
  assert root.post(f'/api/v1/admin/users/{alice_id}/revoke-sessions').get_json() == {"revoked": 1}
  assert alice.get('/api/v1/user/tokens').status_code == 401


def test_older_sessions_become_stored_sessions(make_user, make_client):
  """Cookies from before sessions were stored (flask-login's) keep working: nobody is signed out by the upgrade"""
  from backend.models import User, UserSession
  user_id = make_user('alice').id
  client = make_client()
  with client.session_transaction() as cookie_session:
    cookie_session['_user_id'] = str(user_id)
    cookie_session['_fresh'] = True
  assert client.get('/api/v1/user/me/').get_json()["user_name"] == "alice"
  assert UserSession.query.count() == 1
  with client.session_transaction() as cookie_session:
    assert '_user_id' not in cookie_session and cookie_session.get('sid')
  assert client.get('/api/v1/user/tokens').status_code == 200


def test_token_requests_dont_create_sessions(logged_in, make_client):
  from backend.models import UserSession
  token = new_token(logged_in('alice'))
  before = UserSession.query.count()
  make_client().get('/api/v1/user/me/', headers=bearer(token["token"]))
  assert UserSession.query.count() == before


def test_signing_in_twice_gives_a_new_session_id(logged_in):
  """Session ids planted before the sign-in can't be reused (fixation)"""
  alice = logged_in('alice')
  with alice.session_transaction() as cookie_session:
    first = cookie_session['sid']
  login(alice, 'alice')
  with alice.session_transaction() as cookie_session:
    assert cookie_session['sid'] != first
