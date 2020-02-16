"""Allow sub-projects

Revision ID: 80a0b3ed9dd1
Revises: 8d684ac2793b
Create Date: 2019-01-02 16:53:00.941470

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = '80a0b3ed9dd1'
down_revision = '8d684ac2793b'
branch_labels = None
depends_on = None




from sqlalchemy.orm import sessionmaker, Session as BaseSession
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import relationship
from sqlalchemy import Column, Integer, String, ForeignKey
Base = declarative_base()
Session = sessionmaker()


class CiCommitOld(Base):
  __tablename__ = 'ci_commits'
  id = sa.Column(sa.String, primary_key=True)
  hexsha = sa.Column(sa.String)
  new_id = sa.Column(sa.String)
  batches = relationship("BatchOld", back_populates="ci_commit")
class BatchOld(Base):
  __tablename__ = 'batches'
  id = sa.Column(sa.String, primary_key=True)
  ci_commit_id = Column(String(), ForeignKey('ci_commits.id'), index=True)
  ci_commit = relationship("CiCommitOld", back_populates="batches", foreign_keys=[ci_commit_id])
  ci_commit_new_id = Column(Integer())


# class CiCommitNew(Base):
#   __tablename__ = 'ci_commits'
#   id = sa.Column(sa.Integer, primary_key=True)
#   hexsha = sa.Column(sa.String)
#   batches = relationship("BatchNew", back_populates="ci_commit")
# class BatchNew(Base):
#   __tablename__ = 'batches'
#   id = sa.Column(sa.String, primary_key=True)
#   ci_commit_id = Column(Integer(), ForeignKey('ci_commits.id'), index=True)
#   ci_commit = relationship("CiCommitNew", back_populates="batches", foreign_keys=[ci_commit_id])




def upgrade():
  # rename information -> data
  op.alter_column('projects', 'information', type_=sa.JSON, new_column_name='data')

  # connect to the database
  bind = op.get_bind()
  session = Session(bind=bind)
  
  # add the new keys as columns
  op.add_column('ci_commits', sa.Column('hexsha', sa.String))
  op.add_column('ci_commits', sa.Column('new_id', sa.Integer))
  op.add_column('batches', sa.Column('ci_commit_new_id', sa.Integer))
  total = 8286 # +/-
  ci_commits = session.query(CiCommitOld)
  for ci_commit_id, ci_commit in enumerate(ci_commits):
  	print(f"{100 * ci_commit_id / 8286:.2f}%")
  	ci_commit.hexsha = ci_commit.id
  	ci_commit.new_id = ci_commit_id
  	for batch in ci_commit.batches:
  	  batch.ci_commit_new_id = ci_commit_id

  op.alter_column('ci_commits', 'hexsha', nullable=False)

  print("remove the old key")
  op.execute('ALTER TABLE ci_commits DROP CONSTRAINT ci_commits_pkey CASCADE')
  op.drop_column('ci_commits', 'id')
  op.drop_column('batches', 'ci_commit_id')

  print("replace the old keys")
  op.alter_column('ci_commits', 'new_id', type_=sa.Integer, new_column_name='id')
  op.alter_column('batches', 'ci_commit_new_id', type_=sa.Integer, new_column_name='ci_commit_id')

  op.create_primary_key('ci_commits_pkey', 'ci_commits', ['id'])
  op.create_foreign_key('fk_batchs_ci_commits_id', 'batches', 'ci_commits', ['ci_commit_id'], ['id'], ondelete='CASCADE')

  print("we need a new index")
  op.drop_index('ix_project_it')
  op.create_index('ci_commits_hexsha_idx', 'ci_commits', ['project_id', 'hexsha'])
  
  # auto-increment
  op.execute("CREATE SEQUENCE ci_commits_id_seq START WITH 10000 INCREMENT BY 1 NO MINVALUE NO MAXVALUE CACHE 1")
  op.execute("ALTER TABLE ci_commits ALTER COLUMN id SET DEFAULT nextval('ci_commits_id_seq'::regclass)")

def downgrade():
  # rename data -> information 
  op.alter_column('projects', 'data', type_=sa.JSON, new_column_name='information')

  # main downgrade
  op.alter_column('ci_commits', 'hexsha', type_=sa.String, new_column_name='id')
  op.create_primary_key('ci_commits_pkey', 'ci_commits', ['id'])
  for ci_commit in ci_commits:
  	ci_commits.id = ci_commit.hexsha

  # # update the index
  op.create_index('ix_project_it', 'ci_commits', ['project_id'])
