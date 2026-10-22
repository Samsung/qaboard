import os

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, scoped_session
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy_utils import database_exists, create_database

from .settings import env_flag


# For other databases read http://docs.sqlalchemy.org/en/latest/core/engines.html
# http://docs.sqlalchemy.org/en/latest/dialects/mysql.html
# http://docs.sqlalchemy.org/en/latest/core/engines.html
# https://github.com/PyMySQL/mysqlclient-python
db_type = os.getenv('QABOARD_DB_TYPE', 'postgresql')

db_user = os.getenv('QABOARD_DB_USER', 'qaboard')
db_password = os.getenv('QABOARD_DB_PASSWORD', 'password')
db_host = os.getenv('QABOARD_DB_HOST', 'db')
db_port = os.getenv('QABOARD_DB_PORT', 5432)
db_name = os.getenv('QABOARD_DB_NAME', 'qaboard')
# like other flags, QABOARD_DB_ECHO=0 or false turns it off
db_echo = env_flag(os.getenv('QABOARD_DB_ECHO', ''))


import ujson

# Connections per process. uwsgi runs 4 threads per process (uwsgi.ini), each with its own session: 4 is enough,
# the overflow covers the occasional extra connection. The database's max_connections must cover
# (pool_size + max_overflow) * processes * replicas, twice during rolling deploys: see services/db/qaboard.conf
db_pool_size = int(os.getenv('QABOARD_DB_POOL_SIZE', 4))
db_max_overflow = int(os.getenv('QABOARD_DB_MAX_OVERFLOW', 2))

engine_url = f'{db_type}://{db_user}:{db_password}@{db_host}:{db_port}/{db_name}'
def make_engine(pool_size=db_pool_size, max_overflow=db_max_overflow):
	"""Engines with the app's settings: background jobs with many threads (scans) get their own, with a bigger pool"""
	return create_engine(
		engine_url,
		echo=db_echo,
		pool_size=pool_size,
		max_overflow=max_overflow,
		# Checks connections before using them: after a restart of the database (or a connection it closed, e.g.
		# idle_in_transaction_session_timeout), requests reconnect instead of failing.
		pool_pre_ping=True,
		# Replaces connections after 30 minutes, before firewalls or the database drop them, and so the database's
		# per-connection memory (caches) doesn't grow forever.
		pool_recycle=1800,
		json_deserializer=ujson.loads,
		json_serializer=ujson.dumps,
		connect_args={"connect_timeout": 20}, #limit connection timeout
	)
engine = make_engine()
try:
  if not database_exists(engine_url + "?connect_timeout=20"):
    create_database(engine.url)
except Exception as e:
  print(f'[Error] Could not connect to {db_type}://{db_user}@{db_host}:{db_port}/{db_name}: {e}')


# This is the recommended integration with Flask
# It scopes session within HTTP requests
from greenlet import getcurrent
Session = sessionmaker(bind=engine)
db_session = scoped_session(
    sessionmaker(
        autocommit=False,
        autoflush=False,
        bind=engine),
    scopefunc=getcurrent
)
Base = declarative_base() # prints (no name)
Base.query = db_session.query_property()
