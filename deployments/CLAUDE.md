# deployments/CLAUDE.md
Deploying the server: compose env files, `deploy.py`, site overlays (`sirc/`, `dsk/`), and the Helm chart in
`charts/qaboard/` (`charts/CLAUDE.md`). Generic server docs: `website/docs/backend-admin/`; what's still
site-specific: `docs/known-issues.md`; limits: `docs/warts.md` (Deployments, services, charts).

## Compose
```bash
# Zero-downtime deploys, one env file per environment (compose files, project, replicas, QABOARD_IMAGE...)
deployments/deploy.py deployments/production.env up [--version X] [--build] [--init]
deployments/deploy.py <env file> status|rollback|restore-db|seed-db|compose ...
docker compose --env-file deployments/sirc/production.env ps
```
- `production.env` is the generic single-host deployment (CI deploys it in its `docker` job); `example.yml` a site
  overlay to copy; `quickstart/compose.yml` the laptop quickstart.
- **SIRC dev stack**: `source deployments/sirc/.envrc` and `./at-sirc-before-up.py` (proxies, dev settings, mounts),
  then `docker compose -f docker-compose.yml -f development.yml -f deployments/sirc/sirc.yml up -d`.
  SIRC environments: `sirc/production.env`, `sirc/staging.env`; Helm values: `sirc/values.yaml`.
- GitLab CI (`.gitlab-ci.yml`) deploys master to staging, then production, automatically.
- Runbooks (internal, per site): `deployments/<site>/runbooks/` (SIRC: `sirc/runbooks/README.md`). Never in `website/`.

## Images
GitHub CI publishes the images to `ghcr.io/<owner>/qaboard`, tagged `<service>-<sha8>` on master, `<service>` once
every job passed, `<service>-<version>` for releases; and the chart to `oci://ghcr.io/<owner>/charts/qaboard`.
Compose and the chart default to `ghcr.io/samsung/qaboard`; `QABOARD_IMAGE` / `image.repository` override it.
