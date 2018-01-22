# we expose a simple REST API
# https://flask-restless.readthedocs.io/en/stable/customizing.html
# for now we don't use it, but it could be convenient
import flask.ext.restless

from slamvizapp import app, db_session
from .models import CiCommit, SlamOutput, Recording, ParametersSet


prefix = '/api/v1'
manager = flask.ext.restless.APIManager(app, session=db_session)

manager.create_api(Recording,
  methods=['GET', 'POST', 'DELETE'],
  url_prefix=prefix,
  results_per_page=40, # ?page=X
)
manager.create_api(ParametersSet,
  methods=['GET', 'POST', 'DELETE'],
  url_prefix=prefix,
  results_per_page=40,
)
manager.create_api(CiCommit,
  methods=['GET', 'POST', 'DELETE'],
  url_prefix=prefix,
  results_per_page=40, # ?page=X
)
manager.create_api(SlamOutput,
  methods=['GET', 'POST', 'DELETE'],
  url_prefix=prefix,
  results_per_page=40,
)
