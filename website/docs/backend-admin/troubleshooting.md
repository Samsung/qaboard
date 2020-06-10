---
id: troubleshooting
sidebar_label: Troubleshooting
title: Troubleshooting common issues
---
Assuming you work on the QA-Board server:
```bash
ssh qaboard-server
```

## Talking to the different services
You can interact with the individual services with e.g.

```bash
# read logs from a specific service
docker-compose logs -f backend

# you can get a shell on the various services:
docker-compose exec backend bash
docker-compose run proxy /bin/ash
# or with the docker-compose conventions, if the service is up:
docker exec -it qaboard_proxy_1 bash
```

> Refer to the examples in *[docker-compose.yml](docker-compose.yml)* or to the `docker-compose` docs.

## Questions to ask if things don't work
- Is the container even running ? Is it restarting all the time?
```bash
docker ps
```
- Is the disk full?
```bash
df -h
```

## How to restart the docker containers
Symptom:
- Cannot load the web application
- 500 errors
- Often necessary if the disk got full..

```bash
docker-compose -f docker-compose.yml -f production.yml restart
# if you make changes to the docker-compose files...
docker-compose -f docker-compose.yml -f production.yml up -d
```

### How to start from scratch the docker container
```bash
docker-compose -f docker-compose.yml -f production.yml down
docker-compose -f docker-compose.yml -f production.yml up -d
```

### Quick wins when the disk is full
Symptom:
- 500 errors
- database unreachable in the logs
- `no space left on device` in the logs

Remove the IIIF image cache:
```bash
# stop
docker-compose -f docker-compose.yml -f production.yml down cantaloupe
# remove with the volumes
docker-compose -f docker-compose.yml -f production.yml rm -v cantaloupe
docker-compose -f docker-compose.yml -f production.yml up -d cantaloupe
```

Remove unused docker images
```bash
docker image prune # -a
```

### Re-build and start the docker container
```bash
docker-compose -f docker-compose.yml -f production.yml up -d --build
# you can rebuild a subset of the services: backend, frontend...
```
