from setuptools import setup, find_packages

# more information at
# https://setuptools.readthedocs.io/en/latest/setuptools.html

setup(
  name='slamvizapp',
  version="0.2",
  packages=find_packages(),

  author="Arthur Flam",
  author_email="arthur.flam@samsung.com",
  description="Debugging tools for SLAM development",
  license="Samsung SIRC - all rights reserved",

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
    'flask-admin',
    'uwsgi', # actually required, see below
    'ujson',
  ],

  extras_require={
      # REQUIRED, but currently doesn't build on LSF, so moved here.....
      'server': ['uwsgi'],
      # we started testing alternative json libraries, since a lot of time is
      # spend serializing results from the database.
      'test-json': ["python-rapidjson", "simplejson"],
  },

  entry_points= {
    'console_scripts': [
      'slamvizapp_clean = slamvizapp.clean:clean',
      'slamvizapp_init_database = slamvizapp.scripts.init_database:init_database',
    ]
  },

  # https://setuptools.readthedocs.io/en/latest/setuptools.html#including-data-files
  include_package_data=True,

)
