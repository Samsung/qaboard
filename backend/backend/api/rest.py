"""
At some point we may want to generate the API automatically from our schema.
https://flask-restless.readthedocs.io/en/stable/customizing.html
"""


# from flask_restless import APIManager
# from flask_restless.serialization import DefaultSerializer

# manager = APIManager(session=db_session, url_prefix='/api/v1')

 # https://flask-restless.readthedocs.io/en/latest/serialization.html
# class CiCommitSerializer(DefaultSerializer):
#   def serialize(self):
#     return {
#       'id': self.id,
#       'branch': self.branch,
#       'message': self.gitcommit.message,
#       'authored_datetime': self.authored_datetime,
#       'time_of_last_batch': self.time_of_last_batch,
#       'commit_dir_url': self.commit_dir_url,
#       'aggregated_metrics': self.aggregated_metrics(),
#       'failure_count': self.failure_count(),
#       'valid_outputs': [o.id for o in self.valid_outputs],
#     }


# manager.create_api(CiCommit,
#   methods=['GET', 'POST', 'DELETE'],
#   #   # exclude_columns=['outputs'],
#   # serializer_class=CiCommitSerializer,
#   #   # includes = ['name', 'birth_date', 'computers', 'computers.vendor']
# )
# manager.create_api(TestInput,
#   methods=['GET', 'POST', 'DELETE'],
# #   # results_per_page=40, # ?page=X
# )
# manager.create_api(ParametersSet,
#   methods=['GET', 'POST', 'DELETE'],
# #   # results_per_page=40,
# )
# manager.create_api(Output,
#   methods=['GET', 'POST', 'DELETE'],
# #   # results_per_page=40,
# )

# manager.init_app(app)
