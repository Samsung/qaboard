"""Where batches come from and who started them, and the commits' emails: users see their own work (backend/origins.py).
Also declared in the models, for databases created by the app.

batches can be big in production, outputs bigger, and results keep coming during deploys:
- the new columns are nullable without defaults: PostgreSQL only changes its catalog (a short lock, we give up
  after a few seconds rather than wait behind long queries; run the migration again if it times out).
- old batches are filled in chunks of a few thousand, each in its own transaction: they're only locked for a moment.
  Expect minutes on big databases. Batches that get results meanwhile are filled by the server itself.
- the indexes are built CONCURRENTLY.
- commits get their emails when `qa` sends results again: old ones match users by name (api/mine.py).

Revision ID: e9b1c3d5f7a2
Revises: d2f4a6b8c0e1
Create Date: 2026-10-24 16:00:00.000000

"""
from alembic import op
import sqlalchemy as sa


# revision identifiers, used by Alembic.
revision = 'e9b1c3d5f7a2'
down_revision = 'd2f4a6b8c0e1'
branch_labels = None
depends_on = None


batch_columns = [
  sa.Column('origin', sa.String(), nullable=True),
  sa.Column('user_name', sa.String(), nullable=True),
  sa.Column('user_id', sa.Integer(), sa.ForeignKey('users.id', ondelete='SET NULL', name='fk_batches_user_id'), nullable=True),
  sa.Column('latest_output_datetime', sa.DateTime(), nullable=True),
]
indexes = [
  # name, table, columns
  ('ix_batches_user_id_latest_output_datetime', 'batches', ['user_id', 'latest_output_datetime']),
  ('ix_batches_user_name_latest_output_datetime', 'batches', ['user_name', 'latest_output_datetime']),
  ('ix_ci_commits_committer_email_authored_datetime', 'ci_commits', ['committer_email', sa.text('authored_datetime DESC')]),
]
CHUNK = 5000

# The rules of backend/origins.py, with what old batches have. Batches created by a submission are the web app's
# (created at most a minute before it). We only keep the latest submissions: the first may be gone.
ORIGIN = """
  CASE
    WHEN data ? 'submissions' AND created_date >= (
      SELECT min((s.value->>'created_at')::timestamptz) AT TIME ZONE 'UTC' FROM jsonb_each(data->'submissions') s
    ) - interval '1 minute' THEN 'webapp'
    WHEN data ? 'submissions' AND label <> 'default' THEN 'webapp'
    WHEN data->>'type' = 'local' OR label LIKE '@%| %' THEN 'local'
    ELSE 'ci'
  END
"""
# Who started it: the earliest submission's user for the web app's, else the first run's (verified, else claimed)
FIRST_SUBMISSION_USER = """
  (SELECT s.value->>'user' FROM jsonb_each(batches.data->'submissions') s ORDER BY s.value->>'created_at' LIMIT 1)
"""
FIRST_RUN = "(SELECT o.data FROM outputs o WHERE o.batch_id = batches.id ORDER BY o.id LIMIT 1)"
FILL = f"""
  UPDATE batches SET origin = {ORIGIN} WHERE id >= :start AND id < :end AND origin IS NULL;
  UPDATE batches SET
    user_name = CASE WHEN origin = 'webapp' THEN {FIRST_SUBMISSION_USER}
                     ELSE coalesce({FIRST_RUN}->'submitted_by'->>'user_name', {FIRST_RUN}->>'user') END,
    latest_output_datetime = (SELECT max(o.created_date) FROM outputs o WHERE o.batch_id = batches.id)
  WHERE id >= :start AND id < :end AND user_name IS NULL AND latest_output_datetime IS NULL;
  UPDATE batches SET user_id = (
    SELECT u.id FROM users u
    WHERE u.id::text = coalesce(({FIRST_RUN}->'submitted_by'->>'user_id'), '') OR (batches.origin = 'webapp' AND u.user_name = batches.user_name)
    ORDER BY u.id LIMIT 1
  )
  WHERE id >= :start AND id < :end AND user_id IS NULL AND user_name IS NOT NULL AND origin <> 'ci';
"""


def upgrade():
  bind = op.get_bind()
  inspector = sa.inspect(bind)
  existing = {c['name'] for c in inspector.get_columns('batches')}
  has_email = 'committer_email' in {c['name'] for c in inspector.get_columns('ci_commits')}
  if any(c.name not in existing for c in batch_columns) or not has_email:
    op.execute("SET LOCAL lock_timeout = '10s'")
    for column in batch_columns:
      if column.name not in existing:
        op.add_column('batches', column)
    if not has_email:
      op.add_column('ci_commits', sa.Column('committer_email', sa.String(), nullable=True))

  with op.get_context().autocommit_block():
    max_id = bind.execute(sa.text("SELECT max(id) FROM batches")).scalar() or 0
    # in autocommit mode: each statement is its own transaction
    for start in range(0, max_id + 1, CHUNK):
      for statement in FILL.split(';'):
        if statement.strip():
          bind.execute(sa.text(statement), {"start": start, "end": start + CHUNK})

    # If it fails, CONCURRENTLY leaves an INVALID index, that IF NOT EXISTS would keep: we drop it, and build it again.
    for name, table, index_columns in indexes:
      is_invalid = bind.execute(sa.text(
        "SELECT 1 FROM pg_index JOIN pg_class ON pg_class.oid = pg_index.indexrelid WHERE pg_class.relname = :name AND NOT pg_index.indisvalid"
      ), {"name": name}).first()
      if is_invalid:
        op.drop_index(name, table_name=table, postgresql_concurrently=True, if_exists=True)
      op.create_index(name, table, index_columns, postgresql_concurrently=True, if_not_exists=True)


def downgrade():
  with op.get_context().autocommit_block():
    for name, table, _ in indexes:
      op.drop_index(name, table_name=table, postgresql_concurrently=True, if_exists=True)
  op.drop_column('ci_commits', 'committer_email')
  for column in reversed(batch_columns):
    op.drop_column('batches', column.name)
