"""
The pure parts of backend/access/: roles, paths, and the claims that fill groups.
Who gets which role, from the database: integration_tests/test_access.py.
"""
from types import SimpleNamespace

from backend.access.policy import prefixes, applies_to, highest, allows, required_role, PERMISSIONS
from backend.access.groups import rule_matches, claims_of


def test_roles_are_ordered():
  assert highest(None, 'viewer', 'owner', 'developer') == 'owner'
  assert highest() is None
  assert allows('developer', 'runs.act') and allows('owner', 'runs.act')
  assert not allows('viewer', 'runs.act') and not allows(None, 'project.read')
  assert required_role('project.access') == 'owner'
  # every permission has a role and a token scope
  assert all(len(value) == 2 for value in PERMISSIONS.values())


def test_grants_apply_by_path_segments():
  assert prefixes('a/b/c') == ['a/b/c', 'a/b', 'a']
  assert prefixes('/a/b/') == ['a/b', 'a']
  assert prefixes('') == []
  assert applies_to('a/b', 'a/b') and applies_to('a/b', 'a/b/c') and applies_to('a/', 'a/b')
  assert not applies_to('a/b', 'a/bc') and not applies_to('a/b/c', 'a/b') and not applies_to('', 'a')


def rule(claim, values, provider_id=None):
  return SimpleNamespace(claim=claim, values=values, provider_id=provider_id)


def test_rules_match_claims():
  claims = {"groups": ["camera-team", "Everyone"], "email_domain": "example.com"}
  assert rule_matches(rule("groups", ["CAMERA-team"]), "sso", claims)
  assert rule_matches(rule("email_domain", ["example.com"]), "local", claims)
  assert not rule_matches(rule("groups", ["isp-team"]), "sso", claims)
  assert not rule_matches(rule("department", ["ISP"]), "sso", claims)
  # only for one sign-in method
  assert rule_matches(rule("groups", ["camera-team"], provider_id="sso"), "sso", claims)
  assert not rule_matches(rule("groups", ["camera-team"], provider_id="sso"), "ldap", claims)


def test_rules_match_ldap_dns_by_their_name():
  claims = {"memberOf": ["CN=camera-algo,OU=Groups,DC=example,DC=com"]}
  assert rule_matches(rule("memberOf", ["camera-algo"]), "ldap", claims)
  assert rule_matches(rule("memberOf", ["cn=camera-algo,ou=groups,dc=example,dc=com"]), "ldap", claims)
  assert not rule_matches(rule("memberOf", ["Groups"]), "ldap", claims)


def test_claims_of_ldap_accounts_and_emails():
  ldap_user = SimpleNamespace(email="alice@Example.com", data=[["CN=alice,DC=example", {"memberOf": ["CN=camera-algo,OU=Groups"]}]])
  assert claims_of(ldap_user, "ldap", None) == {"memberOf": ["CN=camera-algo,OU=Groups"], "email_domain": "Example.com"}
  # an identity's claims win over the directory's answer
  assert claims_of(ldap_user, "sso", {"groups": ["x"]}) == {"groups": ["x"], "email_domain": "Example.com"}
  assert claims_of(SimpleNamespace(email=None, data={}), "local", None) == {}
