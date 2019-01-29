from setuptools import setup, find_packages

# more information at
# https://setuptools.readthedocs.io/en/latest/setuptools.html

setup(
  name='qatools',
  version="0.3.0",
  packages=find_packages(), 

  author="Arthur Flam",
  author_email="arthur.flam@samsung.com",
  description="The QA tools help you organize and visualize your results.",
  license="Samsung SIRC - all rights reserved",

  python_requires='>=3.6',
  install_requires=[
    'dataclasses', # backport for python3.6
    'click', # CLI for humans
    'requests', # HTTP for humans
    'gitpython',
    'sklearn', # machine learning, used only for parameter sampling
    'simplejson',
  ],

  entry_points='''
      [console_scripts]
      qa=qatools.qatools:main
  ''',

  # https://setuptools.readthedocs.io/en/latest/setuptools.html#including-data-files
  include_package_data=True,
)
