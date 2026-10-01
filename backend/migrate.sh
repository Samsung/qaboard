#!/bin/bash
# Applies database migrations.
# It's safe to run concurrently on a single host: replicas sharing the /var/qaboard volume wait for each other.
# With replicas on several hosts (kubernetes), run it once before the rollout, and start the backend with QABOARD_RUN_MIGRATIONS=0.
set -ex
cd /qaboard/backend/backend
# FIXME: the baseline migration is empty, so on a fresh database `upgrade` fails and we fall back to `stamp`
#        (the tables are created by the app). See docs/known-issues.md
flock /var/qaboard/.migrations.lock bash -c 'alembic upgrade head || alembic downgrade head || alembic stamp head'
