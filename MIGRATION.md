# Migration Guide: Branch Unification

This document covers breaking changes from the branch unification
(merging master-sirc, master-korea into a single master).

## For SIRC Users

### CLI
- Install with: `pip install qaboard[sirc]` (was: `pip install qaboard`)
- This auto-configures API URL (https://qa), port (5000), secrets path (! we dont support it anymore as part of the project config)
- All existing ENV var overrides continue to work

### Server
- Deploy with: `docker compose -f docker-compose.yml -f production.yml -f deployments/sirc.yml up`
- The `sirc.yml` file moved from repo root to `deployments/sirc.yml`

### Docker Builds
Proxy/cert configuration is no longer hardcoded in Dockerfiles. Instead, `sirc.yml`
passes build args automatically. **No action needed** — just rebuild as usual with
the SIRC overlay:
```bash
docker compose -f docker-compose.yml -f deployments/sirc.yml build
```
The overlay provides `PROXY_URL`, `CA_CERT_URL`, `NO_PROXY`, `GIT_SSL_VERIFY`,
`NODE_TLS_REJECT_UNAUTHORIZED`, and `QABOARD_EXTRA=sirc` as build args.

If you have custom certs in `services/cantaloupe/cert/`, those files are now
gitignored (only `.gitkeep` is tracked). Copy your certs back after cloning.

### Breaking Changes
- `on_vdi`/`on_lsf` host detection removed. Replaced by qaboard[sirc] package.
- `--lsf-threads` renamed to `--lsf-max-threads` (already done on master-sirc)

## For DSK Users

### CLI
- Install with: `pip install qaboard[dsk]` (was: `pip install qaboard`)
- This auto-configures API URL (https://qaboard.samsungds.net)

### Server
- Deploy with: `docker compose -f docker-compose.yml -f production.yml -f deployments/dsk.yml up`

### Docker Builds
Proxy/cert values are no longer hardcoded. Set `PROXY_URL`, `CA_CERT_URL`, and
`NO_PROXY` in your `.env` file or override them in `deployments/dsk.yml`.

### Breaking Changes
- DB migration required: `is_ldap`/`is_sso` booleans -> `login_type` string field
  Run: `alembic upgrade head`
- `--lsf-threads` renamed to `--lsf-max-threads`

## For Open-Source Users

No breaking changes. The default behavior is unchanged.
New features available: LDAP/SAML auth, LSF/celery runners, multiple
image servers -- all opt-in via ENV vars.

All Dockerfiles now build cleanly with no build args (proxy/cert blocks
are skipped when args are empty).
