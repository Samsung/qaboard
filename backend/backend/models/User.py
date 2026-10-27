import datetime

from flask_login import UserMixin
from sqlalchemy import Column, Integer, String, DateTime, ForeignKey, Boolean
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import relationship

from backend.models import Base



class User(Base, UserMixin):
  __tablename__ = 'users'

  id = Column(Integer, primary_key=True)
  created_date = Column(DateTime, default=datetime.datetime.utcnow, nullable=False)

  user_name = Column(String(), unique=True)
  full_name = Column(String(), unique=False)
  email = Column(String(), unique=True)

  password = Column(String())
  tokens = relationship("Token", back_populates="user", foreign_keys="Token.user_id")

  login_type = Column(String())
  data = Column(JSONB(), nullable=False, default=dict, server_default='{}')

  # human, or service (bots that only use tokens, see backend/service_accounts.py)
  kind = Column(String(), nullable=False, default='human', server_default='human')
  # who manages a service account: the instance's admins (owner_type "instance"), or a project's owners ("project",
  # owner_id is the project). Its tokens can't reach outside of its project. None for people.
  owner_type = Column(String(), nullable=True)
  owner_id = Column(String(), nullable=True, index=True)
  # active, pending (waiting for an admin), disabled (can't sign in, their tokens stop working)
  status = Column(String(), nullable=False, default='active', server_default='active')
  # admins from $QABOARD_ADMINS are admins whatever this says, see backend/admins.py
  is_admin = Column(Boolean(), nullable=False, default=False, server_default='false')
  last_login_at = Column(DateTime(), nullable=True)
  # the web app's preferences that follow users from browser to browser
  preferences = Column(JSONB(), nullable=False, default=dict, server_default='{}')
  preferences_updated_at = Column(DateTime(), nullable=True)


  def __repr__(self):
    # not data: with LDAP and SAML it holds everything the directory knows about the user
    return (f"<id='{self.id}' "
            f"user_name='{self.user_name}' "
            f"full_name='{self.full_name}' "
            f"email='{self.email}' "
            f"login_type='{self.login_type}' "
            )

  @property
  def is_active(self):
    # flask-login: disabled users can't log in
    return self.status != 'disabled'

  @property
  def is_authenticated(self):
    # UserMixin's follows is_active: disabled users would look anonymous, and never be told why (backend/actor.py)
    return True

  def update(self, user_name: str, full_name: str, email: str, login_type: str, data, **kwargs):
      if user_name:
        self.user_name = user_name
      if full_name:
        self.full_name = full_name
      if email:
        self.email = email
      if login_type:
        self.login_type = login_type
      # FIXME: data should be a dict, and this should be an update
      #        Need to fix that it stores LDAP data top-level currently...
      if data:
        self.data = data
      # FIXME: what about the kwargs?



class Token(Base):
    """
    API tokens. We only store a hash of the secret, see backend/tokens.py for the format.
    A token never has more rights than its user has now: scopes and projects only narrow them.
    """
    __tablename__ = 'tokens'

    id = Column(Integer, primary_key=True)
    # Before 2026-10 tokens were stored in clear: the migration hashed them and emptied this column
    token = Column(String(64), nullable=True)
    token_hash = Column(String(64), unique=True, nullable=True, index=True)
    # shown to recognize the token, e.g. "qab_pat_Xk3f"
    prefix = Column(String(), nullable=False, default='', server_default='')
    # personal, cli (created by `qa auth login`), service (a service account's), legacy (created before scopes)
    kind = Column(String(), nullable=False, default='personal', server_default='personal')
    name = Column(String(), nullable=False, default='', server_default='')

    user_id = Column(Integer, ForeignKey('users.id'), nullable=False)
    user = relationship("User", back_populates="tokens", foreign_keys=[user_id])
    created_by_id = Column(Integer, ForeignKey('users.id', ondelete='SET NULL'), nullable=True)

    # read, ingest, act, manage, admin
    scopes = Column(JSONB(), nullable=False, default=list, server_default='[]')
    # project patterns, e.g. "group/repo" or "group/*". Empty: every project the user can access
    projects = Column(JSONB(), nullable=False, default=list, server_default='[]')

    created_at = Column(DateTime, default=datetime.datetime.utcnow)
    expires_at = Column(DateTime, nullable=True)
    # the token expires after this many days without being used
    idle_expiry_days = Column(Integer, nullable=True)
    last_used_at = Column(DateTime, nullable=True)
    last_used_ip = Column(String(), nullable=True)
    revoked = Column(Boolean, default=False)
    revoked_at = Column(DateTime, nullable=True)
    revoked_by_id = Column(Integer, ForeignKey('users.id', ondelete='SET NULL'), nullable=True)

    # e.g. {"client": "qa CLI", "hostname": "host-12"}
    data = Column(JSONB(), nullable=False, default=dict, server_default='{}')

    def __repr__(self):
      return f"<Token id={self.id} user_id={self.user_id} prefix='{self.prefix}' kind='{self.kind}'>"



class DeviceAuthorization(Base):
    """
    `qa auth login` uses the OAuth device flow (RFC 8628): the CLI gets a code, the user approves it in the
    web app, then the CLI's next poll receives a new token. We never store the token's secret.
    """
    __tablename__ = 'device_authorizations'

    id = Column(Integer, primary_key=True)
    device_code_hash = Column(String(64), unique=True, nullable=False)
    user_code = Column(String(), nullable=False, index=True)
    client_name = Column(String(), nullable=False, default='', server_default='')
    hostname = Column(String(), nullable=True)
    # where the CLI asked from, shown when approving
    ip = Column(String(), nullable=True)
    scopes = Column(JSONB(), nullable=False, default=list, server_default='[]')
    # pending, approved, denied, consumed (the CLI received its token)
    status = Column(String(), nullable=False, default='pending', server_default='pending')
    created_at = Column(DateTime, nullable=False, default=datetime.datetime.utcnow)
    expires_at = Column(DateTime, nullable=False)
    last_polled_at = Column(DateTime, nullable=True)
    user_id = Column(Integer, ForeignKey('users.id', ondelete='CASCADE'), nullable=True)
    user = relationship("User", foreign_keys=[user_id])
    token_id = Column(Integer, ForeignKey('tokens.id', ondelete='SET NULL'), nullable=True)
