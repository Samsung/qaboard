"""
What every sign-in does, whatever the provider: find or create the account (per the access policy), record the identity,
open the session, audit. Pending users get a session too: they see the page that says they wait for an admin.
"""
from typing import Optional

from ..tokens import utcnow
from . import identities, sessions
from .access import initial_status, request_access
from .oidc import SignInError


def finish(user, provider_id: str, subject: Optional[str] = None, email: Optional[str] = None, claims: Optional[dict] = None,
           refresh_token: Optional[str] = None, **meta):
  """Bookkeeping of a successful sign-in, and its session. Commits."""
  from backend import db_session
  from ..audit import audit
  identities.record(user, provider_id, subject or user.user_name, email=email or user.email, claims=claims, refresh_token=refresh_token)
  if user.status == 'pending':
    request_access(user)
  user.last_login_at = utcnow()
  # groups whose rules match this sign-in's claims (backend/access/groups.py)
  from ..access.groups import sync as sync_groups
  try:
    with db_session.begin_nested():
      groups = sync_groups(user, provider_id, claims).groups
  except Exception as e:
    # a sign-in never fails because of groups: the memberships stay as they were
    print(f"[sign-in] WARNING: could not update the groups of {user.user_name}: {type(e).__name__}: {e}")
    groups = None
  audit('auth.login', 'user', user.id, user.user_name, user=user, meta={
    "provider": provider_id, **({"pending": True} if user.status == 'pending' else {}),
    **({"groups": groups} if groups else {}), **meta,
  })
  sessions.start(user, provider_id)
  db_session.commit()


def new_user_status(email: Optional[str], verified: bool = True) -> str:
  """`verified`: whether the email is (identities.verified_emails): the `domains` policy doesn't trust the others"""
  return initial_status(email if verified else None)


def oidc_account(provider, claims: dict, linking_user=None):
  """
  The account of an OIDC sign-in: its identity, else the user it matches (`match_users`), else a new one.
  Raises SignInError when it can't be used.
  """
  from backend import db_session
  from ..models import User
  subject = claims.get('sub')
  user_name = claims.get(provider.claim('username'))
  if isinstance(user_name, list):
    user_name = user_name[0] if user_name else None
  if not subject or not user_name or not isinstance(user_name, str):
    raise SignInError('sso_misconfigured', f"The ID token has no {provider.claim('username')} claim: add the mapper in the IdP, or set the provider's username claim")
  # e.g. user@example.com when the claim is an email: the local part is a better user name
  if '@' in user_name and provider.claim('username') != 'email':
    user_name = user_name.split('@', 1)[0]
  email = claims.get(provider.claim('email'))
  email = email if isinstance(email, str) else None
  full_name = claims.get(provider.claim('name'))
  identity = identities.find(provider.id, subject)

  if linking_user is not None:
    if identity is not None and identity.user_id != linking_user.id:
      raise SignInError('identity_taken', f"This {provider.name} account is already used by another QA-Board account")
    return linking_user, email

  if identity is not None:
    return identity.user, email

  match = (provider.config.get('match_users') or 'none').lower()
  user = None
  if match == 'username':
    user = User.query.filter(User.user_name == user_name).one_or_none()
  elif match == 'email' and email and claims.get('email_verified') is True:
    user = User.query.filter(User.email == email).one_or_none()
  if user is not None:
    return user, email

  if User.query.filter(User.user_name == user_name).one_or_none() is not None:
    raise SignInError('account_exists', f"There is already a QA-Board account named {user_name}, and {provider.name} isn't set to match accounts by user name")
  if email and User.query.filter(User.email == email).one_or_none() is not None:
    email_for_account = None # emails are unique: the other account keeps it
  else:
    email_for_account = email
  user = User(
    user_name=user_name,
    full_name=full_name if isinstance(full_name, str) else None,
    email=email_for_account,
    login_type='OIDC',
    data={},
    status=new_user_status(email, verified=claims.get('email_verified') in (True, 'true')),
  )
  db_session.add(user)
  db_session.flush()
  from ..audit import audit
  audit('user.create', 'user', user.id, user.user_name, user=user, meta={"provider": provider.id, "status": user.status})
  return user, email
