import os
from pathlib import Path

# we clone our repositories locally here to access commit metadata
git_server = os.getenv('QABOARD_GIT_SERVER', 'gitlab-srv')
app_data_directory = Path(os.getenv('QABOARD_DATA', '/var/qaboard')).resolve()

# shared network location where we save custom per-project groups
# FIXME: save in the database!
shared_data_directory = Path('/home/arthurf/dvs/slamvizapp/data/')

# unix config
default_ci_directory = Path('/stage/algo_data/ci')

# windows config
is_windows = os.name == 'nt'
if is_windows:
  default_ci_directory = Path('//mars/homes/arthurf/ci')
  
# CIS configuration #########################################################
# there is more at other locations...
cis_ci_directory = Path('/stage/algo_data')
