"""outputs.metrics: from JSON (text, parsed by every read) to JSONB, online

`ALTER COLUMN metrics TYPE jsonb` would rewrite the biggest table under an ACCESS EXCLUSIVE lock: minutes without
runs or pages. Instead, without blocking writes for more than a moment:
1. A nullable `metrics_jsonb` column (no rewrite), kept equal to `metrics` by a trigger on INSERT and UPDATE OF metrics.
2. A backfill, BATCH_SIZE ids per transaction, each committed.
3. CHECK (metrics_jsonb IS NOT NULL) NOT VALID, then VALIDATE: a scan that doesn't block writes.
4. One short transaction, retried with a lock_timeout: SET NOT NULL (uses the validated CHECK, no scan),
   drop the trigger and the old column, rename metrics_jsonb to metrics, default '{}'::jsonb.
The old column is dropped, not kept: once the new code writes, it is stale, so it couldn't serve a rollback.
downgrade() converts back, without losing values.

Databases where metrics is already jsonb (converted by hand, or created by the app from the models) only get the
default and the json_typeof(jsonb) shim. A run that was interrupted resumes where it was.

Values that json accepts but jsonb doesn't: "\\u0000" (NUL in a string) becomes "\\ufffd".
Older QA-Board versions call json_typeof() on metrics: a json_typeof(jsonb) function keeps them working, e.g. while
a rolling deploy replaces them, or after a rollback.

Revision ID: d3f5b7c9e1a4
Revises: a7c9e1b3d5f6
Create Date: 2026-11-24 12:00:00.000000

"""
import os
import re
import time
import random

from alembic import op, context
import sqlalchemy as sa
from sqlalchemy.exc import DBAPIError


# revision identifiers, used by Alembic.
revision = 'd3f5b7c9e1a4'
down_revision = 'a7c9e1b3d5f6'
branch_labels = None
depends_on = None


BATCH_SIZE = 10_000  # ids per backfill transaction
# Seconds to wait between them, e.g. 0.2 for replicas that lag behind: the backfill writes ~3.5 GB of WAL per million runs
PAUSE = float(os.environ.get('QABOARD_MIGRATION_BACKFILL_PAUSE') or 0)
# How long writers may wait behind our brief ACCESS EXCLUSIVE locks: we give up, and retry, rather than make them wait
LOCK_TIMEOUT = '500ms'
LOCK_ATTEMPTS = 60
CONSTRAINT = 'outputs_metrics_jsonb_not_null'
TRIGGER = 'qaboard_outputs_metrics_jsonb'

CONVERT_FUNCTION = r"""
CREATE OR REPLACE FUNCTION qaboard_metrics_jsonb(value json) RETURNS jsonb
LANGUAGE sql IMMUTABLE PARALLEL SAFE AS $$
  SELECT CASE
    WHEN value IS NULL THEN '{}'::jsonb
    WHEN strpos(value::text, '\u0000') = 0 THEN value::jsonb
    -- jsonb can't store NUL characters
    ELSE regexp_replace(value::text, '(?<!\\)((?:\\\\)*)\\u0000', '\1\\ufffd', 'g')::jsonb
  END
$$"""
TRIGGER_FUNCTION = f"""
CREATE OR REPLACE FUNCTION {TRIGGER}() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.metrics_jsonb := qaboard_metrics_jsonb(NEW.metrics);
  RETURN NEW;
END $$"""
# For older versions' queries, e.g. json_typeof(metrics->'loss'). Inlined by postgres: free.
JSON_TYPEOF_SHIM = "CREATE OR REPLACE FUNCTION json_typeof(jsonb) RETURNS text LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS 'SELECT jsonb_typeof($1)'"


def log(message):
  print(f"[outputs.metrics → jsonb] {message}", flush=True)


def sql(statement, params=None):
  bind = op.get_bind()
  if params is None:
    return bind.exec_driver_sql(statement)
  return bind.execute(sa.text(statement), params)


def column_type(column):
  return sql(
    "SELECT format_type(atttypid, atttypmod) FROM pg_attribute "
    "WHERE attrelid = 'outputs'::regclass AND attname = :column AND attnum > 0 AND NOT attisdropped",
    {"column": column},
  ).scalar()


