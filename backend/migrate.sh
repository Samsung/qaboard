#!/bin/bash
# Applies database migrations, and fails if they fail: deployments/deploy.py and the helm chart's Job then stop the
# deploy before changing anything, and the backend doesn't start on a database it doesn't match.
# It's safe to run concurrently on a single host: replicas sharing the /var/qaboard volume wait for each other.
# With replicas on several hosts (kubernetes), run it once before the rollout, and start the backend with QABOARD_RUN_MIGRATIONS=0.
set -ex -o pipefail
cd /qaboard/backend/backend
exec 9>/var/qaboard/.migrations.lock
flock 9

# After a rollback, the database may have migrations from a newer version that this one does not know.
# They are additive: we keep them, this version works with them. To undo them, see the "Rollbacks" runbook.
if ! alembic current > /tmp/alembic-current.log 2>&1; then
  if grep -q "Can.t locate revision" /tmp/alembic-current.log; then
    echo "WARNING: the database was migrated by a newer version of QA-Board, we keep its migrations: $(grep -o "revision identified by .*" /tmp/alembic-current.log)"
    exit 0
  fi
  cat /tmp/alembic-current.log
  exit 1
fi

if grep -Eq '^[0-9a-f]{12}' /tmp/alembic-current.log; then
  alembic upgrade head
  exit 0
fi

# No version. The app creates the tables it's missing when it's imported (Base.metadata.create_all), alembic's env.py
# included: a new database has them all, at the latest version. The baseline migration is empty: we can't upgrade from it.
# A database with data but no version is one we know nothing about: we don't guess.
state=$(python - <<'PYTHON' | tail -n 1
import sqlalchemy as sa
from backend.database import engine
with engine.connect() as connection:
  inspector = sa.inspect(connection)
  def has_rows(table):
    return inspector.has_table(table) and connection.execute(sa.text(f"SELECT 1 FROM {table} LIMIT 1")).first() is not None
  print("data" if has_rows("projects") or has_rows("batches") else "new")
PYTHON
)
if [ "$state" != "new" ]; then
  echo "ERROR: the database has data but no migration version (alembic_version is empty)."
  echo "Find the latest migration it has, then: alembic stamp <revision> && alembic upgrade head"
  exit 1
fi
alembic stamp head
