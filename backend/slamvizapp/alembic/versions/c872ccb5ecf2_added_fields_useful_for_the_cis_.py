"""added fields useful for the CIS integration: commit messages, commit output dir override..

Revision ID: c872ccb5ecf2
Revises: 5720713911df
Create Date: 2018-05-24 16:30:06.940926

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'c872ccb5ecf2'
down_revision = '5720713911df'
branch_labels = None
depends_on = None

from sqlalchemy.orm import sessionmaker, Session as BaseSession
from sqlalchemy.ext.declarative import declarative_base

Base = declarative_base()
Session = sessionmaker()

from slamvizapp import repos

class CiCommit(Base):
  __tablename__ = 'ci_commits'
  id = sa.Column(sa.String, primary_key=True)
  message = sa.Column(sa.String)
  commit_dir_override = sa.Column(sa.String)
  commit_type = sa.Column(sa.String)


def upgrade():
  op.add_column('ci_commits', sa.Column('message', sa.String))
  op.add_column('ci_commits', sa.Column('commit_dir_override', sa.String))
  op.add_column('ci_commits', sa.Column('commit_type', sa.String))
  
  repo = repos['dvs/psp_swip']
  bind = op.get_bind()
  session = Session(bind=bind)
  for o in session.query(CiCommit):
    setattr(o, 'commit_type', 'git') 
    try:
      commit = repo.commit(o.id)
      setattr(o, 'message', commit.message) 
    except:
      setattr(o, 'message', '<NA>')
  session.commit()

def downgrade():
  op.drop_column('ci_commits', 'message')
  op.drop_column('ci_commits', 'commit_dir_override')
  op.drop_column('ci_commits', 'commit_type')
