# Troubleshooting common issues (SIRC)

SIRC's runbook. The generic version is on the docs website:
[Troubleshooting](https://samsung.github.io/qaboard/docs/backend-admin/troubleshooting)
(source: `website/docs/backend-admin/troubleshooting.mdx`).

Assuming you work on the QA-Board server:
```bash
ssh qa
cd /home/ispq/qaboard_prod
source deployments/sirc/.envrc
```

The examples use SIRC's production environment, `deployments/sirc/production.env`. It tells docker compose which compose files and project to use. For other environments, see [Deployments](deployment.md).

## Talking to the different services
```bash
# status: deployed version, containers and their health
deployments/deploy.py deployments/sirc/production.env status

# read logs from a specific service
deployments/deploy.py deployments/sirc/production.env compose logs -f --tail 100 backend

# get a shell in a service
deployments/deploy.py deployments/sirc/production.env compose exec backend bash
# check the backend directly, without nginx
deployments/deploy.py deployments/sirc/production.env compose exec backend wget -qO- localhost:3001/api/v1/health
```

`deploy.py ... compose` is `docker compose --env-file ...` with the images of the deployed version. Plain `docker compose --env-file deployments/sirc/production.env ...` works for anything that doesn't (re)create containers.

> **Tip**: the backend runs several replicas. `compose exec`/`logs` pick one; add `--index N` for another. With old docker compose versions, `exec` can complain that "container #1" is not running after a deploy: use `--index` with the numbers from `docker compose ps`.

## Questions to ask if things don't work
- Is the container even running? Is it restarting all the time? Is it unhealthy?
```bash
docker compose --env-file deployments/sirc/production.env ps -a
```
- Is the disk full?
```bash
df -h
```
- Did a deploy just happen? Check the GitLab environments page (see [Rollbacks](deployment.md#rollbacks)), and roll back if needed.

## How to restart the containers
Symptom:
- Cannot load the web application
- 500 errors
- Often necessary if the disk got full...

```bash
# At SIRC we need to make sure important folders are mounted before starting containers...
./at-sirc-before-up.py
docker compose --env-file deployments/sirc/production.env restart backend
# or everything (downtime!)
docker compose --env-file deployments/sirc/production.env restart
```

### After a restart of docker or of the host
Docker starts the containers itself, all at once: compose's `depends_on` order doesn't apply. And docker **never
retries a container that failed to start**: restart policies only apply to containers that exited after they started.
Symptom: the proxy restarts in a loop (`host not found in upstream "backend:3000"` in `compose logs proxy`): nginx
doesn't start while a name it proxies to doesn't resolve, and docker's DNS only knows the running containers. The proxy
itself recovers within a minute of the backend being up: if it doesn't, the backend didn't start. Why:
```bash
docker compose --env-file deployments/sirc/production.env ps -a
# why a container that is not running didn't start, e.g. "failed to initialize logging driver" (fluentd, see prod.yml)
docker inspect -f '{{.Name}} {{.State.Status}} {{.State.Error}}' $(docker ps -aq --filter label=com.docker.compose.project=qaboard_prod)
journalctl -u docker --since "1 hour ago" | grep -i "failed to start"
```
Then start everything again, in order:
```bash
./at-sirc-before-up.py
deployments/deploy.py deployments/sirc/production.env up
```

### How to recreate all the containers
```bash
# Redeploys the current version: only what changed is recreated, the backend without downtime
deployments/deploy.py deployments/sirc/production.env up
# From scratch (downtime!). Never add --volumes/-v: it deletes the database
docker compose --env-file deployments/sirc/production.env down
deployments/deploy.py deployments/sirc/production.env up
```

### Quick wins when the disk is full
Symptom:
- 500 errors
- database unreachable in the logs
- `no space left on device` in the logs

Remove the IIIF image cache:
```bash
docker compose --env-file deployments/sirc/production.env stop cantaloupe
docker compose --env-file deployments/sirc/production.env rm -v cantaloupe
./at-sirc-before-up.py
deployments/deploy.py deployments/sirc/production.env compose up -d cantaloupe
```

Remove unused docker images (`deploy.py` already removes the images of old versions, it keeps the last 3):
```bash
docker image prune # -a
```

### Re-build and start the containers
Normally CI builds the images. To build and deploy on the host:
```bash
deployments/deploy.py deployments/sirc/production.env up --build
```
