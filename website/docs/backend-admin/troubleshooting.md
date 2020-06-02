---
id: troubleshooting
sidebar_label: Troubleshooting
title: Troubleshooting common issues
---
## How to get logs from QA-Board's backend
```bash
docker-compose logs -f backend
# you can also log other services: proxy/cantaloupe/...

# is the container even running ? restarting all the time
docker ps
# get a shell
docker-compose exec backend bash
```


## Restart the docker containers
Symptom:
- Cannot load the web application
- 500 errors
- Often necessary if the disk got full..

```bash
docker-compose -f docker-compose.yml -f production.yml restart
# if you make changes to the docker-compose files...
docker-compose -f docker-compose.yml -f production.yml up -d
```

### Start from scratch the docker container
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
docker image prune
```

### Re-build and start the docker container
```bash
docker-compose -f docker-compose.yml -f production.yml up -d --build
# you can rebuild a subset of the services: backend, frontend...
```
