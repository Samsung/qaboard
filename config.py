import os
from pathlib import Path

# unix config
ci_directory = Path('/home/arthurf/ci/dvs/psp_swip')
default_recordings_directory  = Path('/stage/algo_data/Sebastien/DVS_SLAM/Database/')


# windows config
if os.name == 'nt':
	ci_directory = Path('//mars/homes/arthurf/ci/dvs/psp_swip')
	default_recordings_directory  = Path('//netapp/algo_data/Sebastien/DVS_SLAM/Database/')


ci_commits_directory = ci_directory / 'commits'
