"""
Instance admins: users with `is_admin`, and those listed in $QABOARD_ADMINS (comma-separated user names or emails).
The environment's list is the break-glass access: they're admins whatever the database says.
"""
import os


def env_admins() -> set:
  return {a.strip() for a in os.environ.get('QABOARD_ADMINS', '').split(',') if a.strip()}


def is_env_admin(user) -> bool:
  """
  User names must match exactly: local sign-up could create "ALICE" next to "alice" (and can't create listed names).
  Emails only count when they're verified (directory accounts, OIDC's email_verified): local sign-up doesn't verify them.
  """
  admins = env_admins()
  if not admins:
    return False
  if user.user_name in admins:
    return True
  emails = {a.lower() for a in admins if '@' in a}
  if not emails:
    return False
  from .sign_in.identities import verified_emails
  return bool(verified_emails(user) & emails)


def is_admin(user) -> bool:
  if user is None or user.status != 'active':
    return False
  return bool(user.is_admin) or is_env_admin(user)
