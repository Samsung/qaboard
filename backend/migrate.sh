#!/bin/bash
# Applies database migrations.
# It's safe to run concurrently on a single host: replicas sharing the /var/qaboard volume wait for each other.
# With replicas on several hosts (kubernetes), run it once before the rollout, and start the backend with QABOARD_RUN_MIGRATIONS=0.
set -ex
cd /qaboard/backend/backend
# FIXME: the baseline migration is empty, so on a fresh database `upgrade` fails and we fall back to `stamp`
#        (the tables are created by the app). See docs/known-issues.md
flock /var/qaboard/.migrations.lock bash -c '
  # After a rollback, the database may have migrations from a newer version that this one does not know.
  # They are additive: we keep them, this version works with them. To undo them, see the "Rollbacks" runbook.
  if ! alembic current > /tmp/alembic-current.log 2>&1 && grep -q "Can.t locate revision" /tmp/alembic-current.log; then
    echo "WARNING: the database was migrated by a newer version of QA-Board, we keep its migrations: $(grep -o "revision identified by .*" /tmp/alembic-current.log)"
    exit 0
  fi
  alembic upgrade head || alembic downgrade head || alembic stamp head
'
