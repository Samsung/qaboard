# let's make the git repository easily accessible
from git import Repo
from .config import *
repo = Repo(str(app_data_directory/'psp_swip'))

# we fetch the latest commits at startup
# from git_utils import git_pull
# git_pull()

# as well as the flask application
from flask import Flask
app = Flask(__name__)

# this is needed to use flask's sessions
# and eg display flash messages after redirects
app.secret_key = 'A0Zr98j/3yX R~JHCXQ!fgdsrtgLWX/,?RT'

import slamvizapp.views
