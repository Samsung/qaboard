"""
How users sign in (docs/design/user-management.md, Appendix C): the providers admins add in the web app, the identities
users sign in with, their sessions, and the access requests of users waiting for an admin.
"""
import datetime

from sqlalchemy import Column, Integer, String, Text, Boolean, DateTime, ForeignKey, UniqueConstraint
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import relationship

from backend.models import Base


class AuthProvider(Base):
  """OIDC providers added in the admin panel. Those from the environment aren't stored (backend/sign_in/providers.py)."""
  __tablename__ = 'auth_providers'

  # used in URLs, e.g. /api/v1/auth/oidc/<id>/callback
  id = Column(String(), primary_key=True)
  type = Column(String(), nullable=False, default='oidc', server_default='oidc')
  name = Column(String(), nullable=False, default='', server_default='')
  enabled = Column(Boolean(), nullable=False, default=True, server_default='true')
  position = Column(Integer(), nullable=False, default=0, server_default='0')
  # issuer, client_id, scopes, claims, match_users, client_secret_env... never the secret itself
  config = Column(JSONB(), nullable=False, default=dict, server_default='{}')
  # the client secret, encrypted with $QABOARD_ENCRYPTION_KEY
  secret_encrypted = Column(Text(), nullable=True)
  created_at = Column(DateTime, nullable=False, default=datetime.datetime.utcnow)
  updated_at = Column(DateTime, nullable=False, default=datetime.datetime.utcnow, onupdate=datetime.datetime.utcnow)


class UserIdentity(Base):
  """A way a user signs in: a provider and the user's id there"""
  __tablename__ = 'user_identities'

  id = Column(Integer, primary_key=True)
  user_id = Column(Integer, ForeignKey('users.id', ondelete='CASCADE'), nullable=False, index=True)
  user = relationship("User")
  # local, ldap, saml, sso (OIDC from the environment), or an AuthProvider's id. No foreign key: env providers aren't rows
  provider_id = Column(String(), nullable=False)
  # OIDC: `sub`. SAML: the NameID. LDAP and local: the user name
  subject = Column(String(), nullable=False)
  email = Column(String(), nullable=True)
  # what the provider said at the last sign-in, filtered (no tokens)
  claims = Column(JSONB(), nullable=False, default=dict, server_default='{}')
  created_at = Column(DateTime, nullable=False, default=datetime.datetime.utcnow)
  last_login_at = Column(DateTime, nullable=True)

  __table_args__ = (UniqueConstraint('provider_id', 'subject', name='uq_user_identities_provider_subject'),)


class UserSession(Base):
  """A browser session. The cookie only holds an opaque id, we store its hash."""
  __tablename__ = 'user_sessions'

  id = Column(Integer, primary_key=True)
  id_hash = Column(String(64), nullable=False, unique=True)
  user_id = Column(Integer, ForeignKey('users.id', ondelete='CASCADE'), nullable=False, index=True)
  user = relationship("User")
  provider_id = Column(String(), nullable=True)
  created_at = Column(DateTime, nullable=False, default=datetime.datetime.utcnow)
  last_seen_at = Column(DateTime, nullable=False, default=datetime.datetime.utcnow)
  expires_at = Column(DateTime, nullable=False)
  ip = Column(String(), nullable=True)
  user_agent = Column(String(), nullable=True)
  revoked_at = Column(DateTime, nullable=True)


class AccessRequest(Base):
  """Users waiting for an admin, and what they said"""
  __tablename__ = 'access_requests'

  id = Column(Integer, primary_key=True)
  user_id = Column(Integer, ForeignKey('users.id', ondelete='CASCADE'), nullable=False, index=True)
  user = relationship("User", foreign_keys=[user_id])
  # instance: a pending user waits for an admin (M2). project: a role on resource_id, decided by its owners (M3)
  kind = Column(String(), nullable=False, default='instance', server_default='instance')
  # the project (an id or a prefix), and the role asked
  resource_id = Column(String(), nullable=True, index=True)
  role = Column(String(), nullable=True)
  message = Column(Text(), nullable=False, default='', server_default='')
  # pending, approved, denied
  status = Column(String(), nullable=False, default='pending', server_default='pending')
  decided_by_id = Column(Integer, ForeignKey('users.id', ondelete='SET NULL'), nullable=True)
  decided_at = Column(DateTime, nullable=True)
  created_at = Column(DateTime, nullable=False, default=datetime.datetime.utcnow)
