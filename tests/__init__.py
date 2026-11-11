import os
import sys
from pathlib import Path

# Test this checkout, not a `qaboard` that is installed (e.g. the deployed CLI), also in subprocesses
root = str(Path(__file__).resolve().parent.parent)
sys.path.insert(0, root)
os.environ['PYTHONPATH'] = os.pathsep.join([root, *filter(None, [os.environ.get('PYTHONPATH')])])

# The tests expect qa's open-source defaults, not those of the site, CI runner or user that runs them:
# a site package (its runner, server, Sentry, path mappings, shared secrets with git hosts' tokens...),
# QA_*/QABOARD_* variables (e.g. QA_BATCH_CONCURRENCY), the user's secrets. Tests that need them set them.
for name in list(os.environ):
  if name.startswith(('QA_', 'QABOARD_')) or name in ('GITLAB_ACCESS_TOKEN', 'GITHUB_ACCESS_TOKEN', 'GITHUB_TOKEN'):
    del os.environ[name]
os.environ['QABOARD_IGNORE_SITE'] = '1'
os.environ['QA_USER_SECRETS'] = str(Path(root) / 'tests' / 'no-such-user-secrets.yaml')
