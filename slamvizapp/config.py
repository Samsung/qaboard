import os
from pathlib import Path

# we clone our psp_swip repo here
app_data_directory = Path(os.getenv('SLAMVIZAPP_DATA', '.'))

# users can request to run on new recordings - here we keep the list of available batches
batches_filepath = (app_data_directory/'extra-batches.yml').resolve()


# unix config
ci_directory = Path('/home/arthurf/ci/dvs/psp_swip')
default_recordings_directory  = Path('/net/f2/algo_archive/DVS_SLAM_Database/')
# default_recordings_directory  = Path('/stage/algo_archive/DVS_SLAM_Database/')

# windows config
if os.name == 'nt':
	ci_directory = Path('//mars/homes/arthurf/ci/dvs/psp_swip')
	default_recordings_directory  = Path('//f2/algo_archive/DVS_SLAM_Database/')
