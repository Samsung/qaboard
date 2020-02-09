"""Remove hardcoded test-input data columns

Revision ID: 8d684ac2793b
Revises: 7bb944065bfd
Create Date: 2018-10-09 11:27:09.950444

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = '8d684ac2793b'
down_revision = '7bb944065bfd'
branch_labels = None
depends_on = None


def upgrade():
  op.drop_column('test_inputs', 'stereo_baseline')
  op.drop_column('test_inputs', 'duration')
  op.drop_column('test_inputs', 'is_wide_angle')
  op.drop_column('test_inputs', 'is_dynamic')
  op.drop_column('test_inputs', 'is_static')
  op.drop_column('test_inputs', 'is_calibration')
  op.drop_column('test_inputs', 'is_flickering')
  op.drop_column('test_inputs', 'is_low_light')
  op.drop_column('test_inputs', 'is_hdr')
  op.drop_column('test_inputs', 'motion_axis')
  op.drop_column('test_inputs', 'motion_speed')
  op.drop_column('test_inputs', 'motion_is_translation')
  op.drop_column('test_inputs', 'motion_is_rotation')


def downgrade():
  pass
  # syntax:
  # op.('ci_commits', sa.Column('message', sa.String))
  #
  # op.add_column('test_inputs', 'stereo_baseline')
  # op.add_column('test_inputs', 'duration')
  # op.add_column('test_inputs', 'is_wide_angle')
  # op.add_column('test_inputs', 'is_dynamic')
  # op.add_column('test_inputs', 'is_static')
  # op.add_column('test_inputs', 'is_calibration')
  # op.add_column('test_inputs', 'is_flickering')
  # op.add_column('test_inputs', 'is_low_light')
  # op.add_column('test_inputs', 'is_hdr')
  # op.add_column('test_inputs', 'motion_axis')
  # op.add_column('test_inputs', 'motion_speed')
  # op.add_column('test_inputs', 'motion_is_translation')
  # op.add_column('test_inputs', 'motion_is_rotation')
