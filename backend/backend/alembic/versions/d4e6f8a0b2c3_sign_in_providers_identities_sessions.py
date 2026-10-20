"""User management, part 2: sign-in providers, identities, server-side sessions, access requests

- auth_providers: OIDC providers added in the admin panel
- user_identities: how each user signs in. Backfilled from users.login_type: ldap/saml/local, with the user name as
  subject (SAML's is replaced by the NameID at the user's next sign-in)
- user_sessions: browser sessions, revocable. Existing sessions become rows at their next request (no sign-out)
- access_requests: users waiting for an admin
Also declared in the models, for databases created by the app.

Revision ID: d4e6f8a0b2c3
Revises: c3d5e7f9a1b2
Create Date: 2026-10-21 09:00:00.000000

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision = 'd4e6f8a0b2c3'
down_revision = 'c3d5e7f9a1b2'
branch_labels = None
depends_on = None


def has_table(table):
  return sa.inspect(op.get_bind()).has_table(table)


def upgrade():
  if not has_table('auth_providers'):
    op.create_table(
      'auth_providers',
      sa.Column('id', sa.String(), primary_key=True),
      sa.Column('type', sa.String(), nullable=False, server_default='oidc'),
      sa.Column('name', sa.String(), nullable=False, server_default=''),
      sa.Column('enabled', sa.Boolean(), nullable=False, server_default='true'),
      sa.Column('position', sa.Integer(), nullable=False, server_default='0'),
      sa.Column('config', postgresql.JSONB(), nullable=False, server_default='{}'),
      sa.Column('secret_encrypted', sa.Text(), nullable=True),
      sa.Column('created_at', sa.DateTime(), nullable=False),
      sa.Column('updated_at', sa.DateTime(), nullable=False),
    )

  if not has_table('user_identities'):
    op.create_table(
      'user_identities',
      sa.Column('id', sa.Integer(), primary_key=True),
      sa.Column('user_id', sa.Integer(), sa.ForeignKey('users.id', ondelete='CASCADE'), nullable=False, index=True),
      sa.Column('provider_id', sa.String(), nullable=False),
      sa.Column('subject', sa.String(), nullable=False),
      sa.Column('email', sa.String(), nullable=True),
      sa.Column('claims', postgresql.JSONB(), nullable=False, server_default='{}'),
      sa.Column('created_at', sa.DateTime(), nullable=False),
      sa.Column('last_login_at', sa.DateTime(), nullable=True),
      sa.UniqueConstraint('provider_id', 'subject', name='uq_user_identities_provider_subject'),
    )
    op.execute("""
      INSERT INTO user_identities (user_id, provider_id, subject, email, claims, created_at, last_login_at)
      SELECT id,
             CASE upper(coalesce(login_type, 'LOCAL')) WHEN 'LDAP' THEN 'ldap' WHEN 'SAML' THEN 'saml' ELSE 'local' END,
             user_name, email, '{"legacy": true}'::jsonb, created_date, last_login_at
      FROM users
      WHERE user_name IS NOT NULL AND kind = 'human'
      ON CONFLICT DO NOTHING
    """)

  if not has_table('user_sessions'):
    op.create_table(
      'user_sessions',
      sa.Column('id', sa.Integer(), primary_key=True),
      sa.Column('id_hash', sa.String(64), nullable=False, unique=True),
      sa.Column('user_id', sa.Integer(), sa.ForeignKey('users.id', ondelete='CASCADE'), nullable=False, index=True),
      sa.Column('provider_id', sa.String(), nullable=True),
      sa.Column('created_at', sa.DateTime(), nullable=False),
      sa.Column('last_seen_at', sa.DateTime(), nullable=False),
      sa.Column('expires_at', sa.DateTime(), nullable=False),
      sa.Column('ip', sa.String(), nullable=True),
      sa.Column('user_agent', sa.String(), nullable=True),
      sa.Column('revoked_at', sa.DateTime(), nullable=True),
    )

  if not has_table('access_requests'):
    op.create_table(
      'access_requests',
      sa.Column('id', sa.Integer(), primary_key=True),
      sa.Column('user_id', sa.Integer(), sa.ForeignKey('users.id', ondelete='CASCADE'), nullable=False, index=True),
      sa.Column('kind', sa.String(), nullable=False, server_default='instance'),
      sa.Column('message', sa.Text(), nullable=False, server_default=''),
      sa.Column('status', sa.String(), nullable=False, server_default='pending'),
      sa.Column('decided_by_id', sa.Integer(), sa.ForeignKey('users.id', ondelete='SET NULL'), nullable=True),
      sa.Column('decided_at', sa.DateTime(), nullable=True),
      sa.Column('created_at', sa.DateTime(), nullable=False),
    )


def downgrade():
  op.drop_table('access_requests')
  op.drop_table('user_sessions')
  op.drop_table('user_identities')
  op.drop_table('auth_providers')
