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

  def update(self, user_name: str, full_name: str, email: str , login_type: str, data, **kwargs):
      if user_name:  self.user_name = user_name
      if full_name:  self.full_name = full_name
      if email:      self.email = email
      if login_type: self.login_type = login_type
      if data:       self.data = data