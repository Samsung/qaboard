"""
The pure parts of backend/access/: roles, paths, and the claims that fill groups.
Who gets which role, from the database: integration_tests/test_access.py.
"""
from types import SimpleNamespace

from backend.access.policy import prefixes, applies_to, highest, allows, required_role, PERMISSIONS
from backend.access.groups import rule_matches, claims_by_source, matches_any, groups_overage


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


def test_rules_read_nested_claims():
  claims = {"realm_access": {"roles": ["camera"]}, "resource_access": {"qaboard": {"roles": ["admin"]}}}
  assert rule_matches(rule("realm_access.roles", ["camera"]), "sso", claims)
  assert rule_matches(rule("resource_access.qaboard.roles", ["admin"]), "sso", claims)
  assert not rule_matches(rule("realm_access.groups", ["camera"]), "sso", claims)
  assert not rule_matches(rule("realm_access", ["camera"]), "sso", claims)


def identity(provider_id, claims):
  return SimpleNamespace(provider_id=provider_id, claims=claims)


def test_claims_by_source():
  ldap_user = SimpleNamespace(email="alice@Example.com", data=[["CN=alice,DC=example", {"memberOf": ["CN=camera-algo,OU=Groups"]}]])
  assert claims_by_source(ldap_user) == {"ldap": {"memberOf": ["CN=camera-algo,OU=Groups"], "email_domain": "Example.com"}}
  # each sign-in method keeps its claims: signing in with SSO doesn't drop LDAP's groups
  sources = claims_by_source(ldap_user, [identity("sso", {"groups": ["old"]}), identity("ldap", {})], "sso", {"groups": ["x"]})
  assert sources == {
    "sso": {"groups": ["x"], "email_domain": "Example.com"},
    "ldap": {"memberOf": ["CN=camera-algo,OU=Groups"], "email_domain": "Example.com"},
  }
  assert claims_by_source(SimpleNamespace(email=None, data={})) == {"local": {}}


def test_rules_for_one_sign_in_method_read_its_claims():
  sources = {"sso": {"groups": ["camera"]}, "ldap": {"memberOf": ["CN=isp,OU=Groups"]}}
  assert matches_any(rule("memberOf", ["isp"]), sources)
  assert matches_any(rule("memberOf", ["isp"], provider_id="ldap"), sources)
  assert not matches_any(rule("memberOf", ["isp"], provider_id="sso"), sources)
  assert matches_any(rule("groups", ["camera"], provider_id="sso"), sources)


def test_entra_groups_overage():
  assert groups_overage({"_claim_names": {"groups": "src1"}, "_claim_sources": {"src1": {}}})
  assert groups_overage({"hasgroups": True})
  assert not groups_overage({"groups": ["a"]}) and not groups_overage(None)
