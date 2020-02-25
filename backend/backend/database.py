import os

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, scoped_session
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy_utils import database_exists, create_database


# For other databases read http://docs.sqlalchemy.org/en/latest/core/engines.html
# http://docs.sqlalchemy.org/en/latest/dialects/mysql.html
# http://docs.sqlalchemy.org/en/latest/core/engines.html
# https://github.com/PyMySQL/mysqlclient-python
db_type = os.getenv('QABOARD_DB_TYPE', 'postgresql')

db_user = os.getenv('QABOARD_DB_USER', 'qaboard')
db_password = os.getenv('QABOARD_DB_PASSWORD', 'password')
db_host = os.getenv('QABOARD_DB_HOST', 'localhost')
db_port = os.getenv('QABOARD_DB_PORT', 5432)
db_name = os.getenv('QABOARD_DB_NAME', 'qaboard')
db_echo = bool(os.getenv('QABOARD_DB_ECHO', False))


import ujson
import psycopg2.extras
psycopg2.extras.register_default_json(loads=lambda x: ujson.loads)

engine_url = f'{db_type}://{db_user}:{db_password}@{db_host}:{db_port}/{db_name}'
engine = create_engine(
	engine_url,
	echo=db_echo,
	pool_size=100,
	max_overflow=10,
	json_deserializer=ujson.loads,
	json_serializer=ujson.dumps,
)

try:
  if not database_exists(engine.url):
    create_database(engine.url)
except:
  print(f'[WARNING] Could not connect to {engine_url}')
  pass


# This is the recommended integration with Flask
# It scopes session within HTTP requests
from flask import _app_ctx_stack
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

Base.metadata.create_all(engine)