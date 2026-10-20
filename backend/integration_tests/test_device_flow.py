"""`qa auth login`: the OAuth device flow (RFC 8628)"""
import datetime

from .conftest import bearer


def start(client, **body):
  response = client.post('/api/v1/auth/device/code', json={"client_name": "qa CLI on host-12", "hostname": "host-12", **body})
  assert response.status_code == 200
  return response.get_json()


def poll(client, device_code):
  return client.post('/api/v1/auth/device/token', json={"device_code": device_code})


def allow_polling_now(device_code):
  # tests don't wait for the polling interval
  from backend.database import db_session
  from backend.models import DeviceAuthorization
  from backend.tokens import hash_token
  DeviceAuthorization.query.filter_by(device_code_hash=hash_token(device_code)).update({"last_polled_at": None})
  db_session.commit()


def test_device_flow(logged_in, make_client):
  cli = make_client()
  code = start(cli)
  assert len(code["user_code"]) == 9 and code["user_code"][4] == "-"
  assert code["verification_uri"] == "http://localhost/device"
  assert code["verification_uri_complete"].endswith(f"?code={code['user_code']}")
  assert code["interval"] == 5 and code["expires_in"] == 900

  response = poll(cli, code["device_code"])
  assert response.status_code == 400 and response.get_json()["error"] == "authorization_pending"
  # polling faster than the interval
  assert poll(cli, code["device_code"]).get_json()["error"] == "slow_down"

  browser = logged_in('alice')
  # users can type the code without the dash, in lower case
  details = browser.get(f'/api/v1/auth/device?code={code["user_code"].replace("-", "").lower()}').get_json()
  assert details["client_name"] == "qa CLI on host-12" and details["status"] == "pending"
  assert details["scopes"] == ["read", "ingest", "act"]
  assert browser.post('/api/v1/auth/device', json={"code": code["user_code"], "approve": True}).get_json() == {"status": "approved"}

  allow_polling_now(code["device_code"])
  response = poll(cli, code["device_code"])
  assert response.status_code == 200, response.get_json()
  answer = response.get_json()
  assert answer["token_type"] == "Bearer" and answer["user_name"] == "alice" and answer["access_token"].startswith("qab_pat_")
  assert answer["idle_expiry_days"] == 180 and answer["expires_at"] is None

  me = make_client().get('/api/v1/user/me/', headers=bearer(answer["access_token"])).get_json()
  assert me["user_name"] == "alice" and me["token"]["kind"] == "cli" and me["token"]["id"] == answer["token_id"]
  assert me["token"]["name"] == "qa CLI on host-12"

  # the code can't be used again
  allow_polling_now(code["device_code"])
  assert poll(cli, code["device_code"]).get_json()["error"] == "expired_token"
  # the approval is in the user's audit, by the user
  actions = [e["action"] for e in browser.get('/api/v1/user/audit').get_json()["events"]]
  assert "device.approve" in actions and "token.create" in actions


def test_denied(logged_in, make_client):
  cli = make_client()
  code = start(cli)
  browser = logged_in('alice')
  assert browser.post('/api/v1/auth/device', json={"code": code["user_code"], "approve": False}).get_json() == {"status": "denied"}
  allow_polling_now(code["device_code"])
  assert poll(cli, code["device_code"]).get_json()["error"] == "access_denied"
  # decided already
  assert browser.post('/api/v1/auth/device', json={"code": code["user_code"], "approve": True}).status_code == 409


def test_expired_codes(logged_in, make_client):
  from backend.database import db_session
  from backend.models import DeviceAuthorization
  cli = make_client()
  code = start(cli)
  DeviceAuthorization.query.update({"expires_at": datetime.datetime.utcnow() - datetime.timedelta(seconds=1)})
  db_session.commit()
  browser = logged_in('alice')
  assert browser.get(f'/api/v1/auth/device?code={code["user_code"]}').get_json()["status"] == "expired"
  assert browser.post('/api/v1/auth/device', json={"code": code["user_code"], "approve": True}).status_code == 409
  assert poll(cli, code["device_code"]).get_json()["error"] == "expired_token"


def test_approving_needs_a_browser_session(logged_in, make_client):
  from .conftest import new_token
  code = start(make_client())
  secret = new_token(logged_in('alice'))["token"]
  response = make_client().post('/api/v1/auth/device', json={"code": code["user_code"], "approve": True}, headers=bearer(secret))
  assert response.status_code == 403 and response.get_json()["reason"] == "session_required"
  assert make_client().post('/api/v1/auth/device', json={"code": code["user_code"], "approve": True}).status_code == 401
  assert logged_in('bob').get('/api/v1/auth/device?code=BBBB-BBBB').status_code == 404


def test_unknown_device_codes(client):
  assert poll(client, "nope").get_json()["error"] == "invalid_grant"
  assert client.post('/api/v1/auth/device/token', json={}).get_json()["error"] == "invalid_request"


def test_the_device_flow_works_when_sign_in_is_required(logged_in, make_client, monkeypatch):
  monkeypatch.setenv('QABOARD_LOGIN_REQUIRED', 'true')
  cli = make_client()
  code = start(cli)
  assert poll(cli, code["device_code"]).get_json()["error"] == "authorization_pending"
