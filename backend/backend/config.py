import os
from pathlib import Path

# we clone our repositories locally here to access commit metadata
git_server = os.getenv('GITLAB_HOST', 'https://gitlab.com')

# Where we save "non-metadata" qaboard data
qaboard_data_dir = Path(os.getenv('QABOARD_DATA_DIR', '/var/qaboard')).resolve()
# Where we save custom per-project groups (currently used only for extra-runs and tuning in api/tuning.py)
qaboard_data_shared_dir = Path(os.environ.get("QABOARD_DATA_SHARED_DIR", qaboard_data_dir / 'shared'))
# Where we clone git repositories
qaboard_data_git_dir = Path(os.environ.get("QABOARD_DATA_GIT_DIR", qaboard_data_dir / 'git'))

default_storage_root = Path('/mnt/qaboard')
default_outputs_root = default_storage_root
default_artifacts_root = default_storage_root
