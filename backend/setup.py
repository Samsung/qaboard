# More information at
# https://setuptools.readthedocs.io/en/latest/setuptools.html
from setuptools import setup, find_packages

setup(
  name='backend',
  version="0.2",
  license="Apache-2.0",

  description="Backend for QA-Board",
  url="https://github.com/Samsung/qaboard",

  author="Arthur Flam",
  author_email="arthur.flam@samsung.com",

  packages=find_packages(),
  install_requires=[
    'pandas>=0.22',
    'gitpython', # manipulate git repositories
    'click',     # build CLI tools easily
    'flask',     # HTTP server
    'flask_cors',
    'sqlalchemy',       # ORM
    'alembic',          # SQL schema migrations
    'psycopg2',  # postgresql driver used by sqlalchemy
    'sqlalchemy_utils',
    'uwsgi',
    'ujson',
  ],

  entry_points= {
    'console_scripts': [
      'qaboard_clean = backend.clean:clean',
      'qaboard_init_database = backend.scripts.init_database:init_database',
    ]
  },

  # https://setuptools.readthedocs.io/en/latest/setuptools.html#including-data-files
  include_package_data=True,

)
