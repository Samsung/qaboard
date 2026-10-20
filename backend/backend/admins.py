"""
Instance admins: users with `is_admin`, and those listed in $QABOARD_ADMINS (comma-separated user names or emails).
The environment's list is the break-glass access: they're admins whatever the database says.
"""
import os


def env_admins() -> set:
  return {a.strip().lower() for a in os.environ.get('QABOARD_ADMINS', '').split(',') if a.strip()}


def is_env_admin(user) -> bool:
  admins = env_admins()
  return bool(admins) and ((user.user_name or '').lower() in admins or (user.email or '').lower() in admins)


def is_admin(user) -> bool:
  if user is None or user.status != 'active':
    return False
  return bool(user.is_admin) or is_env_admin(user)
