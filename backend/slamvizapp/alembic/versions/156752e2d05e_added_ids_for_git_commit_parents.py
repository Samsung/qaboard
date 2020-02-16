"""Added ids for git commit parents

Revision ID: 156752e2d05e
Revises: e37bfe94d6e0
Create Date: 2018-07-02 14:53:53.800334

"""
from alembic import op
import sqlalchemy as sa

from sqlalchemy.orm import sessionmaker, Session as BaseSession
from sqlalchemy.ext.declarative import declarative_base

Base = declarative_base()
Session = sessionmaker()

from slamvizapp import repos

# revision identifiers, used by Alembic.
revision = '156752e2d05e'
down_revision = 'e37bfe94d6e0'
branch_labels = None
depends_on = None




class CiCommit(Base):
  __tablename__ = 'ci_commits'
  id = sa.Column(sa.String, primary_key=True)
  commit_type = sa.Column(sa.String)
  project_id = sa.Column(sa.String)
  parents = sa.Column(sa.JSON)


def upgrade():
  op.add_column('ci_commits', sa.Column('parents', sa.JSON))
  bind = op.get_bind()
  session = Session(bind=bind)
  ci_commits = session.query(CiCommit).filter(CiCommit.commit_type=='git')
  for ci_commit in ci_commits:
    print(ci_commit)
    try:
      git_commit = repos[ci_commit.project_id].commit(ci_commit.id)
      parent_ids = [p.hexsha for p in git_commit.parents]
      print(parent_ids)
      setattr(ci_commit, 'parents', parent_ids)
    except Exception as e:
      print(e)
      setattr(ci_commit, 'parents', [])
      # raise e
  session.commit()


def downgrade():
  # op.drop_column('ci_commits', 'parents')
  pass