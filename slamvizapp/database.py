import os

from git import Repo
from flask import _app_ctx_stack

from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, scoped_session
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy_utils import database_exists, create_database

from .config import app_data_directory


repo = Repo(str(app_data_directory/'psp_swip'))

db_user = os.getenv('SLAMVIZAPP_DB_USER', 'ci')
db_password = os.getenv('SLAMVIZAPP_DB_PASSWORD', 'dvsdvs')
db_host = os.getenv('SLAMVIZAPP_DB_HOST', 'localhost')
db_port = os.getenv('SLAMVIZAPP_DB_PORT', 5432)
db_name = os.getenv('SLAMVIZAPP_DB_NAME', 'slamvizapp')

# For other databases read http://docs.sqlalchemy.org/en/latest/core/engines.html
db_type = 'postgresql'

# http://docs.sqlalchemy.org/en/latest/dialects/mysql.html
# http://docs.sqlalchemy.org/en/latest/core/engines.html
# https://github.com/PyMySQL/mysqlclient-python
# engine_url = 'mysql+mysqldb://mysql@web1:3306/vra_slamvizapp'
engine_url = f'{db_type}://{db_user}:{db_password}@{db_host}:{db_port}/{db_name}'
# engine_url = f'sqlite:///{app_data_directory}/slamvizapp.db'
engine = create_engine(engine_url, echo=False, pool_size=100, max_overflow=10)

if not database_exists(engine.url):
  try:
    create_database(engine.url)
  except:
    pass

Session = sessionmaker(bind=engine)
db_session = scoped_session(
    sessionmaker(
        autocommit=False,
        autoflush=False,
        bind=engine),
    scopefunc=_app_ctx_stack.__ident_func__
)
# self.create_session

Base = declarative_base() # prints (no name)
Base.query = db_session.query_property()


# We don't handle migrations *for now*
# It's easier to just drop-create the tables and re-import the results
# Of course, the second people update things manually, we'll need to work better
#
# For references look at
# - alembic http://alembic.zzzcomputing.com/en/latest/tutorial.html
# - https://github.com/miguelgrinberg/Flask-Migrate
# - https://github.com/tobiasandtobias/flask-alembic
