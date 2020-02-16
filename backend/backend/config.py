import os
from pathlib import Path

# we clone our repositories locally here to access commit metadata
git_server = os.getenv('QABOARD_GITLAB_SERVER', 'gitlab.com')
app_data_directory = Path(os.getenv('QABOARD_DATA', '/var/qaboard/git')).resolve()

# shared network location where we save custom per-project groups
# FIXME: save in the database!
shared_data_directory = Path('/var/qaboard/app_data/')

default_ci_directory = Path('/var/qaboard/data')
