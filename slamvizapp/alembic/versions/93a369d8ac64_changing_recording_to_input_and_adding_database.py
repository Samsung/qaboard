"""Changing recording to input, and moving tags to json

Revision ID: 93a369d8ac64
Revises: 928495730715
Create Date: 2018-05-28 17:14:59.127304

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = '93a369d8ac64'
down_revision = 'c872ccb5ecf2'
branch_labels = None
depends_on = None


from sqlalchemy.orm import sessionmaker, Session as BaseSession
from sqlalchemy.ext.declarative import declarative_base

Base = declarative_base()
Session = sessionmaker()





class TestInput(Base):
  __tablename__ = 'test_inputs'
  id = sa.Column(sa.Integer(), primary_key=True)
  path = sa.Column(sa.String(), index=True, nullable=False)
  database = sa.Column(sa.String(), nullable=False)
  __table_args__ = (sa.UniqueConstraint('database', 'path', name='_database_path'),)


def upgrade():
  # projects
  # op.alter_column('ci_commits', 'project_id', type_=sa.String, new_column_name= 'project') # drop the uniqueness constaint
  op.alter_column('ci_commits', 'project', type_=sa.String, new_column_name= 'project_id') # drop the uniqueness constaint
  op.alter_column('recordings', 'path', type_=sa.String) # drop the uniqueness constaint
  op.create_table(
    'projects',
    sa.Column('id', sa.String(), primary_key=True),
    sa.Column('information', sa.JSON())
  )

  # op.drop_column("ci_commits", "project")
  # op.add_column('ci_commits', sa.Column('project_id',
  #                                       sa.String,
  #                                       sa.ForeignKey('projects.id'),
  #                                       default='dvs/psp_swip',
  #                                       # nullable=False,
  #                                       index=True,
  #                                       )
  # )

  bind = op.get_bind()
  session = Session(bind=bind)

  class CiCommitNew(Base):
    __tablename__ = 'ci_commits'
    id = sa.Column(sa.String, primary_key=True) # git commit id
    project_id = sa.Column(sa.String(), sa.ForeignKey('projects.id'), index=True)
    project = sa.orm.relationship("Project", back_populates="ci_commits")
    authored_datetime = sa.Column(sa.DateTime(timezone=True), index=True)

  class Project(Base):
    __tablename__ = 'projects'
    id = sa.Column(sa.String(), primary_key=True)
    ci_commits = sa.orm.relationship("CiCommitNew", order_by=CiCommitNew.authored_datetime, back_populates="project")

  try:
    slam_project = session.query(Project).filter_by(id='dvs/psp_swip').one()
  except:
    slam_project = Project(id='dvs/psp_swip')

  for o in session.query(CiCommitNew):
      o.project = slam_project
  session.commit()


  # # recordings => test_inputs
  op.rename_table('recordings', 'test_inputs')
  op.add_column('test_inputs', sa.Column('database', sa.String)) # nullable=False
  op.alter_column('test_inputs', 'path', type_=sa.String) # drop the uniqueness constaint

  slam_database = '/net/f2/algo_archive/DVS_SLAM_Database'
  for o in session.query(TestInput):
      o.database = slam_database

  session.commit()

  op.create_index('outputs_batch_id_idx', 'outputs', ['batch_id'])
  op.create_index('ci_commits_batch_id_idx', 'ci_commits', ['project_id'])
  op.create_index('ci_commits_branch_idx', 'ci_commits', ['branch'])
  op.create_index('ci_commits_authored_datetime_idx', 'ci_commits', ['authored_datetime'])
  op.create_unique_constraint('input_test_database_path_unique', 'test_inputs', ['database', 'path'])


def downgrade():
  # remove the projects
  bind = op.get_bind()
  session = Session(bind=bind)

  # class CiCommitOld(Base):
  #   __tablename__ = 'ci_commits'
  #   id = sa.Column(sa.String, primary_key=True) # git commit id
  #   project = sa.Column(sa.String())

  op.drop_column("ci_commits", "project")
  op.alter_column('ci_commits', 'project_id', type_=sa.String, new_column_name= 'project')

  # for o in session.query(CiCommitNew):
  #     o.project = o.project_id
  # session.commit()
  # op.drop_table('projects')
  # op.rename_table('test_inputs', 'recordings')
  # we don't remove the index, why bother...
