import os

from git import Repo
from git.exc import NoSuchPathError

from flask import _app_ctx_stack

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, scoped_session
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy_utils import database_exists, create_database

from .config import app_data_directory

repo_location = str(app_data_directory/'psp_swip')
try:
  repo = Repo(repo_location)
except NoSuchPathError:
  print(f'[ERROR] database.py: Could not load git repository data from: {repo_location}')
  print(f'                     Please set $SLAMVIZAPP_DATA to where you cloned psp_swip')
  raise



# For other databases read http://docs.sqlalchemy.org/en/latest/core/engines.html
# http://docs.sqlalchemy.org/en/latest/dialects/mysql.html
# http://docs.sqlalchemy.org/en/latest/core/engines.html
# https://github.com/PyMySQL/mysqlclient-python
db_type = os.getenv('SLAMVIZAPP_DB_TYPE', 'postgresql')

db_user = os.getenv('SLAMVIZAPP_DB_USER', 'ci')
db_password = os.getenv('SLAMVIZAPP_DB_PASSWORD', 'dvsdvs')
db_host = os.getenv('SLAMVIZAPP_DB_HOST', 'localhost')
db_port = os.getenv('SLAMVIZAPP_DB_PORT', 5432)
db_name = os.getenv('SLAMVIZAPP_DB_NAME', 'slamvizapp')

engine_url = f'{db_type}://{db_user}:{db_password}@{db_host}:{db_port}/{db_name}'
engine = create_engine(engine_url, echo=False, pool_size=100, max_overflow=10)


if not database_exists(engine.url):
  try:
    create_database(engine.url)
  except:
    pass



# This is the recommended integration with Flask
# It scopes session within HTTP requests
Session = sessionmaker(bind=engine)
db_session = scoped_session(
    sessionmaker(
        autocommit=False,
        autoflush=False,
        bind=engine),
    scopefunc=_app_ctx_stack.__ident_func__
)
Base = declarative_base() # prints (no name)
Base.query = db_session.query_property()
