import os
from pathlib import Path

# unix config
ci_directory = Path('/home/arthurf/ci/dvs/psp_swip')

ci_recordings_directory = Path('/net/f2/algo_archive/ci_dvs/recordings/')
default_recordings_directory  = Path('/stage/algo_data/Sebastien/DVS_SLAM/Database/')

# windows config
if os.name == 'nt':
	ci_directory = Path('//mars/homes/arthurf/ci/dvs/psp_swip')

	ci_recordings_directory = Path('//netapp/algo_data/ci_dvs/recordings/')
	default_recordings_directory  = Path('//netapp/algo_data/Sebastien/DVS_SLAM/Database/')
	drive_mapping = {'linux': 'stage', 'windows':'/netapp'}


ci_commits_directory = ci_directory / 'commits'
