"""
Users' profiles and pictures from their sign-in methods (backend/sign_in/profiles.py): saved at sign-in, refreshed,
served by QA-Board. And the order of the sign-in methods (Admin → Sign-in).
"""
import base64
import struct
import zlib

import pytest
import responses

from .conftest import login
from .test_oidc import idp, ISSUER  # noqa: F401 (the fixture)


def png(color=(255, 0, 0)) -> bytes:
  """A 1x1 PNG"""
  def chunk(kind, data):
    return struct.pack('>I', len(data)) + kind + data + struct.pack('>I', zlib.crc32(kind + data) & 0xffffffff)
  raw = b'\x00' + bytes(color)
  return (b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', 1, 1, 8, 2, 0, 0, 0))
          + chunk(b'IDAT', zlib.compress(raw)) + chunk(b'IEND', b''))


PICTURE_URL = 'https://cdn.example.com/alice.png'


def picture_calls(idp, url=PICTURE_URL):
  return [c for c in idp.mocked.calls if c.request.url == url]


def test_oidc_sign_in_saves_the_profile_and_picture(idp, make_client):
  from backend.models import User, UserIdentity
  idp.mocked.add(responses.GET, PICTURE_URL, body=png(), content_type='image/png')
  idp.claims = {"picture": PICTURE_URL, "title": "Algorithm engineer", "department": "Camera",
                # Keycloak's organization claim: {alias: {...}}
                "organization": {"sirc": {"id": "1"}}}
  client = make_client()
  idp.sign_in(client)
  me = client.get('/api/v1/user/me/').get_json()
  assert me["avatar_url"].startswith(f"/api/v1/users/{me['user_id']}/picture?v=")
  assert me["profile"]["title"] == "Algorithm engineer" and me["profile"]["department"] == "Camera"
  assert me["profile"]["organization"] == "sirc"
  assert me["profile"]["picture_source"] == "Single sign-on"
  # served by QA-Board, cached by browsers
  response = client.get(me["avatar_url"])
  assert response.status_code == 200 and response.data == png() and response.headers['Content-Type'] == 'image/png'
  assert response.headers['X-Content-Type-Options'] == 'nosniff' and 'ETag' in response.headers
  assert client.get(me["avatar_url"], headers={"If-None-Match": response.headers['ETag']}).status_code == 304
  # the picture's URL isn't on the IdP: it doesn't get the user's access token
  assert 'Authorization' not in picture_calls(idp)[0].request.headers

  # next sign-in: the same URL isn't downloaded again the same day, the name and title follow the IdP
  idp.claims = {**idp.claims, "name": "Alice Smith", "title": "Team lead"}
  idp.sign_in(make_client())
  assert len(picture_calls(idp)) == 1
  user = User.query.one()
  assert user.full_name == "Alice Smith" and user.profile["title"] == "Team lead"
  assert UserIdentity.query.one().claims["picture"] == PICTURE_URL


def test_picture_url_is_read_with_the_access_token(idp, make_client, monkeypatch):
  """Microsoft Entra ID: the photo is in Microsoft Graph, read with the user's access token"""
  graph = 'https://graph.microsoft.com/v1.0/me/photo/$value'
  monkeypatch.setenv('QABOARD_OIDC_PICTURE_URL', graph)
  jpeg = b'\xff\xd8\xff\xe0' + b'0' * 100
  idp.mocked.add(responses.GET, graph, body=jpeg, content_type='image/jpeg')
  client = make_client()
  idp.sign_in(client)
  call = picture_calls(idp, graph)[0]
  assert call.request.headers['Authorization'] == 'Bearer at'
  me = client.get('/api/v1/user/me/').get_json()
  assert client.get(me["avatar_url"]).data == jpeg


def test_pictures_that_arent_images_are_ignored(idp, make_client):
  svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
  idp.claims = {"picture": "data:image/svg+xml;base64," + base64.b64encode(svg.encode()).decode()}
  client = make_client()
  response = idp.sign_in(client)
  # never a reason to refuse a sign-in
  assert response.status_code == 302 and response.headers['Location'] == '/group/repo/commits'
  assert client.get('/api/v1/user/me/').get_json()["avatar_url"] is None


