"""
Users' groups, updated daily and when rules change (backend/jobs/groups.py): from LDAP's answer now, and from OIDC
providers' refresh tokens. Signing in one way doesn't undo the groups another way gave.
"""
import pytest

from .conftest import login
from .test_jobs import run_jobs
from .test_oidc import idp  # noqa: F401 (fixture)


@pytest.fixture
def root(logged_in, monkeypatch):
  monkeypatch.setenv('QABOARD_ADMINS', 'root')
  return logged_in('root')


def new_group(root, name, **rule):
  group = root.post('/api/v1/admin/groups', json={"name": name}).get_json()
  if rule:
    response = root.post(f'/api/v1/admin/groups/{group["id"]}/rules', json=rule)
    assert response.status_code == 201, response.get_json()
    group["rule"] = response.get_json()
  return group


def members(root, group):
  return sorted((m["user"]["user_name"], m["source"]) for m in root.get(f'/api/v1/admin/groups/{group["id"]}').get_json()["members"])


def ldap_entry(user_name, *groups):
  return [[f"CN={user_name},OU=Users,DC=example,DC=com", {"cn": [user_name.title()], "mail": [f"{user_name}@example.com"],
           "memberOf": [f"CN={g},OU=Groups,DC=example,DC=com" for g in groups]}]]


@pytest.fixture
def directory(monkeypatch):
  """A fake LDAP: {user_name: [group names]}. Users missing from it aren't found."""
  from backend.api import auth
  known = {}
  def lookups(user_names):
    for user_name in user_names:
      if user_name in known:
        yield user_name, {"user_name": user_name, "full_name": user_name.title(), "email": f"{user_name}@example.com",
                          "login_type": "LDAP", "data": ldap_entry(user_name, *known[user_name])}
      else:
        yield user_name, None
  monkeypatch.setattr(auth, 'login_type', 'LDAP')
  monkeypatch.setenv('QABOARD_LOGIN_TYPE', 'LDAP')
  monkeypatch.setattr(auth, 'ldap_lookups', lookups)
  return known


def test_the_worker_schedules_it_daily(monkeypatch):
  from backend.models import JobSchedule
  monkeypatch.setenv('QABOARD_GROUPS_SYNC_AUTO', '1')
  run_jobs()
  assert [(s.kind, s.cron) for s in JobSchedule.query.all()] == [('sync_groups', '41 4 * * *')]


def test_rule_changes_apply_to_everyone(root, make_user):
  """No need to wait for users to sign in again"""
  # the domains of verified emails: here SAML's, not the local accounts' (root)
  make_user('alice', login_type='SAML')
  make_user('bob', email='bob@other.com', login_type='SAML')
  group = new_group(root, 'example', claim='email_domain', values=['example.com'])
  assert group["rule"]["sync_job"]["kind"] == 'sync_groups'
  run_jobs()
  assert members(root, group) == [('alice', 'rule')]
  sync = root.get('/api/v1/admin/groups').get_json()["sync"]
  assert sync["last_job"]["status"] == 'done'
  root.delete(f'/api/v1/admin/groups/{group["id"]}/rules/{group["rule"]["id"]}')
  run_jobs()
  assert members(root, group) == []
  from backend.models import AuditEvent
  assert AuditEvent.query.filter_by(action='groups.sync').count() == 2


def test_the_daily_sync_reads_ldap(root, make_user, directory):
  for name in ('alice', 'bob', 'carol', 'dave', 'erin'):
    make_user(name, login_type='LDAP')
  directory.update(alice=['camera-algo'], bob=['isp'], carol=[], dave=[], erin=[])
  camera = new_group(root, 'camera', claim='memberOf', values=['camera-algo'], provider_id='ldap')
  run_jobs()
  assert members(root, camera) == [('alice', 'rule')]
  # the directory changed: bob joined, alice left the company
  directory['bob'].append('camera-algo')
  del directory['alice']
  from backend.jobs import queue
  from backend.database import db_session
  queue.create('sync_groups', {})
  db_session.commit()
  run_jobs()
  assert members(root, camera) == [('bob', 'rule')]
  from backend.models import User
  assert User.query.filter_by(user_name='alice').one().data == []


def test_ldap_outages_change_nothing(root, make_user, directory):
  for name in ('alice', 'bob', 'carol', 'dave', 'erin'):
    make_user(name, login_type='LDAP')
  directory.update(alice=['camera-algo'], bob=[], carol=[], dave=[], erin=[])
  camera = new_group(root, 'camera', claim='memberOf', values=['camera-algo'])
  run_jobs()
  assert members(root, camera) == [('alice', 'rule')]
  # e.g. a wrong base: it finds nobody
  directory.clear()
  from backend.jobs import queue
  from backend.database import db_session
  job_id = queue.create('sync_groups', {}).id
  db_session.commit()
  run_jobs()
  assert members(root, camera) == [('alice', 'rule')]
  from backend.models import Job
  assert db_session.get(Job, job_id).status == 'done_with_errors'


