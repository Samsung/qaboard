import datetime

from flask_login import UserMixin
from sqlalchemy import Column, Integer, String, DateTime, Boolean

from backend.models import Base


class User(Base, UserMixin):
  __tablename__ = 'users'

  id = Column(Integer, primary_key=True)
  created_date = Column(DateTime, default=datetime.datetime.utcnow, nullable=False)

  user_name = Column(String(), unique=True)
  full_name = Column(String(), unique=True)
  email = Column(String(), unique=True)

  password = Column(String())
  is_ldap = Column(Boolean(), default=False)

  def __repr__(self):
    return (f"<id='{self.id}' "
            f"user_name='{self.user_name}' "
            f"full_name='{self.full_name} "
            f"email='{self.email}' "
            f"is_ldap='{self.is_ldap}' "
            )
