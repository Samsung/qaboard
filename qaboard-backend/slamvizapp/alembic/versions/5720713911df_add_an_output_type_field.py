"""add an output_type field

Revision ID: 5720713911df
Revises: 10dea94d2dc1
Create Date: 2018-05-24 12:05:10.226540

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = '5720713911df'
down_revision = '10dea94d2dc1'
branch_labels = None
depends_on = None


from sqlalchemy.orm import sessionmaker, Session as BaseSession
from sqlalchemy.ext.declarative import declarative_base

Base = declarative_base()
Session = sessionmaker()

class Output(Base):
  __tablename__ = 'outputs'
  id = sa.Column(sa.Integer, primary_key=True)


def upgrade():
  op.add_column('outputs', sa.Column('output_type', sa.String))
  bind = op.get_bind()
  session = Session(bind=bind)
  # let's home it's all SLAM!
  for o in session.query(Output):
    setattr(o, 'output_type', 'slam/6dof') 
  session.commit()

def downgrade():
  op.drop_column('outputs', 'output_type')