def test_data_uri_pictures_arent_kept_in_the_claims(idp, make_client):
  from backend.models import UserIdentity
  picture = "data:image/png;base64," + base64.b64encode(png() + b'\x00' * 2000).decode()
  idp.claims = {"picture": picture}
  client = make_client()
  idp.sign_in(client)
  assert client.get('/api/v1/user/me/').get_json()["avatar_url"]
  assert 'picture' not in UserIdentity.query.one().claims


def test_pictures_need_a_signed_in_user(make_user, make_client):
  from backend.database import db_session
  from backend.sign_in import profiles
  user = make_user('alice')
  assert profiles.save_picture(user, png(), 'ldap')
  db_session.commit()
  url = profiles.avatar_url(user)
  assert make_client().get(url).status_code == 401
  make_user('bob')
  assert login(make_client(), 'bob').get(url).status_code == 200
  assert login(make_client(), 'bob').get('/api/v1/users/999999/picture').status_code == 404


def test_ldap_profile_and_picture(monkeypatch, make_user):
  """LDAP's thumbnailPhoto is bytes: it's kept out of users.data, served by QA-Board"""
  from backend.api import auth
  from backend.database import db_session
  from backend.models import User
  monkeypatch.setattr(auth, 'ldap_attr_common_name', 'cn', raising=False)
  monkeypatch.setattr(auth, 'ldap_attr_email', 'mail', raising=False)
  monkeypatch.setenv('QABOARD_LDAP_ATTRIBUTE_ORGANIZATION', 'company')
  details = [["CN=alice,DC=example,DC=com", {
    "cn": [b"Alice Doe"], "mail": [b"alice@example.com"], "memberOf": [b"CN=camera"],
    "thumbnailPhoto": [png()], "title": [b"Engineer"], "department": [b"Camera"], "company": [b"SIRC"],
  }]]
  info = auth.ldap_user_info(details, {"user_name": "alice", "login_type": "LDAP"})
  assert info["profile"] == {"title": b"Engineer", "department": b"Camera", "organization": b"SIRC"}
  assert info["picture"] == png()
  assert 'thumbnailPhoto' not in info["data"][0][1] and info["data"][0][1]["memberOf"] == ["CN=camera"]
  user = auth.create_user({**info, "login_type": "LDAP"})
  user = db_session.get(User, user.id)
  assert user.profile["title"] == "Engineer" and user.profile["organization"] == "SIRC" and user.profile["source"] == "ldap"
  assert user.profile["picture"]["source"] == "ldap"


def test_profile_values():
  from backend.sign_in.profiles import text, picture_from, sniff, first_value
  assert text(["a", "", "b"]) == "a, b" and text({"x": {}}) == "x" and text(b"\xff") is None and text("  ") is None
  assert picture_from("https://x/y.png") == (None, "https://x/y.png")
  assert picture_from(base64.b64encode(png()).decode())[0] == png()
  assert sniff(b'<svg') is None and sniff(png()) == 'image/png'
  assert first_value({"ThumbnailPhoto": [b"1"]}, ["thumbnailphoto"]) == ("ThumbnailPhoto", b"1")


def test_admins_reorder_the_sign_in_methods(idp, make_user, make_client, monkeypatch):
  make_user('root', is_admin=True)
  admin = login(make_client(), 'root')
  ids = lambda answer: [p["id"] for p in answer["providers"]]
  # by default: the single sign-on first, local accounts last
  assert ids(admin.get('/api/v1/admin/sign-in').get_json()) == ['sso', 'local']
  response = admin.post('/api/v1/admin/sign-in/order', json={"order": ['local']})
  assert response.status_code == 200, response.get_json()
  # the ones not listed come after
  assert ids(response.get_json()) == ['local', 'sso']
  assert ids(make_client().get('/api/v1/auth/providers?local=1').get_json()) == ['local', 'sso']
  assert admin.post('/api/v1/admin/sign-in/order', json={"order": ['nope']}).status_code == 400
  make_user('bob')
  assert login(make_client(), 'bob').post('/api/v1/admin/sign-in/order', json={"order": ['sso']}).status_code == 403
  from backend.models import AuditEvent
  assert AuditEvent.query.filter_by(action='setting.update', target_id='auth.provider_order').count() == 1
