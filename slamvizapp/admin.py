"""
Small admin panel available at /admin

https://flask-admin.readthedocs.io/en/latest/introduction/#getting-started
"""
from flask_admin import Admin
from flask_admin.contrib.sqla import ModelView

from slamvizapp import app, db_session
from slamvizapp.models import Recording
from slamvizapp.models import CiCommit, ParametersSet, SlamOutput

admin = Admin(app, name='slamvizapp',
              template_mode='bootstrap3',
              # index_view=ModelView(Recording, db_session),
              endpoint='admin',
)


# we don't want to display those
one_to_many_columns = ['slam_outputs',]
editable_columns = set(c.name for c in Recording.metadata.tables['recordings'].columns) - set(['path'])

class RecordingModelView(ModelView):
  page_size = 50

  # can_create = False
  # can_edit = False
  # can_delete = False
  create_modal = True
  edit_modal = True

  column_exclude_list = one_to_many_columns
  form_excluded_columns = one_to_many_columns

  can_view_details = True
  column_searchable_list = ['path']
  column_filters = editable_columns
  column_editable_list = editable_columns



admin.add_view(RecordingModelView(Recording, db_session))
admin.add_view(ModelView(CiCommit, db_session))
admin.add_view(ModelView(ParametersSet, db_session))
admin.add_view(ModelView(SlamOutput, db_session))