def in_short_transaction(statements, what):
  """Runs the statements in one transaction that waits at most LOCK_TIMEOUT for its locks, retried until it gets them"""
  for attempt in range(1, LOCK_ATTEMPTS + 1):
    sql("BEGIN")
    try:
      sql(f"SET LOCAL lock_timeout = '{LOCK_TIMEOUT}'")
      sql("SET LOCAL statement_timeout = '60s'")
      start = time.monotonic()
      for statement in statements:
        sql(statement)
      sql("COMMIT")
      log(f"{what}: done in {1000 * (time.monotonic() - start):.0f} ms (attempt {attempt})")
      return
    except DBAPIError as e:
      sql("ROLLBACK")
      if getattr(e.orig, 'pgcode', None) != '55P03':  # lock_not_available
        raise
      log(f"{what}: the table is busy, we try again ({attempt}/{LOCK_ATTEMPTS})")
      time.sleep(min(10, attempt) * random.uniform(0.5, 1))
  raise RuntimeError(f"Could not lock outputs for: {what}. Long queries or transactions hold it: see pg_stat_activity, then run the migration again: it resumes.")


def backfill():
  """Fills metrics_jsonb where it's NULL, BATCH_SIZE ids per transaction"""
  low, high = sql("SELECT min(id), max(id) FROM outputs").first()
  if low is None:
    return
  log(f"backfill of ids {low} to {high}, {BATCH_SIZE} per transaction")
  start = last_log = time.monotonic()
  updated = 0
  for batch_start in range(low, high + 1, BATCH_SIZE):
    updated += sql(
      "UPDATE outputs SET metrics_jsonb = qaboard_metrics_jsonb(metrics) "
      "WHERE id >= :start AND id < :end AND metrics_jsonb IS NULL",
      {"start": batch_start, "end": batch_start + BATCH_SIZE},
    ).rowcount
    if PAUSE:
      time.sleep(PAUSE)
    now = time.monotonic()
    if now - last_log > 10 or batch_start + BATCH_SIZE > high:
      last_log = now
      done = (batch_start + BATCH_SIZE - low) / (high + 1 - low)
      elapsed = now - start
      log(f"backfill: {min(done, 1):.0%}, {updated} rows in {elapsed:.0f}s, about {elapsed / done * (1 - done) if done < 1 else 0:.0f}s left")


def has_constraint():
  return sql("SELECT convalidated FROM pg_constraint WHERE conrelid = 'outputs'::regclass AND conname = :name", {"name": CONSTRAINT}).first()


def split_quoted(definition):
  """The parts of SQL outside and inside 'quotes', alternating"""
  return definition.split("'")


def on_column(definition, old, new):
  """An index definition from pg_get_indexdef, on another column (outside of string literals)"""
  parts = split_quoted(definition)
  return "'".join(re.sub(rf'\b{old}\b', new, part) if index % 2 == 0 else part for index, part in enumerate(parts))


def metrics_indexes():
  """The indexes that use the metrics column: dropping it drops them"""
  return sql("""
    SELECT DISTINCT i.relname, pg_get_indexdef(i.oid)
    FROM pg_depend d
    JOIN pg_class i ON i.oid = d.objid AND d.classid = 'pg_class'::regclass AND i.relkind = 'i'
    JOIN pg_attribute a ON a.attrelid = d.refobjid AND a.attnum = d.refobjsubid
    WHERE d.refclassid = 'pg_class'::regclass AND d.refobjid = 'outputs'::regclass AND a.attname = 'metrics'
  """).all()


