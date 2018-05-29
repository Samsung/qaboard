"""
Small admin panel available at /admin

https://flask-admin.readthedocs.io/en/latest/introduction/#getting-started
"""
from flask_admin import Admin
from flask_admin.contrib.sqla import ModelView

from slamvizapp import app, db_session
from slamvizapp.models import TestInput, CiCommit, Batch, Project 


admin = Admin(app, name='slamvizapp',
              template_mode='bootstrap3',
              # index_view=ModelView(TestInput, db_session),
              endpoint='admin',
             )


# we don't want to display those
one_to_many_columns = ['outputs',]
editable_columns = set(c.name for c in TestInput.metadata.tables['test_inputs'].columns
                      ) - set(['path', 'database'])

class TestInputModelView(ModelView):
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



admin.add_view(TestInputModelView(TestInput, db_session))
admin.add_view(ModelView(CiCommit, db_session))
admin.add_view(ModelView(Batch, db_session))
admin.add_view(ModelView(Project, db_session))
