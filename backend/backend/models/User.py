from flask import Flask
# from flask_sqlalchemy import SQLAlchemy
from backend.models import Base
import datetime
from sqlalchemy import ForeignKey, Integer, String, DateTime, JSON
from sqlalchemy import UniqueConstraint, Column
from sqlalchemy.orm import relationship

# init SQLAlchemy
# db = SQLAlchemy()

class User(Base):
  __tablename__ = 'users'

  id = Column(Integer, primary_key=True) # primary keys are required by SQLAlchemy
  email = Column(String(100), unique=True)
  password = Column(String(100))
  username = Column(String(1000), unique=True)
  created_date = Column(DateTime, default=datetime.datetime.utcnow, nullable=False)