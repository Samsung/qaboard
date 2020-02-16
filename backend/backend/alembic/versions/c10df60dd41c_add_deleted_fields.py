"""Add .deleted fields

Revision ID: c10df60dd41c
Revises: 80a0b3ed9dd1
Create Date: 2019-07-08 08:33:32.015736

"""
import datetime

from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'c10df60dd41c'
down_revision = '80a0b3ed9dd1'
branch_labels = None
depends_on = None


from sqlalchemy.orm import sessionmaker, Session as BaseSession
from sqlalchemy.ext.declarative import declarative_base
Base = declarative_base()
Session = sessionmaker()


class CiCommits(Base):
  __tablename__ = 'ci_commits'
  id = sa.Column(sa.String(), primary_key=True)
  data = sa.Column(sa.JSON(), default={})

class Projects(Base):
  __tablename__ = 'projects'
  id = sa.Column(sa.Integer(), primary_key=True)
  data = sa.Column(sa.JSON(), default={})
  latest_output_datetime = sa.Column(sa.DateTime())


def upgrade():
  op.add_column('ci_commits', sa.Column('deleted', sa.Boolean(), default=False, server_default=False))
  op.add_column('outputs', sa.Column('deleted', sa.Boolean(), default=False, server_default=False))
  op.add_column('projects', sa.Column('latest_output_datetime', sa.DateTime()))

  op.drop_column("ci_commits", "latest_gitlab_pipeline")
  op.alter_column('ci_commits', 'time_of_last_batch', new_column_name='latest_output_datetime', type_=sa.DateTime())

  bind = op.get_bind()
  session = Session(bind=bind)

  for project in session.query(Projects):
    if 'latest_output_datetime' in project.data:
      project.latest_output_datetime = datetime.datetime.strptime(project.data['latest_output_datetime'],  "%Y-%m-%dT%H:%M:%S.%f")
      del project.data['latest_output_datetime']
    print(f'{project.id} {project.latest_output_datetime}')
    session.add(project)
  session.commit()



def downgrade():
  op.drop_column("projects", "latest_output_datetime")
  op.drop_column("ci_commits", "deleted")
  op.drop_column("outputs", "deleted")

  op.add_column('ci_commits', sa.Column('latest_gitlab_pipeline', sa.DateTime(timezone=True)))

  bind = op.get_bind()
  session = Session(bind=bind)

  for project in session.query(Projects):
    if project.latest_output_datetime:
      project.data['latest_output_datetime'] = project.latest_output_datetime.isoformat()
    session.add(project)
    session.commit()

  op.alter_column('ci_commits', 'latest_output_datetime', new_column_name='time_of_last_batch', type_=DateTime(timezone=True))
