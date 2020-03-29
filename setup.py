"""
References used:
- https://realpython.com/pypi-publish-python-package/#a-small-python-package
- https://setuptools.readthedocs.io/en/latest/setuptools.html

We may want to take a close look at [poetry](https://python-poetry.org/) for packaging...

```bash
# pip install twine

python setup.py sdist bdist_wheel
twine check dist/*
twine upload dist/*

# From SIRC, we need some care to connect to PyPi:
#   (no checked)  REQUESTS_CA_BUNDLE=/home/arthurf/qaboard/backend/deployment/sirc-ca.crt
#   (works, ugly) patch: `+  verify=False` in lib/python37/site-packages/twine/repository.py:175
#   (helps)       ssh $nice_host
twine upload --verbose -u __token__ dist/*


Until https://github.com/pypa/pip/issues/2195 is resolved,
for local development with `pip install` without `--editable`,
you'll likely want to speed-up pip
```
# site-packages/pip/_internal/download.py
778: +        from shutil import ignore_patterns
     +        shutil.copytree(link_path, location, symlinks=True, ignore=ignore_patterns('.git', 'node_modules'))
     -        shutil.copytree(link_path, location, symlinks=True)
```

"""
# https://github.com/ninjaaron/fast-entry_points
import fastentrypoints

from pathlib import Path
from setuptools import setup, find_packages

README_md = Path(__file__).parent / "README.md"
README = README_md.read_text(encoding='utf-8')

setup(
  name='qaboard',
  version="0.8.5", # __version__ needs to be updated in qaboard/__init__.py as well
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
  python_requires='>=3.6',
  install_requires=[
    'dataclasses', # Backport for python3.6
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
    # TODO: only a dev dependency
    'green', 
  ],

  extras_require={
    # Optionnal needed only for `qa optimize`
    # Since its CLI usage is not straightforward, it's best kept at an optionnal dependency
    # Enable with  `pip install qaboard[optimize]`
    # Since the package is not maintained anymore, maybe we should review the optimization loop
    # and use nevergrad like all the cool kids.
    'optimize':  ["skopt"],
  },

  entry_points={
    "console_scripts": [
      'qa = qaboard.qa:main'
    ]
  },

  # https://setuptools.readthedocs.io/en/latest/setuptools.html#including-data-files
  include_package_data=True,
)
