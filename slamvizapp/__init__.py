from .database import repos
from .database import db_session, Session

# we fetch the latest commits at startup
from .git_utils import git_pull
default_repo = repos['dvs/psp_swip']
git_pull(default_repo)

# We configure the flask application
from flask import Flask
from flask_cors import CORS
app = Flask(__name__)
CORS(app)
# This is needed to use flask's sessions
# and eg display flash messages after redirects
app.secret_key = 'A0Zr98j/3yX R~JHCXQ!fgdsrtgLWX/,?RT'
# Some magic to use sqlalchemy safely
# http://flask.pocoo.org/docs/0.12/patterns/sqlalchemy/
from slamvizapp.database import db_session

@app.teardown_appcontext
def shutdown_session(exception=None):
    db_session.remove()


import slamvizapp.webhooks
import slamvizapp.admin
import slamvizapp.api

# cors = CORS(app, resources={r"/api/*": {"origins": "*"}})
CORS(app)
