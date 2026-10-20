"""User management, part 1: user status/admins/preferences, hashed and scoped tokens, audit log, settings, device flow

- users: kind, status, is_admin, last_login_at, preferences, preferences_updated_at
- tokens: we store sha256(token) instead of the token. Existing tokens are hashed in place, keep working, and are
  marked as "legacy" (every scope, no expiry). Also fixes the drift with the model: `data` was missing, and
  `expires_at` was NOT NULL while the app creates tokens without expiry.
- audit_events, settings, device_authorizations: new tables
Also declared in the models, for databases created by the app.

Downgrading deletes the tokens: older versions need them in clear, and we don't have them anymore.

Revision ID: c3d5e7f9a1b2
Revises: f2c8d4a6b1e9
Create Date: 2026-10-20 12:00:00.000000

"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql


# revision identifiers, used by Alembic.
revision = 'c3d5e7f9a1b2'
down_revision = 'f2c8d4a6b1e9'
branch_labels = None
depends_on = None


def columns(table):
  return {c['name'] for c in sa.inspect(op.get_bind()).get_columns(table)}


def has_table(table):
  return sa.inspect(op.get_bind()).has_table(table)


def add_columns(table, *new_columns):
  existing = columns(table)
  for column in new_columns:
    if column.name not in existing:
      op.add_column(table, column)


def upgrade():
  add_columns('users',
    sa.Column('kind', sa.String(), nullable=False, server_default='human'),
    sa.Column('status', sa.String(), nullable=False, server_default='active'),
    sa.Column('is_admin', sa.Boolean(), nullable=False, server_default='false'),
    sa.Column('last_login_at', sa.DateTime(), nullable=True),
    sa.Column('preferences', postgresql.JSONB(), nullable=False, server_default='{}'),
    sa.Column('preferences_updated_at', sa.DateTime(), nullable=True),
  )

  add_columns('tokens',
    sa.Column('token_hash', sa.String(64), nullable=True),
    sa.Column('prefix', sa.String(), nullable=False, server_default=''),
    sa.Column('kind', sa.String(), nullable=False, server_default='personal'),
    sa.Column('name', sa.String(), nullable=False, server_default=''),
    sa.Column('created_by_id', sa.Integer(), sa.ForeignKey('users.id', ondelete='SET NULL'), nullable=True),
    sa.Column('scopes', postgresql.JSONB(), nullable=False, server_default='[]'),
    sa.Column('projects', postgresql.JSONB(), nullable=False, server_default='[]'),
    sa.Column('idle_expiry_days', sa.Integer(), nullable=True),
    sa.Column('last_used_at', sa.DateTime(), nullable=True),
    sa.Column('last_used_ip', sa.String(), nullable=True),
    sa.Column('revoked_at', sa.DateTime(), nullable=True),
    sa.Column('revoked_by_id', sa.Integer(), sa.ForeignKey('users.id', ondelete='SET NULL'), nullable=True),
    sa.Column('data', postgresql.JSONB(), nullable=False, server_default='{}'),
  )
  op.alter_column('tokens', 'token', existing_type=sa.String(64), nullable=True)
  op.alter_column('tokens', 'expires_at', existing_type=sa.DateTime(), nullable=True)
  # The tokens in clear become hashes. We keep 8 characters to recognize them.
  op.execute("""
    UPDATE tokens SET
      token_hash = encode(sha256(convert_to(token, 'UTF8')), 'hex'),
      prefix = left(token, 8),
      kind = 'legacy',
      name = CASE WHEN name = '' THEN 'API token' ELSE name END,
      revoked_at = CASE WHEN revoked THEN now() AT TIME ZONE 'utc' END,
      token = NULL
    WHERE token IS NOT NULL
  """)
  op.create_index('ix_tokens_token_hash', 'tokens', ['token_hash'], unique=True, if_not_exists=True)

  if not has_table('audit_events'):
    op.create_table(
      'audit_events',
      sa.Column('id', sa.BigInteger(), primary_key=True),
      sa.Column('created_at', sa.DateTime(), nullable=False),
      sa.Column('actor_kind', sa.String(), nullable=False),
      sa.Column('actor_user_id', sa.Integer(), nullable=True),
      sa.Column('actor_token_id', sa.Integer(), nullable=True),
      sa.Column('actor_label', sa.String(), nullable=True),
      sa.Column('ip', sa.String(), nullable=True),
      sa.Column('user_agent', sa.String(), nullable=True),
      sa.Column('action', sa.String(), nullable=False),
      sa.Column('target_type', sa.String(), nullable=True),
      sa.Column('target_id', sa.String(), nullable=True),
      sa.Column('target_label', sa.String(), nullable=True),
      sa.Column('project_id', sa.String(), nullable=True),
      sa.Column('changes', postgresql.JSONB(), nullable=False, server_default='{}'),
      sa.Column('meta', postgresql.JSONB(), nullable=False, server_default='{}'),
    )
    op.create_index('ix_audit_events_created_at', 'audit_events', ['created_at'])
    op.create_index('ix_audit_events_actor_user_id', 'audit_events', ['actor_user_id'])
    op.create_index('ix_audit_events_target', 'audit_events', ['target_type', 'target_id'])
    op.create_index('ix_audit_events_action', 'audit_events', ['action'])

  if not has_table('settings'):
    op.create_table(
      'settings',
      sa.Column('key', sa.String(), primary_key=True),
      sa.Column('value', postgresql.JSONB(), nullable=False),
      sa.Column('updated_by_id', sa.Integer(), sa.ForeignKey('users.id', ondelete='SET NULL'), nullable=True),
      sa.Column('updated_at', sa.DateTime(), nullable=False),
    )

  if not has_table('device_authorizations'):
    op.create_table(
      'device_authorizations',
      sa.Column('id', sa.Integer(), primary_key=True),
      sa.Column('device_code_hash', sa.String(64), nullable=False, unique=True),
      sa.Column('user_code', sa.String(), nullable=False, index=True),
      sa.Column('client_name', sa.String(), nullable=False, server_default=''),
      sa.Column('hostname', sa.String(), nullable=True),
      sa.Column('ip', sa.String(), nullable=True),
      sa.Column('scopes', postgresql.JSONB(), nullable=False, server_default='[]'),
      sa.Column('status', sa.String(), nullable=False, server_default='pending'),
      sa.Column('created_at', sa.DateTime(), nullable=False),
      sa.Column('expires_at', sa.DateTime(), nullable=False),
      sa.Column('last_polled_at', sa.DateTime(), nullable=True),
      sa.Column('user_id', sa.Integer(), sa.ForeignKey('users.id', ondelete='CASCADE'), nullable=True),
      sa.Column('token_id', sa.Integer(), sa.ForeignKey('tokens.id', ondelete='SET NULL'), nullable=True),
    )


def downgrade():
  op.drop_table('device_authorizations')
  op.drop_table('settings')
  op.drop_table('audit_events')
  op.execute("DELETE FROM tokens WHERE token IS NULL")
  op.drop_index('ix_tokens_token_hash', table_name='tokens', if_exists=True)
  for column in ('token_hash', 'prefix', 'kind', 'name', 'created_by_id', 'scopes', 'projects', 'idle_expiry_days',
                 'last_used_at', 'last_used_ip', 'revoked_at', 'revoked_by_id'):
    op.drop_column('tokens', column)
  op.alter_column('tokens', 'token', existing_type=sa.String(64), nullable=False)
  for column in ('kind', 'status', 'is_admin', 'last_login_at', 'preferences', 'preferences_updated_at'):
    op.drop_column('users', column)
