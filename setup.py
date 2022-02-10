"""
References used:
- https://realpython.com/pypi-publish-python-package/#a-small-python-package
- https://setuptools.readthedocs.io/en/latest/setuptools.html

We may want to take a close look at [poetry](https://python-poetry.org/) for packaging...
"""
# https://github.com/ninjaaron/fast-entry_points
import fastentrypoints

from pathlib import Path
from setuptools import setup, find_packages

README_md = Path(__file__).parent / "README.md"
README = README_md.read_text(encoding='utf-8')

setup(
  name='qaboard',
  version="1.0.1", # __version__ needs to be updated in qaboard/__init__.py as well
  license="Apache-2.0",

  url="https://github.com/Samsung/qaboard",
  description="Visualize and compare algorithm results. Optimize parameters. Share results and track progress.",
  long_description=README,
  long_description_content_type="text/markdown",

  author="Arthur Flam",
  author_email="arthur.flam@samsung.com",

  classifiers=[
    "Development Status :: 3 - Alpha",
    "License :: OSI Approved :: Apache Software License",
    "Environment :: Console",
    "Programming Language :: Python :: 3",
    "Programming Language :: Python :: 3.7",
    "Topic :: Scientific/Engineering",
    "Topic :: Software Development :: Libraries",
    "Topic :: Software Development :: Quality Assurance",
  ],

  packages=find_packages(exclude=("tests","backend")),
  python_requires='>=3.7',
  install_requires=[
    'click>=7.0',  # CLI for humans. In v7 they changed CLI command conventions, started using "-" vs "_"
    'rich', # make things pretty
    'requests',    # HTTP for humans
    # Used for serializer flexibility,
    # but we could replace it since it requires a compiler for the optionnal C-extensions at `pip install`-time... 
    # We had issues with Windows users who had VisualStudio, but had not installed a C++ toolchain. 
    # TODO: unless we can ask for binary versions?
    'simplejson',
    'pyyaml',      # YAML reader
    'joblib',      # Parallelism for dummies
    'sklearn',
    'scikit-optimize',
  ],

  extras_require={
    'dev': [
      'flake8', # lint
      'green',  # test runner
      'mypy',   # type hint checks
      # or call: mypy --install-types
      'types-PyYAML',
      'types-simplejson',
      'types-requests',
      'types-setuptools',
      # 'black' # TODO: formatter 
    ],
  },

  entry_points={
    "console_scripts": [
      'qa = qaboard.qa:main'
    ]
  },

  # https://setuptools.readthedocs.io/en/latest/setuptools.html#including-data-files
  include_package_data=True,
)
