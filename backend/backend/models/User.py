import datetime

from flask_login import UserMixin
from sqlalchemy import Column, Integer, String, DateTime
from sqlalchemy.dialects.postgresql import JSONB

from backend.models import Base


class User(Base, UserMixin):
  __tablename__ = 'users'

  id = Column(Integer, primary_key=True)
  created_date = Column(DateTime, default=datetime.datetime.utcnow, nullable=False)

  user_name = Column(String(), unique=True)
  full_name = Column(String(), unique=False)
  email = Column(String(), unique=True)

  password = Column(String())
  # is_ldap = Column(Boolean(), default=False)
  # login_type = Column(Boolean(), default=False)
  login_type = Column(String())
  data = Column(JSONB(), nullable=False, default=dict, server_default='{}')


  def __repr__(self):
    return (f"<id='{self.id}' "
            f"user_name='{self.user_name}' "
            f"full_name='{self.full_name}' "
            f"email='{self.email}' "
            # f"is_ldap='{self.is_ldap}' "
            # f"is_sso='{self.is_sso}' "
            f"login_type='{self.login_type}' "
            f"data='{self.data}' "
            )
