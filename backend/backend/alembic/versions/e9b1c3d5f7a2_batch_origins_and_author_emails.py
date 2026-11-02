"""Where batches come from and who started them, and the commits' authors: users see their own work (backend/origins.py).
Also declared in the models, for databases created by the app.

batches can be big in production, outputs bigger, and results keep coming during deploys:
- the new columns are nullable without defaults: PostgreSQL only changes its catalog (a short lock, we give up
  after a few seconds rather than wait behind long queries; run the migration again if it times out). The foreign key
  is added NOT VALID, then validated without blocking writes.
- old batches are filled a thousand at a time, each chunk in its own transaction. We skip the rows the server is
  writing (SKIP LOCKED): it fills those itself. We read one run per batch, never all their runs.
- the indexes are built CONCURRENTLY.
- commits get their author's email when `qa` sends results again: old ones match users by name (backend/mine.py).

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
  sa.Column('user_id', sa.Integer(), nullable=True),
  sa.Column('latest_output_datetime', sa.DateTime(), nullable=True),
]
FOREIGN_KEY = 'fk_batches_user_id'
indexes = [
  # name, table, columns
  ('ix_batches_user_id_latest_output_datetime', 'batches', ['user_id', 'latest_output_datetime']),
  ('ix_batches_user_name_latest_output_datetime', 'batches', ['user_name', 'latest_output_datetime']),
  ('ix_batches_latest_output_datetime', 'batches', ['latest_output_datetime']),
  ('ix_ci_commits_author_email', 'ci_commits', ['author_email']),
  ('ix_ci_commits_lower_committer_name', 'ci_commits', [sa.text('lower(committer_name)')]),
]
CHUNK = 1000

# The rules of backend/origins.py, with what old batches have:
# - created by a submission (at most a minute before it): the web app's
# - a run of a submission: the web app's (we only keep the latest submissions, the first may be gone), as are
#   batches with submissions whose runs came from clients too old to say which command they belong to
# - else what `qa` said: local, or ci
SUBMISSIONS = "(CASE WHEN jsonb_typeof(b.data->'submissions') = 'object' THEN b.data->'submissions' END)"
DATE = r"'^\d{4}-\d{2}-\d{2}T'"
FILL = f"""
WITH chunk AS (
  SELECT id FROM batches WHERE id >= :start AND id < :end AND origin IS NULL FOR UPDATE SKIP LOCKED
), info AS (
  SELECT b.id, b.label, b.created_date, b.data, {SUBMISSIONS} AS submissions, run.data AS run
  FROM batches b
  JOIN chunk ON chunk.id = b.id
  LEFT JOIN LATERAL (SELECT o.data FROM outputs o WHERE o.batch_id = b.id LIMIT 1) run ON true
), origins AS (
  SELECT id, run, submissions,
    CASE
      WHEN submissions IS NOT NULL AND created_date >= (
        SELECT min((s.value->>'created_at')::timestamptz) AT TIME ZONE 'UTC' FROM jsonb_each(submissions) s
        WHERE s.value->>'created_at' ~ {DATE}
      ) - interval '1 minute' THEN 'webapp'
      WHEN submissions IS NOT NULL AND run->>'root_command_id' IS NOT NULL AND submissions ? (run->>'root_command_id') THEN 'webapp'
      WHEN submissions IS NOT NULL AND label <> 'default' AND run IS NOT NULL AND run->>'root_command_id' IS NULL THEN 'webapp'
      WHEN data->>'type' = 'local' OR label LIKE '@%| %' THEN 'local'
      ELSE 'ci'
    END AS origin
  FROM info
), named AS (
  SELECT id, origin,
    CASE
      WHEN origin = 'webapp' AND submissions IS NOT NULL THEN
        (SELECT s.value->>'user' FROM jsonb_each(submissions) s ORDER BY s.value->>'created_at' LIMIT 1)
      ELSE coalesce(run->'submitted_by'->>'user_name', run->>'user')
    END AS user_name,
    CASE WHEN run->'submitted_by'->>'user_id' ~ '^[0-9]{{1,9}}$' THEN (run->'submitted_by'->>'user_id')::int END AS verified_id
  FROM origins
)
UPDATE batches SET
  origin = named.origin,
  user_name = named.user_name,
  user_id = coalesce(
    (SELECT u.id FROM users u WHERE u.id = named.verified_id),
    CASE WHEN named.origin = 'webapp' THEN (SELECT u.id FROM users u WHERE u.user_name = named.user_name ORDER BY u.id LIMIT 1) END
  ),
  -- old batches: they're sorted by when they were created
  latest_output_datetime = coalesce(batches.latest_output_datetime, batches.created_date)
FROM named
WHERE batches.id = named.id
"""


def upgrade():
  bind = op.get_bind()
  inspector = sa.inspect(bind)
  existing = {c['name'] for c in inspector.get_columns('batches')}
  has_email = 'author_email' in {c['name'] for c in inspector.get_columns('ci_commits')}
  if any(c.name not in existing for c in batch_columns) or not has_email:
    op.execute("SET LOCAL lock_timeout = '10s'")
    for column in batch_columns:
      if column.name not in existing:
        op.add_column('batches', column)
    if not has_email:
      op.add_column('ci_commits', sa.Column('author_email', sa.String(), nullable=True))
  if not any(fk['name'] == FOREIGN_KEY for fk in inspector.get_foreign_keys('batches')):
    op.execute("SET LOCAL lock_timeout = '10s'")
    op.execute(f"ALTER TABLE batches ADD CONSTRAINT {FOREIGN_KEY} FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE SET NULL NOT VALID")

  with op.get_context().autocommit_block():
    # in autocommit mode: each chunk is its own transaction. Batches created meanwhile by servers that don't fill
    # them yet (during rolling deploys) are filled by the next pass.
    done = 0
    while True:
      max_id = bind.execute(sa.text("SELECT max(id) FROM batches")).scalar() or 0
      if max_id < done:
        break
      for start in range(done, max_id + 1, CHUNK):
        bind.execute(sa.text(FILL), {"start": start, "end": start + CHUNK})
      done = max_id + 1
    bind.execute(sa.text(f"ALTER TABLE batches VALIDATE CONSTRAINT {FOREIGN_KEY}"))

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
  op.drop_column('ci_commits', 'author_email')
  op.execute(f"ALTER TABLE batches DROP CONSTRAINT IF EXISTS {FOREIGN_KEY}")
  for column in reversed(batch_columns):
    op.drop_column('batches', column.name)
