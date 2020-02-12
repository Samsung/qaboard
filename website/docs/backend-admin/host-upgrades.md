---
id: host-upgrades
sidebar_label: Host Upgrades
title: Upgrading the QA-Board host
---

# Connect to the host
```bash
ssh qa
```

## Check and save the latest daily backup
```bash
ls -lh /home/ispq/qaboard/database_backups/2020-01-07.dump
cp /home/ispq/qaboard/database_backups/2020-01-07.dump .
```

## To make the recovery easier
```
# docker login docker-registry
docker push docker-registry:qaboard:production
```

## Stop the server and create a backup 
```bash
docker stop qaboard-production
qaboard/qaboard-backend/deployment/create-backup.sh
```

## MAINTENANCE
> Storage/CPU upgrade...

## RECOVER
**Check nginx is live**
```bash
sudo server nginx status
sudo server nginx start # reload
```

If not:
- check it's installed
- check it has the config under deployment/nginx

**Check** the docker container is started

If not:
```bash
# if no images...
# docker pull docker-registry/qaboard:production
CI_ENVIRONMENT_SLUG=production qaboard/qaboard-backend/deployment/start-docker.sh
```

**Check** the database works. In case of issues, Recover from a backup: https://github.com/Samsung/qaboard/tree/master/qaboard-backend#recovery
```bash
docker restart qaboard-production
```
#### 4. RESTART
ssh planet31

#### ABORT ###################
**Check** the docker container is started