def test_ldap_reads_nested_groups(monkeypatch):
  """Active Directory: the groups of the user's groups, with LDAP_MATCHING_RULE_IN_CHAIN"""
  from backend.api import auth
  monkeypatch.setattr(auth, 'ldap_user_base', 'DC=example,DC=com', raising=False)
  monkeypatch.setattr(auth, 'ldap_user_filter', '(sAMAccountName={login})', raising=False)
  monkeypatch.setattr(auth, 'ldap_attr_common_name', 'cn', raising=False)
  monkeypatch.setattr(auth, 'ldap_attr_email', 'mail', raising=False)
  monkeypatch.setattr(auth, 'ldap_group_attributes', ['memberOf'], raising=False)
  monkeypatch.setenv('QABOARD_LDAP_NESTED_GROUPS', '1')
  searches = []
  class Connection:
    def search_s(self, base, scope, query, attributes):
      searches.append((query, attributes))
      if query.startswith('(sAMAccountName='):
        return [("CN=alice,DC=example,DC=com", {"memberOf": [b"CN=camera-algo,OU=Groups,DC=example,DC=com"]}), (None, ["ldap://referral"])]
      return [("CN=camera-algo,OU=Groups,DC=example,DC=com", {}), ("CN=algo,OU=Groups,DC=example,DC=com", {})]
  details = auth.ldap_details(Connection(), 'alice')
  assert details[0][1]["memberOf"] == [b"CN=camera-algo,OU=Groups,DC=example,DC=com", b"CN=algo,OU=Groups,DC=example,DC=com"]
  assert searches[0] == ('(sAMAccountName=alice)', ['cn', 'mail', 'memberOf'])
  assert searches[1][0] == '(member:1.2.840.113556.1.4.1941:=CN=alice,DC=example,DC=com)'


def test_sso_and_ldap_dont_undo_each_other(idp, root, make_user, make_client, directory, monkeypatch):
  """At SIRC: SSO accounts are the LDAP accounts. The directory's groups stay when users sign in with SSO."""
  monkeypatch.setenv('QABOARD_OIDC_MATCH_USERS', 'username')
  make_user('alice', login_type='LDAP')
  directory.update(alice=['camera-algo'])
  camera = new_group(root, 'camera', claim='memberOf', values=['camera-algo'])
  sso = new_group(root, 'sso-camera', claim='groups', values=['/camera'], provider_id='sso')
  run_jobs()
  assert members(root, camera) == [('alice', 'rule')]
  idp.sign_in(make_client())
  assert members(root, camera) == [('alice', 'rule')] and members(root, sso) == [('alice', 'rule')]
  # the daily sync keeps both: the SSO groups from the last sign-in
  from backend.jobs import queue
  from backend.database import db_session
  queue.create('sync_groups', {})
  db_session.commit()
  run_jobs()
  assert members(root, camera) == [('alice', 'rule')] and members(root, sso) == [('alice', 'rule')]


def test_sso_groups_refresh_daily(idp, root, make_client, monkeypatch):
  monkeypatch.setenv('QABOARD_OIDC_REFRESH_GROUPS', '1')
  monkeypatch.setenv('QABOARD_ENCRYPTION_KEY', 'a key for tests')
  camera = new_group(root, 'camera', claim='groups', values=['/camera'], provider_id='sso')
  run_jobs()
  client = make_client()
  idp.sign_in(client)
  assert 'offline_access' in idp.last_start['scope'].split()
  from backend.models import UserIdentity
  from backend.database import db_session
  identity = UserIdentity.query.filter_by(provider_id='sso').one()
  identity_id = identity.id
  assert identity.refresh_token_encrypted and 'rt-1' not in identity.refresh_token_encrypted
  assert members(root, camera) == [('alice', 'rule')]
  # alice moved teams at the IdP
  idp.claims = {"groups": ["/isp"]}
  from backend.jobs import queue
  queue.create('sync_groups', {})
  db_session.commit()
  run_jobs()
  assert idp.refreshed == 1
  assert members(root, camera) == []
  identity = db_session.get(UserIdentity, identity_id)
  assert identity.claims["groups"] == ["/isp"]
  assert client.get('/api/v1/user/me/').get_json()["user_name"] == "alice"
  # alice was disabled at the IdP: her groups from it end, and her QA-Board sessions from it
  idp.claims = {}
  queue.create('sync_groups', {})
  db_session.commit()
  run_jobs()
  assert members(root, camera) == [('alice', 'rule')]
  idp.refresh_refused = True
  queue.create('sync_groups', {})
  db_session.commit()
  run_jobs()
  assert members(root, camera) == []
  identity = db_session.get(UserIdentity, identity_id)
  assert identity.refresh_token_encrypted is None and identity.claims == {}
  assert client.get("/api/v1/user/me/").get_json()["is_anonymous"]
  # signing in again gives them back
  idp.refresh_refused = False
  idp.sign_in(make_client())
  assert members(root, camera) == [('alice', 'rule')]


def test_refreshing_groups_needs_the_encryption_key(root, monkeypatch):
  monkeypatch.delenv('QABOARD_ENCRYPTION_KEY', raising=False)
  response = root.post('/api/v1/admin/sign-in/providers', json={
    "id": "keycloak", "name": "Keycloak", "issuer": "https://idp.example.com/realms/x", "client_id": "qaboard", "refresh_groups": True,
  })
  assert response.status_code == 400 and 'QABOARD_ENCRYPTION_KEY' in response.get_json()["error"]
