#!/bin/bash
# Entrypoint of the db service (see deployments/sirc/sirc.yml): starts PostgreSQL with the official image's
# entrypoint, with QA-Board's settings: $QABOARD_DB_CONFIG, by default qaboard.conf next to this script
# (services/db/ is mounted at /opt in docker-compose.yml, so: `entrypoint: /opt/init.sh`).
#
# PostgreSQL reads $PGDATA/postgresql.conf. We copy our file next to it, as $PGDATA/qaboard.conf, and append once
#   include_if_exists = 'qaboard.conf'
# at its end, so our values win over the ones above. ($PGDATA/postgresql.auto.conf, from ALTER SYSTEM, still wins.)
# - Existing cluster: done now, at every start, so a restart picks up changes to the file.
# - QABOARD_DB_CONFIG=none removes the include line and the copy: back to the settings of postgresql.conf.
# - New cluster: $PGDATA is empty until the official entrypoint runs initdb. We give it a script in
#   /docker-entrypoint-initdb.d/ that calls us back after initdb (as postgres): it applies the config and creates the
#   pg_stat_statements extension. The entrypoint then restarts PostgreSQL, which reads the config.
#
# Why a wrapper: the copy must be owned by postgres, and we cannot chown the mounted file on our shared storage. The
# official entrypoint only initializes the database and switches from root to postgres if the command starts with
# "postgres", so we can't simply change the command. Nothing here depends on the PostgreSQL version or on where
# $PGDATA is (the postgres:18 image moved it to /var/lib/postgresql/18/docker).
set -euo pipefail

SELF=$(readlink -f "${BASH_SOURCE[0]}")
CONFIG_SOURCE=${QABOARD_DB_CONFIG:-$(dirname "$SELF")/qaboard.conf}
INCLUDE_LINE="include_if_exists = 'qaboard.conf'"
INITDB_HOOK=/docker-entrypoint-initdb.d/qaboard.sh

as_postgres() {
  if [ "$(id -u)" = 0 ]; then
    gosu postgres "$@"
  else
    "$@"
  fi
}

remove_config() {
  # Back to postgresql.conf's settings: QABOARD_DB_CONFIG=none (e.g. if PostgreSQL doesn't start with ours)
  if grep -qxF "$INCLUDE_LINE" "$PGDATA/postgresql.conf"; then
    as_postgres sed -i -e '/^# QA-Board settings, from services\/db\/qaboard.conf/d' -e "/^include_if_exists = 'qaboard.conf'\$/d" \
      "$PGDATA/postgresql.conf" || return 1
  fi
  as_postgres rm -f "$PGDATA/qaboard.conf" || return 1
  echo "[init.sh] QABOARD_DB_CONFIG=none: removed qaboard.conf from $PGDATA/postgresql.conf"
}

apply_config() {
  if [ "$CONFIG_SOURCE" = none ]; then
    remove_config
    return
  fi
  if [ ! -f "$CONFIG_SOURCE" ]; then
    echo "[init.sh] WARNING: $CONFIG_SOURCE doesn't exist, PostgreSQL starts with its default settings" >&2
    return 0
  fi
  # Read by us (maybe root, squashed on NFS: the file only needs to be world-readable), written by postgres.
  # Written then renamed: PostgreSQL never reads a half-written file.
  as_postgres sh -c 'cat > "$1.tmp" && mv "$1.tmp" "$1"' _ "$PGDATA/qaboard.conf" < "$CONFIG_SOURCE" || return 1
  if ! grep -qxF "$INCLUDE_LINE" "$PGDATA/postgresql.conf"; then
    printf '\n# QA-Board settings, from services/db/qaboard.conf (added by services/db/init.sh)\n%s\n' "$INCLUDE_LINE" \
      | as_postgres tee -a "$PGDATA/postgresql.conf" > /dev/null || return 1
  fi
  echo "[init.sh] $PGDATA/postgresql.conf includes qaboard.conf (copied from $CONFIG_SOURCE)"
}

if [ "${1:-}" = "--initdb" ]; then
  # Called back by the official entrypoint after initdb, as postgres, with a temporary server listening on a socket
  apply_config
  psql -v ON_ERROR_STOP=1 --username "${POSTGRES_USER:-postgres}" --dbname "${POSTGRES_DB:-${POSTGRES_USER:-postgres}}" \
    -c 'CREATE EXTENSION IF NOT EXISTS pg_stat_statements;'
  exit 0
fi

# Like the official entrypoint: no command, or only options, means "postgres". With `entrypoint:` in compose,
# the image's default command ("postgres") is not passed.
if [ $# -eq 0 ] || [ "${1:0:1}" = "-" ]; then
  set -- postgres "$@"
fi

if [ -s "$PGDATA/PG_VERSION" ]; then
  # Never prevent the database from starting: at worst it starts with the settings it had before
  apply_config || echo "[init.sh] WARNING: could not apply $CONFIG_SOURCE, PostgreSQL starts with its previous settings" >&2
else
  # Only runs if the entrypoint initializes a new cluster. With bash: the mounted script may not be executable by postgres.
  if ! { printf '#!/bin/bash\nexec bash %q --initdb\n' "$SELF" > "$INITDB_HOOK" && chmod 755 "$INITDB_HOOK"; } 2> /dev/null; then
    echo "[init.sh] WARNING: could not write $INITDB_HOOK: the new cluster starts without qaboard.conf until the next restart" >&2
  fi
fi

exec docker-entrypoint.sh "$@"
