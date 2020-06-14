---
id: host-upgrades
sidebar_label: Host Upgrades
title: Upgrading the QA-Board host
---

First connect to the QA-Board host:
```bash
ssh qa
```

## Make sure backups are enabled
In *production.yml* you should uncomment the `cron-backup-db` service to enable daily backups, and replace `/WHERE/TO/SAVE/BACKUPS` with a (backup'ed!)location on the host.

## Check the latest daily backup
```bash
# check the latest backup worked
ls -lht /WHERE/BACKUPS/ARE/SAVED/ | head
# copy the latest somewhere to make sure nothing can go wrong
cp /WHERE/BACKUPS/ARE/SAVED/latest.dump .

```

## Stop the server and create a backup 
```bash
# disconnect clients to avoid anyone writing
docker-compose -f docker-compose.yml -f production.yml stop
# we need the database to create a backup
docker-compose -f docker-compose.yml -f production.yml up -d db

# manually start a backup
docker-compose -f docker-compose.yml -f production.yml run cron-backup-db /etc/periodic/daily/backup before-upgrade.dump
```

## Maintenance Period
> CPU/Memory/Storage upgrade...

## Restart
After the boot, make sure everything is up:
```bash
docker-compose -f docker-compose.yml -f production.yml up -d
```

**Checks**:
- [ ] you can access the web application
- [ ] the logs are all right
- [ ] the logs are all right


## Restoring from a backup
In case of issues, recover from a backup:

```bash
# disconnect clients
docker-compose -f docker-compose.yml -f production.yml stop
# we need the database to create a backup
docker-compose -f docker-compose.yml -f production.yml up -d db

# now restore
docker-compose -f docker-compose.yml -f production.yml exec db /opt/restore /backups/before-upgrade.dump

# and restart
docker-compose -f docker-compose.yml -f production.yml up -d
```