---
id: troubleshooting
sidebar_label: Troubleshooting
title: Troubleshooting common issues
---
Assuming you work on the QA-Board server:
```bash
ssh qa
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



## Quesions to ask if things don't work
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
# At SIRC we need to make sure important folders are mounted before starting containers...
./at-sirc-before-up.py

docker-compose -f docker-compose.yml -f production.yml  -f sirc.yml restart
# if you make changes to the docker-compose files...
docker-compose -f docker-compose.yml -f production.yml  -f sirc.yml up -d

```

### How to start from scratch the docker container
```bash
# At SIRC we need to make sure important folders are mounted before starting containers...
./at-sirc-before-up.py

docker-compose -f docker-compose.yml -f production.yml  -f sirc.yml down
docker-compose -f docker-compose.yml -f production.yml  -f sirc.yml up -d
```

### Quick wins when the disk is full
Symptom:
- 500 errors
- database unreachable in the logs
- `no space left on device` in the logs

Remove the IIIF image cache:
```bash
# stop
docker-compose -f docker-compose.yml -f production.yml  -f sirc.yml stop cantaloupe
# remove with the volumes
docker-compose -f docker-compose.yml -f production.yml  -f sirc.yml rm -v cantaloupe

# At SIRC we need to make sure important folders are mounted before starting containers...
./at-sirc-before-up.py

# Restart
docker-compose -f docker-compose.yml -f production.yml  -f sirc.yml up -d cantaloupe
```

Remove unused docker images
```bash
docker image prune # -a
```

### Re-build and start the docker container
```bash
# At SIRC we need to make sure important folders are mounted before starting containers...
./at-sirc-before-up.py

docker-compose -f docker-compose.yml -f production.yml  -f sirc.yml up -d --build
# you can rebuild a subset of the services: backend, frontend...
```
