#!/bin/sh
set -e

# ssh ispq@ispq-vdi
# crontab -e
# 0 5 * * * ssh qa /home/arthurf/qaboard/deployment/create-backup.sh

# It should be guessed by postgreSQL anyway
export PGPASSFILE=$HOME/.pgpass

BACKUP_DIR=/home/ispq/qaboard/database_backups
backup=$BACKUP_DIR/$(date --rfc-3339=date).dump
connect="--username=ci --no-password -h localhost --dbname=slamvizapp"

pg_dump $connect -Fc > $backup


