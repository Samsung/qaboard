---
id: host-upgrades
sidebar_label: Host Upgrades
title: Upgrading the QA-Board host
---

First connect to the QA-Board host:
```bash
ssh qa
```

## Check and save the latest daily backup
```bash
# FIXME: update with docker-compose
ls -lh /home/ispq/qaboard/database_backups/2020-01-07.dump
cp /home/ispq/qaboard/database_backups/2020-01-07.dump .
```

## Stop the server and create a backup 
```bash
# disconnect clients to avoid anyone writing
docker-compose -f docker-compose.yml -f production.yml stop
# we need the database to create a backup
docker-compose -f docker-compose.yml -f production.yml up -d db

# FIXME: update with docker-compose
qaboard/backend/deployment/create-backup.sh
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

> In case of issues, recover from a backup: https://github.com/Samsung/qaboard/tree/master/backend#recovery
