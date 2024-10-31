import secrets
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
  tokens = relationship("Token", back_populates="user")

  login_type = Column(String())
  data = Column(JSONB(), nullable=False, default=dict, server_default='{}')


  def __repr__(self):
    return (f"<id='{self.id}' "
            f"user_name='{self.user_name}' "
            f"full_name='{self.full_name}' "
            f"email='{self.email}' "
            f"login_type='{self.login_type}' "
            f"data='{self.data}' "
            )

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
    __tablename__ = 'tokens'
    
    id = Column(Integer, primary_key=True)
    token = Column(String(64), unique=True, nullable=False, index=True)

    user_id = Column(Integer, ForeignKey('users.id'), nullable=False)
    user = relationship("User", back_populates="tokens")

    created_at = Column(DateTime, default=datetime.datetime.utcnow)
    expires_at = Column(DateTime, nullable=True)
    revoked = Column(Boolean, default=False)

    # TODO: last_used = Column(DateTime, default=datetime.datetime.utcnow)
    # TODO: Scopes with
    data = Column(JSONB(), nullable=False, default=dict, server_default='{}')


    def __init__(self, user, duration_days=None):
        """Create a new token with a specified expiration time."""
        self.user_id = user.id
        self.token = self.generate_token()
        if duration_days:
          self.expires_at = datetime.datetime.utcnow() + datetime.timedelta(days=duration_days)

    def generate_token(self):
        """Generate a secure random token."""
        return secrets.token_hex(32)

    def is_valid(self):
        """Check if token is valid (not expired and not revoked)."""
        if self.revoked:
          return False
        if self.expires_at and datetime.datetime.utcnow() < self.expires_at:
          return False
        return True
