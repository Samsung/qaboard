#!/bin/bash
cp /postgres.host.conf /var/lib/postgresql/data/postgres.conf
chown postgres /var/lib/postgresql/data/postgres.conf

if [[ $# -eq 0 ]] ; then
    exec docker-entrypoint.sh postgres 
fi
exec docker-entrypoint.sh "$@"
