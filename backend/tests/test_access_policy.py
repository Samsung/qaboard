"""
The pure parts of backend/access/: roles, paths, and the claims that fill groups.
Who gets which role, from the database: integration_tests/test_access.py.
"""
from types import SimpleNamespace

from backend.access.policy import prefixes, applies_to, highest, allows, required_role, PERMISSIONS, is_valid_project_id
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


def test_project_ids_have_no_dot_segments():
  assert is_valid_project_id('a') and is_valid_project_id('a/b/c-d.e') and is_valid_project_id('a/..b')
  # tolerated when reading, like in prefixes, not for new projects
  assert is_valid_project_id('/a/b/') and not is_valid_project_id('/a/b/', new=True) and is_valid_project_id('a/b', new=True)
  for project_id in ['', '/', 'a/../b', '..', 'a/.', './a', 'a//b', 'a/\0', None, ['a'], 1]:
    assert not is_valid_project_id(project_id), project_id


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


def identity(provider_id, claims, email=None):
  return SimpleNamespace(provider_id=provider_id, claims=claims, email=email)


def test_claims_by_source():
  ldap_user = SimpleNamespace(email="alice@Example.com", data=[["CN=alice,DC=example", {"memberOf": ["CN=camera-algo,OU=Groups"]}]])
  assert claims_by_source(ldap_user) == {"ldap": {"memberOf": ["CN=camera-algo,OU=Groups"], "email_domain": "example.com"}}
  # each sign-in method keeps its claims: signing in with SSO doesn't drop LDAP's groups
  sources = claims_by_source(ldap_user, [identity("sso", {"groups": ["old"]}), identity("ldap", {})], "sso", {"groups": ["x"]})
  assert sources == {
    "sso": {"groups": ["x"], "email_domain": "example.com"},
    "ldap": {"memberOf": ["CN=camera-algo,OU=Groups"], "email_domain": "example.com"},
  }
  assert claims_by_source(SimpleNamespace(email=None, data={})) == {"local": {}}


def test_email_domains_are_only_those_of_verified_emails():
  """Local sign-up stores any email, and some IdPs let users choose theirs"""
  assert claims_by_source(SimpleNamespace(email="mallory@example.com", login_type="LOCAL", data={})) == {"local": {}}
  saml_user = SimpleNamespace(email="alice@example.com", login_type="SAML", data={})
  assert claims_by_source(saml_user, [identity("saml", {})])["saml"]["email_domain"] == "example.com"
  oidc_user = SimpleNamespace(email="bob@example.com", login_type="OIDC", data={})
  unverified = identity("sso", {"email": "bob@example.com", "email_verified": False}, email="bob@example.com")
  assert claims_by_source(oidc_user, [unverified]) == {"sso": {"email": "bob@example.com", "email_verified": False}}
  verified = identity("sso", {"email": "bob@example.com", "email_verified": True}, email="bob@example.com")
  assert claims_by_source(oidc_user, [verified])["sso"]["email_domain"] == "example.com"
  # a local account that links a verified SSO identity
  local_user = SimpleNamespace(email="carol@other.com", login_type="LOCAL", data={})
  linked = identity("sso", {"email": "carol@example.com", "email_verified": True}, email="carol@example.com")
  assert claims_by_source(local_user, [linked])["sso"]["email_domain"] == "example.com"


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
