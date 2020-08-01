import os
from pathlib import Path

# we clone our repositories locally here to access commit metadata
git_server = os.getenv('GITLAB_HOST', 'https://gitlab.com')

# Where we save "non-metadata" qaboard data
qaboard_data_dir = Path(os.getenv('QABOARD_DATA_DIR', '/var/qaboard')).resolve()
# Where we save custom per-project groups
shared_data_directory = qaboard_data_dir / 'app_data'

default_outputs_root =   Path('/mnt/qaboard')
default_artifacts_root = Path('/mnt/qaboard')
