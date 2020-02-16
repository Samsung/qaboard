---
id: troubleshooting
sidebar_label: Troubleshooting
title: Troubleshooting common issues
---

Assuming you work on the QA-Board host:
```bash
ssh qa
```

### How to get logs from QA-Board's backend
```bash
docker logs  -f --since 5m qaboard-production

# is the container even running ? restarting all the time
docker ps

# docker exec -it qaboard-production bash
```

### How to restart nginx if the server reboots
Symptom:
- In case of timeouts when `qa run/batch` tries to contact the server (at `http://qa:5000`).

```bash
sudo service nginx start
                 # status
                 # restart
```

### Restart the docker container
Symptom:
- Issues accession pages at `https://qa/`
- 500 errors
- Often necessary of the disk gets full

```bash
docker restart qaboard-production
             ## and the image server...
             # qaboard_iiif_cantaloupe-production
<<<<<<< HEAD
=======
             # qaboard_iip_cde-production
>>>>>>> 4a39c1f... Renamed backend.slamvizapp to backend.backend
```



### Start from scratch the docker container
```bash
docker stop qaboard-production
docker rm qaboard-production
# ! it's arthurf's dev workspace, UNSTABLE
#   do your own clone...!
<<<<<<< HEAD
CI_ENVIRONMENT_SLUG=production qaboard/qaboard-backend/deployment/start-docker.sh
=======
CI_ENVIRONMENT_SLUG=production /home/arthurf/common-infrastructure/qaboard/backend/deployment/start-docker.sh
>>>>>>> 4a39c1f... Renamed backend.slamvizapp to backend.backend
```


### What to do when the disk space is full
Symptom:
- 500 errors
- database unreachable in the logs
- "no space left on device" in the logs

Remove the image cache:
```bash
<<<<<<< HEAD
docker stop qaboard_iiif_cantaloupe-production && \
docker rm qaboard_iiif_cantaloupe-production && \
docker volume rm cache_cantaloupe && \
# restart the image server
docker run --name qaboard_iiif_cantaloupe-production -p 8182:8182 -v cache_cantaloupe:/var/cache/cantaloupe -v /:/repository -v /srv/cantaloupe:/srv/cantaloupe --detach --restart always -it cantaloupe
=======
docker stop backend_iiif_cantaloupe-production && \
docker rm backend_iiif_cantaloupe-production && \
docker volume rm cache_cantaloupe && \
# restart the image server
docker run --name backend_iiif_cantaloupe-production -p 8182:8182 -v cache_cantaloupe:/var/cache/cantaloupe -v /opt/dockermounts/stage/algo_data:/repository -v /srv/cantaloupe:/srv/cantaloupe --detach --restart always -it cantaloupe
>>>>>>> 4a39c1f... Renamed backend.slamvizapp to backend.backend

# you'll also likely need to restart the container
```

Remove unused docker images
```bash
docker image prune
```

### Re-build and start the docker container
```bash
cd webapp && \
# build the frontend
npm run build && \
# keep old JS bundles not to break users currently using the app
rsync -r build deployed_build && \
cd .. && \
# re-build the container
<<<<<<< HEAD
docker build -t qaboard:production . && \
=======
docker build -t gitlab-srv.transchip.com:4567/common-infrastructure/qaboard:production . && \
>>>>>>> 4a39c1f... Renamed backend.slamvizapp to backend.backend
docker stop qaboard-production && \
docker rm qaboard-production && \
CI_ENVIRONMENT_SLUG=production ~/common-infrastructure/qaboard/backend/deployment/start-docker.sh
```
