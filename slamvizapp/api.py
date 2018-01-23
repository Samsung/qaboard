# we expose a simple REST API
# https://flask-restless.readthedocs.io/en/stable/customizing.html
# for now we don't use it, but it could be convenient
from flask_restless import APIManager
from flask_restless.serialization import DefaultSerializer
# from flask_restless import APIManager#, DefaultSerializer

from slamvizapp import app, db_session
from .models import CiCommit, SlamOutput, Recording, ParametersSet

def add_cors_headers(response):
    response.headers['Access-Control-Allow-Origin'] = '*'
    response.headers['Access-Control-Allow-Credentials'] = 'true'
    return response

manager = APIManager(session=db_session, url_prefix='/api/v1')

#v https://flask-restless.readthedocs.io/en/latest/serialization.html
# class CiCommitSerializer(DefaultSerializer):
def serialize(self): 
  return {
    'id': self.id,
    'branch': self.branch,
    'message': self.gitcommit.message,
    'authored_datetime': self.authored_datetime,
    'time_of_last_slam_job': self.time_of_last_slam_job,
    'commit_dir_url': self.commit_dir_url,
    'aggregated_metrics': self.aggregated_metrics(),
    'failure_count': self.failure_count(),
    'valid_slam_outputs': [o.id for o in self.valid_slam_outputs],
  }


manager.create_api(CiCommit,
  methods=['GET', 'POST', 'DELETE'],
#   # exclude_columns=['slam_outputs'],
# serializer=serialize,
#   # includes = ['name', 'birth_date', 'computers', 'computers.vendor']
)
manager.create_api(Recording,
  methods=['GET', 'POST', 'DELETE'],
#   # results_per_page=40, # ?page=X
)
manager.create_api(ParametersSet,
  methods=['GET', 'POST', 'DELETE'],
#   # results_per_page=40,
)
manager.create_api(SlamOutput,
  methods=['GET', 'POST', 'DELETE'],
#   # results_per_page=40,
)

manager.init_app(app)
