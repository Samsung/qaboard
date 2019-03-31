#!/bin/sh
set -e

# ssh arthurf@arthurf-vdi
# crontab -e
#
# 0 5 * * * ssh planet31 /home/arthurf/dvs/slamvizapp/deployment/create-backup.sh
# Note: there is postgresql9.6 on planet31, same version as used by the app.



# It should be guessed by postgreSQL anyway
export PGPASSFILE=/home/arthurf/.pgpass

BACKUP_DIR=/home/arthurf/dvs/slamvizapp/data/backups
backup=$BACKUP_DIR/$(date --rfc-3339=date).dump
connect="--username=ci --no-password -h localhost --dbname=slamvizapp"

pg_dump $connect -Fc > $backup


