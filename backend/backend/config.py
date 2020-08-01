import os
from pathlib import Path

# we clone our repositories locally here to access commit metadata
git_server = os.getenv('GITLAB_HOST', 'https://gitlab.com')
app_data_directory = Path(os.getenv('QABOARD_DATA', '/var/qaboard')).resolve()

# shared network location where we save custom per-project groups
# FIXME: save in the database!
shared_data_directory = Path('/home/arthurf/dvs/slamvizapp/data/')

default_outputs_root =   Path('/mnt/qaboard')
default_artifacts_root = Path('/mnt/qaboard')
