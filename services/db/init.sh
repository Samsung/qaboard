#!/bin/bash
if [[ ! -f /var/lib/postgresql/data/PG_VERSION ]]; then
    # fresh cluster: let the postgres entrypoint initdb + start.
    # $@ is empty on `docker compose up`; default to "postgres" so it starts.
    if [[ $# -eq 0 ]]; then
        exec docker-entrypoint.sh postgres
    fi
    exec docker-entrypoint.sh "$@"
fi
# already initialized: apply custom config and start
cp /postgres.host.conf /var/lib/postgresql/data/postgres.conf
chown postgres /var/lib/postgresql/data/postgres.conf
exec docker-entrypoint.sh postgres "$@"