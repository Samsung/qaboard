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
    'Click',     # build CLI tools easily
    'flask',     # HTTP server
    'flask_cors',
    'sqlalchemy',       # ORM
    'alembic',          # SQL schema migrations
    'psycopg2-binary',  # postgresql driver used by sqlalchemy
    'sqlalchemy_utils',
    'flask-admin',
    'uwsgi'
  ],

  entry_points= {
    'console_scripts': [
      'slamvizapp_clean = slamvizapp.scripts.slam.clean:clean',
      'slamvizapp_init_database = slamvizapp.scripts.init_database:init_database',
    ]
  },

  # https://setuptools.readthedocs.io/en/latest/setuptools.html#including-data-files
  include_package_data=True,

)
