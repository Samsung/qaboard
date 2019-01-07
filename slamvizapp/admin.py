"""
Small admin panel available at /admin

https://flask-admin.readthedocs.io/en/latest/introduction/#getting-started
"""
from flask_admin import Admin
from flask_admin.contrib.sqla import ModelView
from flask_admin.form import fields as fa_fields

from slamvizapp import app, db_session
from slamvizapp.models import TestInput, CiCommit, Batch, Project, Output


admin = Admin(app, name='slamvizapp',
              template_mode='bootstrap3',
              # index_view=ModelView(TestInput, db_session),
              endpoint='admin',
             )


# we don't want to display those
one_to_many_columns = ['outputs',]
columns = set(c.name for c in TestInput.metadata.tables['test_inputs'].columns)
editable_columns = columns - set(['path', 'database', 'data'])
class TestInputModelView(ModelView):
  page_size = 50
  create_modal = True
  edit_modal = True
  column_exclude_list = one_to_many_columns
  form_excluded_columns = one_to_many_columns
  can_view_details = True
  column_searchable_list = ['path', 'database', 'data']
  column_filters = editable_columns
  column_editable_list = editable_columns
  form_override = dict(
      json=fa_fields.JSONField
  )

class ProjectModelView(ModelView):
  column_list = ['id', 'data']
  column_searchable_list = ['id', 'data']
  can_delete = False

class CommitModelView(ModelView):
  column_list = ['id', 'hexsha', 'project_id', 'committer_name', 'message']
  column_searchable_list = ['hexsha', 'project_id', 'committer_name', 'message']
  column_filters = ['hexsha', 'committer_name', 'message']

class OutputModelView(ModelView):
  column_list = ['id', 'project_id', 'committer_name', 'message']
  column_searchable_list = ['id', 'output_dir_override']
  column_filters = ['id', 'output_dir_override']


admin.add_view(TestInputModelView(TestInput, db_session))
admin.add_view(CommitModelView(CiCommit, db_session))
admin.add_view(ModelView(Batch, db_session))
admin.add_view(OutputModelView(Output, db_session))
admin.add_view(ProjectModelView(Project, db_session))
