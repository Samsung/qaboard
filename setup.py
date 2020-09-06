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
  version="0.8.13", # __version__ needs to be updated in qaboard/__init__.py as well
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
    "Programming Language :: Python :: 3.6",
    "Topic :: Scientific/Engineering",
    "Topic :: Software Development :: Libraries",
    "Topic :: Software Development :: Quality Assurance",
  ],

  packages=find_packages(exclude=("tests","backend")),
  python_requires='>=3.7',
  install_requires=[
    'click>=7.0',  # CLI for humans. In v7 they changed CLI command conventions, started using "-" vs "_"
    'requests',    # HTTP for humans
    # Used for serializer flexibility,
    # but we could replace it since it requires a compiler for the optionnal C-extensions at `pip install`-time... 
    # We had issues with Windows users who had VisualStudio, but had not installed a C++ toolchain. 
    # TODO: unless we can ask for binary versions?
    'simplejson',
    'pyyaml',      # YAML reader
    'joblib',      # Parallelism for dummies
    # Used only for parameter sampling. Depends on numpy/scipy.
    # TODO: To make installation faster, especially on windows
    #       we should remove this dependency and implement what we need ourselves.
    'sklearn',
  ],

  extras_require={
    'dev': [
      'flake8', # lint
      'green',  # test runner
      'mypy',   # type hint checks
      # 'black' # TODO: formatter 
    ],
    # Optional needed only for `qa optimize` - `pip install qaboard[optimize]`
    # Since its CLI usage is not straightforward, it's best kept at an optionnal dependency
    'optimize':  ["scikit-optimize>=0.7.2"], # we need https://github.com/scikit-optimize/scikit-optimize/pull/806
  },

  entry_points={
    "console_scripts": [
      'qa = qaboard.qa:main'
    ]
  },

  # https://setuptools.readthedocs.io/en/latest/setuptools.html#including-data-files
  include_package_data=True,
)
