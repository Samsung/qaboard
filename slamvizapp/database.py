import os
from git import Repo
from .config import *
repo = Repo(str(app_data_directory/'psp_swip'))


from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, scoped_session
db_user = os.getenv('SLAMVIZAPP_DB_USER', 'postgres')
db_password = os.getenv('SLAMVIZAPP_DB_PASSWORD', 'dvsdvs')
db_host = os.getenv('SLAMVIZAPP_DB_HOST', 'localhost')
db_port = os.getenv('SLAMVIZAPP_DB_PORT', 5432)
db_name = os.getenv('SLAMVIZAPP_DB_NAME', 'slamvizapp')

# For other databases read http://docs.sqlalchemy.org/en/latest/core/engines.html
db_type = 'postgresql'

engine_url = f'{db_type}://{db_user}:{db_password}@{db_host}:{db_port}/{db_name}'
# engine_url = f'sqlite:///{app_data_directory}/slamvizapp.db'
engine = create_engine(engine_url, echo=False)

from sqlalchemy_utils import database_exists, create_database
if not database_exists(engine.url):
  create_database(engine.url)

Session = sessionmaker(bind=engine)
db_session = scoped_session(
	sessionmaker(
		autocommit=False,
        autoflush=False,
        bind=engine)
)


from sqlalchemy.ext.declarative import declarative_base
Base = declarative_base() # prints (no name)
Base.query = db_session.query_property()
