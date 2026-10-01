# Migration Guide: Branch Unification

This document covers breaking changes from the branch unification
(merging master-sirc, master-korea into a single master).

## For SIRC Users

### CLI
- After the regular install with: `pip install git+ssh://git@gitlab-srv/common-infrastructure/qaboard`
- Also install the site config:
```bash
    pip install --upgrade "qaboard-site-sirc @ git+ssh://git@gitlab-srv/common-infrastructure/qaboard#subdirectory=deployments/sirc/cli"
```
- This auto-configures API URL (https://qa), port (5000), secrets path (! we dont support it anymore as part of the project config)
- All existing ENV var overrides continue to work

### Server
- Deployed by GitLab CI (staging, then production). By hand: `deployments/deploy.py deployments/sirc/production.env up`,
  see `website/docs/backend-admin/deployment.mdx`

### Docker Builds
Proxy/cert configuration is no longer hardcoded in Dockerfiles. Instead, `sirc.yml`
passes build args automatically. **No action needed** — just rebuild as usual with
the SIRC overlay:
```bash
docker compose -f docker-compose.yml -f deployments/sirc/sirc.yml build
```
The overlay provides `PROXY_URL`, `CA_CERT_URL`, `NO_PROXY`, `GIT_SSL_VERIFY`,
`NODE_TLS_REJECT_UNAUTHORIZED`, and `QABOARD_EXTRA=sirc` as build args.

If you have custom certs in `services/cantaloupe/cert/`, those files are now
gitignored (only `.gitkeep` is tracked). Copy your certs back after cloning.
The SIRC/Samsung CA certificates that used to be committed there are now in `deployments/sirc/certs/`.

### Development
`development.yml` no longer hardcodes SIRC values. `source deployments/sirc/.envrc` sets them:
- `QABOARD_DEV_DB_HOST=qa`: the dev backend uses the production database (default: the `db` container)
- `QABOARD_DEV_USER="$(id -u):$(id -g)"`: user for the dev frontend container (default: root)
- `NODE_TLS_REJECT_UNAUTHORIZED=0` for the dev website

### Breaking Changes
- `--lsf-threads` renamed to `--lsf-max-threads` (already done on master-sirc)

## For DSK Users

### CLI
- After the regular install, also install the site config (the `qaboard[dsk]` extra does not exist):
```bash
pip install --upgrade "qaboard-site-dsk @ git+ssh://git@<your-git-server>/<your-qaboard-repo>#subdirectory=deployments/dsk/cli"
```
- This auto-configures API URL (https://qaboard.samsungds.net)

### Server
- Deploy with: `docker compose -f docker-compose.yml -f production.yml -f deployments/dsk/dsk.yml up`

### Docker Builds
Proxy/cert values are no longer hardcoded. Set `PROXY_URL`, `CA_CERT_URL`, and
`NO_PROXY` in your `.env` file or override them in `deployments/dsk/dsk.yml`.

### Configuration
- With SAML, set `QABOARD_SAML_DIR` (e.g. in `deployments/dsk/.env`) to a directory with `settings.json`
  and `advanced_settings.json`. DSK's settings are in `backend/backend/api/saml/`.
- The nginx config is now mounted as `conf.d/dsk.conf`: the overlay pointed to a non-existent `qaboard.conf`.
  `/iiif/cde` is commented out until the `iiif-cde` service is restored in `dsk.yml`, nginx fails to start without it.

### Breaking Changes
- DB migration required: `is_ldap`/`is_sso` booleans -> `login_type` string field
  Run: `alembic upgrade head`
- `--lsf-threads` renamed to `--lsf-max-threads`

## For Open-Source Users

No breaking changes. The default behavior is unchanged.
New features available: LDAP/SAML auth, LSF/celery runners, multiple
image servers -- all opt-in via ENV vars.

Optional site settings for the backend:
- `GITLAB_HOST`: also the fallback for git links in the UI (default: https://gitlab.com)
- `QABOARD_QUOTA_URL_TEMPLATE`: shows a "Quota" link, with `{user_name}` and `{project}` placeholders
- `QABOARD_SUPPORT_URL`: where users report bugs, can be a `mailto:` (default: GitHub issues)

Optional site settings for the CLI (env vars, or defaults from a site package):
- `QABOARD_UPGRADE_COMMAND`, `QABOARD_LATEST_VERSION_URL`: how we check for and suggest updates (default: PyPI)
- `QABOARD_IDB_BACKLOG_DIR` (SIRC only)

All Dockerfiles now build cleanly with no build args (proxy/cert blocks
are skipped when args are empty).
