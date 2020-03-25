"""Convert configuration to JSONB as configurations

Revision ID: 8d84dfaf350d
Revises: c10df60dd41c
Create Date: 2020-03-11 08:31:41.905096

"""
import time

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB
import sqlalchemy.dialects.postgresql as postgresql

from sqlalchemy.orm import sessionmaker, Session as BaseSession
from sqlalchemy.ext.declarative import declarative_base

from qaboard.conventions import deserialize_config, serialize_config

Base = declarative_base()
Session = sessionmaker()

class Output(Base):
  __tablename__ = 'outputs'
  id = sa.Column(sa.Integer, primary_key=True)
  configuration = sa.Column(sa.String())
  configurations = sa.Column(JSONB(), default=[])

# revision identifiers, used by Alembic.
revision = '8d84dfaf350d'
down_revision = 'c10df60dd41c'
branch_labels = None
depends_on = None


def upgrade():
  start = time.time()
  print('Upgrading extra_parameters')
  op.alter_column('outputs', 'extra_parameters', type_=postgresql.JSONB, postgresql_using='extra_parameters::text::jsonb')

  print(f'Upgrading configurations [{time.time() - start:.1f}s]')
  op.execute('ALTER TABLE "outputs" ADD COLUMN configurations jsonb;')
  # the column needs to really exist before the calls to bulk_update_mapping()
  # op.add_column('outputs', sa.Column('configurations', JSONB))

  bind = op.get_bind()
  session = Session(bind=bind, autoflush=False)

  batch = []
  batch_size =      50_000
  output_total = 1_608_000
  start_batch  = time.time()
  for idx, o in enumerate(session.query(Output)):
      if idx % batch_size == 0:
          print(o, deserialize_config(o.configuration))
          now = time.time()
          print(f"{idx/output_total:.1%} [{batch_size/(now - start_batch):.1f}/s] [est. total left {(now - start_batch) * ((output_total-idx)/batch_size) / 3600:.2f}h] [elapsed time: {now - start:.1f}s]")
          start_batch = now
          session.bulk_update_mappings(Output, batch)
          session.flush()
          batch = []
      batch.append({"id": o.id, "configurations": deserialize_config(o.configuration)})

  print(f"DONE, now committing configurations [elapsed time: {now - start:.1f}s]")
  session.bulk_update_mappings(Output, batch)
  session.flush()
  session.commit()
  print(f"DONE, now dropping configuration [elapsed time: {now - start:.1f}s]")
  op.drop_column("outputs", "configuration")

  print('Creating idx_outputs_filter')
  op.create_index('idx_outputs_filter', 'outputs', ["batch_id", "test_input_id", "platform"])




def downgrade():
  print('Downgrading extra_parameters')
  op.alter_column('outputs', 'extra_parameters', type_=sa.dialects.postgresql.JSON, postgresql_using='extra_parameters::jsonb::text')

  print(f'Removing idx_outputs_filter [{time.time() - start:.1f}s]')
  op.drop_index('idx_outputs_filter')

  print(f'Downgrading configuration [{time.time() - start:.1f}s]')
  op.add_column('outputs', sa.Column('configuration', sa.STRING))
  bind = op.get_bind()
  session = Session(bind=bind)
  for idx, o in enumerate(session.query(Output)):
      if idx % 100 == 0:
          print(f"#{idx} [{time.time() - start}s]")
          session.commit()
      o.configuration = serialize_config(o.configurations)
      session.add(o)

  session.flush()
  session.commit()
  op.drop_column("batches", "configurations")
