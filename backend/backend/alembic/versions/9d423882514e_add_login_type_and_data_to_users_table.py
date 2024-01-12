"""add login-type and data to users table

Revision ID: 9d423882514e
Revises: bdacefe1d00c
Create Date: 2023-11-14 14:01:35.046389

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB


# revision identifiers, used by Alembic.
revision = '9d423882514e'
down_revision = 'bdacefe1d00c'
branch_labels = None
depends_on = None


def upgrade():
  op.add_column('users', sa.Column('login_type', sa.String))
  op.add_column('users', sa.Column('data', JSONB))
  # for each entry, set to login_type with values LOCAL/LDAP/SAML according to is_ldap and is_sso
  op.execute("""
              UPDATE users SET login_type = 
                CASE
                  WHEN is_sso THEN 'SAML'
                  WHEN is_ldap THEN 'LDAP'
                  ELSE 'LOCAL'
                END;
              """)

  op.drop_column('users', 'is_sso')
  op.drop_column('users', 'is_ldap')



def downgrade():
  op.add_column('users', sa.Column('is_sso', sa.Boolean))
  op.add_column('users', sa.Column('is_ldap', sa.Boolean))
  # for each entry, set is_sso,is_ldap according to login_type
  op.execute("""
              UPDATE users SET is_sso =
                CASE
                  WHEN login_type='SAML' THEN true
                  ELSE false
                END;
              """)

  op.execute("""
              UPDATE users SET is_ldap =
                CASE
                  WHEN login_type='LDAP' THEN true
                  ELSE false
                END;
              """)

  op.drop_column('users', 'login_type')
  op.drop_column('users', 'data')