def upgrade():
  if context.is_offline_mode():
    raise RuntimeError("This migration looks at the data: run it online")
  with op.get_context().autocommit_block():
    current = column_type('metrics')
    if current == 'jsonb':
      log("already jsonb, nothing to convert")
      default = sql("SELECT pg_get_expr(adbin, adrelid) FROM pg_attrdef JOIN pg_attribute ON attrelid = adrelid AND attnum = adnum "
                    "WHERE adrelid = 'outputs'::regclass AND attname = 'metrics'").scalar()
      statements = [JSON_TYPEOF_SHIM]
      if default != "'{}'::jsonb":
        statements.insert(0, "ALTER TABLE outputs ALTER COLUMN metrics SET DEFAULT '{}'::jsonb")
      in_short_transaction(statements, "default and json_typeof(jsonb)")
      # leftovers of an interrupted run
      sql(f"DROP FUNCTION IF EXISTS {TRIGGER}() CASCADE")
      sql("DROP FUNCTION IF EXISTS qaboard_metrics_jsonb(json)")
      return
    if current != 'json':
      raise RuntimeError(f"outputs.metrics is {current}, expected json or jsonb")
    if int(sql("SHOW server_version_num").scalar()) < 120000:
      log("WARNING: PostgreSQL < 12: SET NOT NULL will scan the table while it's locked")

    # 1. The new column, kept up to date by a trigger
    sql(CONVERT_FUNCTION)
    sql(TRIGGER_FUNCTION)
    in_short_transaction([
      "ALTER TABLE outputs ADD COLUMN IF NOT EXISTS metrics_jsonb jsonb",
      f"DROP TRIGGER IF EXISTS {TRIGGER} ON outputs",
      f"CREATE TRIGGER {TRIGGER} BEFORE INSERT OR UPDATE OF metrics ON outputs FOR EACH ROW EXECUTE FUNCTION {TRIGGER}()",
    ], "metrics_jsonb column and trigger")

    # 2. The existing rows
    backfill()

    # 3. NOT NULL, checked without blocking writes
    if not has_constraint():
      in_short_transaction([f"ALTER TABLE outputs ADD CONSTRAINT {CONSTRAINT} CHECK (metrics_jsonb IS NOT NULL) NOT VALID"], "NOT NULL check")
    if not has_constraint()[0]:
      start = time.monotonic()
      try:
        sql(f"ALTER TABLE outputs VALIDATE CONSTRAINT {CONSTRAINT}")
      except DBAPIError as e:
        if getattr(e.orig, 'pgcode', None) != '23514':  # check_violation: rows the backfill missed? Not expected
          raise
        log("some rows have no metrics_jsonb yet, we fill them")
        backfill()
        sql(f"ALTER TABLE outputs VALIDATE CONSTRAINT {CONSTRAINT}")
      log(f"NOT NULL check validated in {time.monotonic() - start:.1f}s")

    # The indexes on metrics, if admins added some (QA-Board has none): built again on the new column
    renames = []
    for name, definition in metrics_indexes():
      new_name = f"{name[:57]}_jsonb"
      log(f"index {name}: built again on the new column")
      sql(f'DROP INDEX CONCURRENTLY IF EXISTS "{new_name}"')  # maybe INVALID, from an interrupted run
      new_definition = on_column(definition, 'metrics', 'metrics_jsonb')
      new_definition = re.sub(r'^CREATE (UNIQUE )?INDEX \S+ ON', rf'CREATE \1INDEX CONCURRENTLY "{new_name}" ON', new_definition)
      sql(new_definition)
      renames.append(f'ALTER INDEX "{new_name}" RENAME TO "{name}"')

    # 4. The swap: catalog changes only, milliseconds once we have the lock
    in_short_transaction([
      "LOCK TABLE outputs IN ACCESS EXCLUSIVE MODE",
      "ALTER TABLE outputs ALTER COLUMN metrics_jsonb SET NOT NULL",
      f"DROP TRIGGER {TRIGGER} ON outputs",
      "ALTER TABLE outputs DROP COLUMN metrics",
      "ALTER TABLE outputs RENAME COLUMN metrics_jsonb TO metrics",
      "ALTER TABLE outputs ALTER COLUMN metrics SET DEFAULT '{}'::jsonb",
      f"ALTER TABLE outputs DROP CONSTRAINT {CONSTRAINT}",
      *renames,
      JSON_TYPEOF_SHIM,
    ], "swap of the columns")
    sql(f"DROP FUNCTION {TRIGGER}()")
    sql("DROP FUNCTION qaboard_metrics_jsonb(json)")
    # the planner knows nothing about the new column yet
    sql("ANALYZE outputs")
    log("done. The backfill left dead rows: autovacuum makes their space reusable")


def downgrade():
  # A plain ALTER: it rewrites the table under an ACCESS EXCLUSIVE lock, blocking runs and pages while it does
  # (about as long as the upgrade's backfill, see website/docs/backend-admin/upgrades.md).
  with op.get_context().autocommit_block():
    if column_type('metrics') == 'jsonb':
      sql("BEGIN")
      sql("ALTER TABLE outputs ALTER COLUMN metrics DROP DEFAULT")
      sql("ALTER TABLE outputs ALTER COLUMN metrics TYPE json USING metrics::json")
      sql("ALTER TABLE outputs ALTER COLUMN metrics SET DEFAULT '{}'::json")
      sql("DROP FUNCTION IF EXISTS json_typeof(jsonb)")
      sql("COMMIT")
