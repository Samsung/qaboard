# SIRC runbooks

Internal runbooks for the QA-Board instances run at SIRC, with their hosts, paths and CI.
They used to be pages of the public docs website. The website now only has the generic docs:

- [Starting a QA-Board server](https://samsung.github.io/qaboard/docs/deploy) (`website/docs/start-server.mdx`)
- [Deployments, rollbacks and high availability](https://samsung.github.io/qaboard/docs/backend-admin/deployment) (`website/docs/backend-admin/deployment.mdx`)
- [Troubleshooting](https://samsung.github.io/qaboard/docs/backend-admin/troubleshooting) (`website/docs/backend-admin/troubleshooting.mdx`)
- [Kubernetes](https://samsung.github.io/qaboard/docs/backend-admin/kubernetes) (`website/docs/backend-admin/kubernetes.mdx`)

| Runbook | What for |
|---------|----------|
| [deployment.md](deployment.md) | Environments (production on `qa`, staging on `alginfra1`), GitLab CI deploys, rollbacks, staging data, backups, first-time host setup |
| [database.md](database.md) | PostgreSQL settings (`services/db/qaboard.conf`), applying them (restart), slow queries, backup retention |
| [troubleshooting.md](troubleshooting.md) | Logs, shells, restarts, disk full |
| [host-upgrades.md](host-upgrades.md) | Maintenance of the `qa` host: pause deploys, backup, restart, checks |
| [ssl-certificates.md](ssl-certificates.md) | Getting the HTTPS certificate from IT |

Keep them in sync with the generic pages: when a change is not SIRC-specific, document it on the website too.

## Installing the client at SIRC
```bash
pip install --upgrade git+ssh://git@gitlab-srv/common-infrastructure/qaboard
pip install --upgrade 'qaboard-site-sirc @ git+ssh://git@gitlab-srv/common-infrastructure/qaboard#subdirectory=deployments/sirc/cli'
```

The site package (`deployments/sirc/cli`) configures the API URL and other defaults. It also sets
`QABOARD_SITE_CONFIG` to its `qaboard_site_sirc/qaboard.yaml`: the defaults of every project's `qaboard.yaml`
(see [site defaults](https://samsung.github.io/qaboard/docs/project-init#site-defaults)).

## Deploying the server at SIRC
Deployed by GitLab CI, see [deployment.md](deployment.md). By hand:
```bash
deployments/deploy.py deployments/sirc/production.env up
```

The database backups are written to `/home/ispq/qaboard_data_prod/database_backups`, mounted at `/backups` in
`deployments/sirc/prod.yml`.

## DSK
DSK runs its own instance, with the overlay `deployments/dsk/dsk.yml` and the site package `deployments/dsk/cli`.

Installing the client:
```bash
pip install --upgrade qaboard
# use the URL of the QA-Board repository you have access to (there is no `qaboard[dsk]` extra)
pip install --upgrade 'qaboard-site-dsk @ git+ssh://git@<your-git-server>/<your-qaboard-repo>#subdirectory=deployments/dsk/cli'
```

Starting the server:
```bash
docker compose -f docker-compose.yml -f production.yml -f deployments/dsk/dsk.yml up -d
```

To build the DSK instructions for users (`website/site-docs/dsk/`) into the web app's docs, set `QABOARD_SITE=dsk`
in `.env` (or the shell) before building the images. SIRC's env files set `QABOARD_SITE=sirc`.
