"""
Instance admins: users with `is_admin`, and those listed in $QABOARD_ADMINS (comma-separated user names, emails, or
single sign-on identities as <provider id>:<subject>, e.g. sso:0b6f...).
The environment's list is the break-glass access: they're admins whatever the database says.
"""
import os


def env_admins() -> set:
  return {a.strip() for a in os.environ.get('QABOARD_ADMINS', '').split(',') if a.strip()}


def is_env_admin(user) -> bool:
  """
  User names must match exactly: local sign-up could create "ALICE" next to "alice" (and can't create listed names).
  Emails only count when they're verified (directory accounts, OIDC's email_verified): local sign-up doesn't verify them.
  Identities (<provider id>:<subject>) match what the IdP says is the user, whatever user name it lets them choose.
  OIDC can't create accounts with listed user names that way (sign_in/accounts.py, reserved_admin_name).
  """
  admins = env_admins()
  if not admins:
    return False
  subjects = env_admin_identities(admins)
  # sso:<subject> is an identity, never a user name, whatever local sign-up or an IdP allows
  if user.user_name in admins and ':' not in user.user_name:
    return True
  emails = {a.lower() for a in admins if '@' in a}
  if not emails and not subjects:
    return False
  from .models import UserIdentity
  identities = UserIdentity.query.filter(UserIdentity.user_id == user.id).all()
  if any((identity.provider_id, identity.subject) in subjects for identity in identities):
    return True
  if not emails:
    return False
  from .sign_in.identities import verified_emails
  return bool(verified_emails(user, identities) & emails)


def env_admin_identities(admins=None) -> set:
  """The (provider id, subject) of $QABOARD_ADMINS's entries like sso:<subject>"""
  return {tuple(a.split(':', 1)) for a in (env_admins() if admins is None else admins) if ':' in a and '@' not in a}


def env_admin_candidates():
  """
  A filter for the accounts that may be admins through $QABOARD_ADMINS (is_env_admin decides): to look for them in
  the database, without checking every user.
  """
  from sqlalchemy import or_, and_, func, false
  from .models import User, UserIdentity
  admins = env_admins()
  names = [a for a in admins if ':' not in a]
  emails = [a.lower() for a in admins if '@' in a]
  subjects = env_admin_identities(admins)
  by_identity = (User.id.in_(
    UserIdentity.query.with_entities(UserIdentity.user_id)
    .filter(or_(*[and_(UserIdentity.provider_id == p, UserIdentity.subject == s) for p, s in subjects]))
  ) if subjects else false())
  return or_(User.user_name.in_(names), func.lower(User.email).in_(emails), by_identity)


def is_admin(user) -> bool:
  # service accounts are never admins: their tokens can't have the admin scope either
  if user is None or user.status != 'active' or getattr(user, 'kind', 'human') == 'service':
    return False
  return bool(user.is_admin) or is_env_admin(user)
