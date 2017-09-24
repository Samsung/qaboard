import os
from pathlib import Path

# unix config
ci_commits_directory = Path('/stage/algo_data/ci_dvs/commits/mono_slam/')
ci_recordings_directory = Path('/stage/algo_data/ci_dvs/recordings/')
default_recordings_directory  = Path('/stage/algo_data/Sebastien/DVS_SLAM/Database/')

# windows config
if os.name == 'nt':
	ci_commits_directory = Path('//netapp/algo_data/ci_dvs/commits/mono_slam/')
	ci_recordings_directory = Path('//netapp/algo_data/ci_dvs/recordings/')
	default_recordings_directory  = Path('//netapp/algo_data/Sebastien/DVS_SLAM/Database/')
	drive_mapping = {'linux': 'stage', 'windows':'/netapp'}