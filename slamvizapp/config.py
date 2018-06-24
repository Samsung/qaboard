import os
from pathlib import Path

# we clone our repositories locally here to access commit metadata
git_server = os.getenv('SLAMVIZAPP_GIT_SERVER', 'gitlab-srv')
app_data_directory = Path(os.getenv('SLAMVIZAPP_DATA', '/var/slamvizapp')).resolve()

# shared network location where we save logs, and which recordings constitute which group...
shared_data_directory = Path('/home/arthurf/dvs/slamvizapp/data/')

# unix config
ci_directory = Path('/home/arthurf/ci')
database_directory = {
	'dvs/psp_swip': Path('/net/f2/algo_archive/DVS_SLAM_Database/'),
	'tof/swip_tof': Path('/net/f2/algo_archive/ToF_SW_Database/'),
}
default_recordings_directory = database_directory['dvs/psp_swip']

# windows config
is_windows = os.name == 'nt'
if is_windows:
  ci_directory = Path('//mars/homes/arthurf/ci')
  default_recordings_directory = Path('//f2/algo_archive/DVS_SLAM_Database/')

  
# CIS configuration #########################################################
# there is more at other locations...
cis_ci_directory = Path('/stage/algo_data')
