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
    'gitpython', # manipulate git repositories
    'Click',     # build CLI tools easily
    'flask',     # HTTP server
    'sqlalchemy',# ORM
    'psycopg2',  # postgresql driver used by sqlalchemy
    'sqlalchemy_utils',
    'flask-admin',
    'Flask-Restless',
  ],

  entry_points= {
    'console_scripts': [
      'slamvizapp_clean = slamvizapp.scripts.clean:clean',
      'slamvizapp_init_database = slamvizapp.scripts.init_database:init_database',
    ]
  },
  
  # https://setuptools.readthedocs.io/en/latest/setuptools.html#including-data-files
  include_package_data=True,

)
