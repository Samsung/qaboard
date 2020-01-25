# https://github.com/ninjaaron/fast-entry_points
import fastentrypoints

from setuptools import setup, find_packages

# more information at
# https://setuptools.readthedocs.io/en/latest/setuptools.html

setup(
  name='qatools',
  version="0.8.1", # __version__ needs to be updated in qatools/__init__.py as well
  packages=find_packages(),

  author="Arthur Flam",
  author_email="arthur.flam@samsung.com",
  description="QA-Tools helps organize and visualize your results.",
  license="Apache 2.0",

  python_requires='>=3.6',
  install_requires=[
    'dataclasses', # backport for python3.6
    'click>=7.0', # CLI for humans
    'requests', # HTTP for humans
    'gitpython',
    'simplejson',
    'pyyaml',
    'joblib',
    # machine learning library, used only for parameter sampling. Depends on numpy/scipy.
    # TODO: To make installation faster, especially on windows
    #       we should remove this dependency and do it ourselves.
    'sklearn',
  ],

  extras_require={
    # Optionnal needed only for `qa optimize`
    # Since its CLI usage is not straightforward, it's kept at an optionnal dependency
    # Enable with  ~pip install qatools[optimize]~
    'optimize':  ["skopt"],
  },

  entry_points={
    "console_scripts": [
      'qa = qatools.qatools:main'
    ]
  },

  # https://setuptools.readthedocs.io/en/latest/setuptools.html#including-data-files
  include_package_data=True,
)
