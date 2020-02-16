#!/bin/sh
set -e

# ssh qa
# crontab -e
# 0 5 * * * ssh qa /home/arthurf/qaboard/backend/deployment/create-backup.sh

# Assuming you have a .pgpass ...
# It should be guessed by postgreSQL anyway
export PGPASSFILE=$HOME/.pgpass

# FIXME: use a configurable location, at a standard path...
BACKUP_DIR=/home/ispq/qaboard/database_backups
backup=$BACKUP_DIR/$(date --rfc-3339=date).dump
connect="--username=qaboard --no-password -h localhost --dbname=qaboard"

pg_dump $connect -Fc > $backup


