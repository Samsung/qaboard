import os
from pathlib import Path

# we clone our psp_swip repo here
app_data_directory = Path(os.getenv('SLAMVVIZAPP_APP_DATA_PATH', '.'))


# unix config
ci_directory = Path('/home/arthurf/ci/dvs/psp_swip')
default_recordings_directory  = Path('/stage/algo_data/Sebastien/DVS_SLAM/Database/')

# windows config
if os.name == 'nt':
	ci_directory = Path('//mars/homes/arthurf/ci/dvs/psp_swip')
	default_recordings_directory  = Path('//netapp/algo_data/Sebastien/DVS_SLAM/Database/')
