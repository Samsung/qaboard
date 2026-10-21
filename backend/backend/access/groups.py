"""
Groups filled by sign-in claims (Appendix D.3): at each sign-in, the user's "rule" memberships are replaced by the
groups whose rules match the claims of the identity they signed in with. Admins' "manual" memberships stay.
"""
from typing import Optional


def claims_of(user, provider_id: str, claims: Optional[dict]) -> dict:
  """The claims rules can match: the identity's (OIDC, SAML), LDAP's attributes, and email_domain"""
  found = dict(claims or {})
  data = getattr(user, 'data', None)
  # LDAP sign-ins keep the directory's answer in users.data: [[dn, {attribute: [values]}]]
  if not found and isinstance(data, list) and data and isinstance(data[0], list) and len(data[0]) == 2 and isinstance(data[0][1], dict):
    found = dict(data[0][1])
  if user.email and '@' in user.email:
    found['email_domain'] = user.email.rsplit('@', 1)[1]
  return found


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
  if rule.claim not in claims:
    return False
  wanted = {str(v).casefold() for v in (rule.values or [])}
  return any(_names(value) & wanted for value in _values(claims[rule.claim]))


def sync(user, provider_id: str, claims: Optional[dict]) -> list:
  """Updates the user's rule memberships (added to the database session: the caller commits). Returns the group names."""
  from backend import db_session
  from ..models import Group, GroupMember, GroupRule
  rules = GroupRule.query.all()
  memberships = {m.group_id: m for m in GroupMember.query.filter(GroupMember.user_id == user.id).all()}
  if not rules and not memberships:
    return []
  found = claims_of(user, provider_id, claims)
  # rule memberships that no rule matches anymore (changed or deleted rules) end
  matched = {rule.group_id for rule in rules if rule_matches(rule, provider_id, found)}
  for group_id, member in memberships.items():
    if member.source == 'rule' and group_id not in matched:
      db_session.delete(member)
  for group_id in matched - set(memberships):
    db_session.add(GroupMember(group_id=group_id, user_id=user.id, source='rule'))
  names = {g.id: g.name for g in Group.query.filter(Group.id.in_(matched)).all()} if matched else {}
  return sorted(names.values())
