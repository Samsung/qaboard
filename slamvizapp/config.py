import os
from pathlib import Path

# we clone our repositories here to access commit metadata
git_server = os.getenv('SLAMVIZAPP_GIT_SERVER', 'gitlab-srv')
app_data_directory = Path(os.getenv('SLAMVIZAPP_DATA', '/var/slamvizapp')).resolve()

# users can request to run on new recordings - here we keep the list of available groups
# it must be available from LSF
recording_groups_filepath = Path('/home/arthurf/dvs/slamvizapp/data/extra-batches.yml')

# unix config
ci_directory = Path('/home/arthurf/ci')
default_recordings_directory = Path('/net/f2/algo_archive/DVS_SLAM_Database/')
# default_recordings_directory  = Path('/stage/algo_archive/DVS_SLAM_Database/')

# windows config
is_windows = os.name == 'nt'
if is_windows:
  ci_directory = Path('//mars/homes/arthurf/ci')
  default_recordings_directory = Path('//f2/algo_archive/DVS_SLAM_Database/')
