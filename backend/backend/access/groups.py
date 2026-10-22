"""
Groups filled by rules (Appendix D.3), from what QA-Board knows of each user:
- the claims of each sign-in method's last sign-in (OIDC, SAML), refreshed daily for OIDC providers with `refresh_groups`;
- the directory's attributes (users.data), from LDAP sign-ins, SSO sign-ins matched to LDAP accounts, and the daily sync;
- `email_domain`, of the user's verified emails (sign_in/identities.py: verified_emails).
A rule for one sign-in method reads its claims, a rule for any reads them all: signing in one way doesn't undo the
groups another way gave. Each sync replaces the user's "rule" memberships; admins' "manual" ones stay.
They sync at each sign-in, and daily for everyone (backend/jobs/groups.py).
"""
from dataclasses import dataclass, field
from typing import Optional, List


def directory_attributes(user) -> dict:
  """LDAP's answer, kept in users.data: [[dn, {attribute: [values]}]]"""
  data = getattr(user, 'data', None)
  if isinstance(data, list) and data and isinstance(data[0], list) and len(data[0]) == 2 and isinstance(data[0][1], dict):
    return dict(data[0][1])
  return {}


def claims_by_source(user, identities=(), provider_id: Optional[str] = None, claims: Optional[dict] = None) -> dict:
  """{provider_id: claims}: each identity's last claims, the directory's under `ldap`. `claims`: a sign-in's, newer."""
  sources = {identity.provider_id: dict(identity.claims or {}) for identity in identities}
  directory = directory_attributes(user)
  if directory:
    sources['ldap'] = {**sources.get('ldap', {}), **directory}
  if provider_id is not None:
    sources[provider_id] = {**sources.get(provider_id, {}), **(claims or {})}
  if not sources:
    sources['local'] = {}
  # only verified emails: local sign-up, and some IdPs, let users choose theirs
  from ..sign_in.identities import verified_emails
  domains = sorted({email.rsplit('@', 1)[1] for email in verified_emails(user, identities) if '@' in email})
  if domains:
    for found in sources.values():
      found['email_domain'] = domains[0] if len(domains) == 1 else domains
  return sources


def lookup(claims: dict, name: str):
  """A claim, or a nested one: `realm_access.roles` (Keycloak), `resource_access.qaboard.roles`"""
  if name in claims:
    return claims[name]
  value = claims
  for part in name.split('.'):
    if not isinstance(value, dict) or part not in value:
      return None
    value = value[part]
  return value


def _values(value) -> list:
  values = value if isinstance(value, list) else [value]
  return [str(v) for v in values if v is not None and not isinstance(v, (dict, list))]


def _names(value: str) -> set:
  """A value, and for an LDAP DN (CN=camera-algo,OU=Groups,...) its first name: rules can say just camera-algo"""
  names = {value.casefold()}
  first = value.split(',', 1)[0]
  if '=' in first:
    names.add(first.split('=', 1)[1].strip().casefold())
  return names


def rule_matches(rule, provider_id: str, claims: dict) -> bool:
  if rule.provider_id and rule.provider_id != provider_id:
    return False
  value = lookup(claims, rule.claim)
  if value is None:
    return False
  wanted = {str(v).casefold() for v in (rule.values or [])}
  return any(_names(v) & wanted for v in _values(value))


def matches_any(rule, sources: dict) -> bool:
  return any(rule_matches(rule, provider_id, claims) for provider_id, claims in sources.items())


def groups_overage(claims: Optional[dict]) -> bool:
  """Microsoft Entra ID sends no groups when users are in too many (over 200): it points to Graph instead"""
  return isinstance(claims, dict) and ('groups' in (claims.get('_claim_names') or {}) or claims.get('hasgroups') in (True, 'true'))


@dataclass
class Synced:
  groups: List[str] = field(default_factory=list)  # all the rule groups the user is in
  added: List[str] = field(default_factory=list)
  removed: List[str] = field(default_factory=list)


def sync(user, provider_id: Optional[str] = None, claims: Optional[dict] = None, rules=None, names=None) -> Synced:
  """
  Updates the user's rule memberships (added to the database session: the caller commits).
  `provider_id`, `claims`: a sign-in's. `rules`, `names` ({group_id: name}): when syncing many users.
  """
  from backend import db_session
  from ..models import Group, GroupMember, GroupRule, UserIdentity
  rules = GroupRule.query.all() if rules is None else rules
  memberships = {m.group_id: m for m in GroupMember.query.filter(GroupMember.user_id == user.id).all()}
  if not rules and not memberships:
    return Synced()
  identities = UserIdentity.query.filter(UserIdentity.user_id == user.id).all()
  sources = claims_by_source(user, identities, provider_id, claims)
  # rule memberships that no rule matches anymore (changed or deleted rules) end
  matched = {rule.group_id for rule in rules if matches_any(rule, sources)}
  removed, added = [], []
  for group_id, member in memberships.items():
    if member.source == 'rule' and group_id not in matched:
      db_session.delete(member)
      removed.append(group_id)
  for group_id in matched - set(memberships):
    db_session.add(GroupMember(group_id=group_id, user_id=user.id, source='rule'))
    added.append(group_id)
  if names is None:
    ids = matched | set(removed)
    names = {g.id: g.name for g in Group.query.filter(Group.id.in_(ids)).all()} if ids else {}
  name = lambda group_id: names.get(group_id, f"#{group_id}")
  return Synced(groups=sorted(name(i) for i in matched), added=sorted(name(i) for i in added), removed=sorted(name(i) for i in removed))
