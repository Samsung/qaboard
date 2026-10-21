"""
Identities: the ways each user signs in, e.g. LDAP and OIDC. A new identity is never attached to an existing account
by its user name alone, unless the provider says so (`match_users`, for IdPs federated to the same directory).
"""
from typing import Optional

from ..tokens import utcnow, iso


# Claims we never store: they're credentials, or too big
DROPPED_CLAIMS = {'at_hash', 'c_hash', 'nonce', 'sid', 'session_state', 'jti'}


def find(provider_id: str, subject: str):
  from ..models import UserIdentity
  return UserIdentity.query.filter(UserIdentity.provider_id == provider_id, UserIdentity.subject == subject).one_or_none()


def record(user, provider_id: str, subject: str, email: Optional[str] = None, claims: Optional[dict] = None, refresh_token: Optional[str] = None):
  """
  Creates or refreshes the identity a user signed in with. Added to the database session: the caller commits.
  `refresh_token`: for providers that refresh groups daily, stored encrypted.
  """
  from backend import db_session
  from ..models import UserIdentity
  identity = find(provider_id, subject)
  if identity is None:
    # identities backfilled from users.login_type use the user name: upgrade them to the provider's subject
    identity = (UserIdentity.query
                .filter(UserIdentity.user_id == user.id, UserIdentity.provider_id == provider_id, UserIdentity.subject == user.user_name)
                .one_or_none())
    if identity is None:
      identity = UserIdentity(user_id=user.id, provider_id=provider_id, created_at=utcnow())
      db_session.add(identity)
    identity.subject = subject
  identity.email = email or identity.email
  identity.claims = {k: v for k, v in (claims or {}).items() if k not in DROPPED_CLAIMS}
  identity.last_login_at = utcnow()
  identity.claims_refreshed_at = identity.last_login_at
  if refresh_token:
    store_refresh_token(identity, refresh_token)
  return identity


def store_refresh_token(identity, refresh_token: Optional[str]):
  from .crypto import can_encrypt, encrypt
  if refresh_token is None:
    identity.refresh_token_encrypted = None
  elif can_encrypt():
    identity.refresh_token_encrypted = encrypt(refresh_token)
  else:
    print(f"[sign-in] WARNING: {identity.provider_id} refreshes groups, but refresh tokens can't be stored without $QABOARD_ENCRYPTION_KEY")


def serialize(identity, providers_by_id=None) -> dict:
  provider = (providers_by_id or {}).get(identity.provider_id)
  return {
    "id": identity.id,
    "provider_id": identity.provider_id,
    "provider_name": provider.name if provider else identity.provider_id,
    "provider_type": provider.type if provider else None,
    "subject": identity.subject,
    "email": identity.email,
    "created_at": iso(identity.created_at),
    "last_login_at": iso(identity.last_login_at),
  }
