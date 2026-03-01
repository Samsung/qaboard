# Migration Guide: Branch Unification

This document covers breaking changes from the branch unification
(merging master-sirc, master-korea into a single master).

## For SIRC Users

### CLI
- Install with: `pip install qaboard[sirc]` (was: `pip install qaboard`)
- This auto-configures API URL (https://qa), port (5000), secrets path
- All existing ENV var overrides continue to work

### Server
- Deploy with: `docker compose -f docker-compose.yml -f production.yml -f deployments/sirc.yml up`
- The `sirc.yml` file moved from repo root to `deployments/sirc.yml`

### Breaking Changes
- `on_vdi`/`on_lsf` host detection removed. Replaced by qaboard[sirc] package.
- `--lsf-threads` renamed to `--lsf-max-threads` (already done on master-sirc)

## For DSK Users

### CLI
- Install with: `pip install qaboard[dsk]` (was: `pip install qaboard`)
- This auto-configures API URL (https://qaboard.samsungds.net)

### Server
- Deploy with: `docker compose -f docker-compose.yml -f production.yml -f deployments/dsk.yml up`

### Breaking Changes
- DB migration required: `is_ldap`/`is_sso` booleans -> `login_type` string field
  Run: `alembic upgrade head`
- `--lsf-threads` renamed to `--lsf-max-threads`

## For Open-Source Users

No breaking changes. The default behavior is unchanged.
New features available: LDAP/SAML auth, LSF/celery runners, multiple
image servers -- all opt-in via ENV vars.
