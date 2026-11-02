# Known issues after the branch unification

Open-source, SIRC and DSK now share `master`. This lists what is still site-specific or rough,
roughly by priority. None of it breaks the open-source version.

## Deployment configs live in this repository
`deployments/sirc` and `deployments/dsk` (compose overlays, nginx, CLI site packages, certificates, `.envrc`)
are not sensitive, but they are internal. When it's worth it, move each to its own small private repo:
- Keep `deployments/example.yml` here as the template.
- Clone the site repo next to this one and point compose at it, e.g. `-f ../qaboard-deployments/sirc/sirc.yml`.
  Relative paths in overlays are resolved from the first compose file's directory (this repo),
  so `./deployments/sirc/...` paths become `../qaboard-deployments/sirc/...`.
- The backend image only needs the site's CLI package at build time. The Dockerfile bind-mounts `deployments/`
  during the build; with a separate repo, use a compose `additional_contexts: {deployments: ../qaboard-deployments}`
  and `--mount=type=bind,from=deployments,...` in the Dockerfile.
- `.gitlab-ci.yml` would clone the site repo before deploying.

## cde-python (was a git submodule)
`third_party/cde-python` was unused: images and the SIRC site package install `cde` with pip
(`CDE_PACKAGE` build arg, `qaboard-site-sirc` dependency). To hack on it locally:
```bash
git clone git@gitlab-srv:cde/cde-python.git ../cde-python
uv pip install -e ../cde-python
```

## SIRC-specific logic still in shared code
Harmless for other sites (it only triggers on SIRC project names, paths or files), but could become settings:
- webapp, tuning form (`components/tuning/forms.jsx`): pasted text with `=` rewritten as CDE registers (documented as
  a generic `key=value` paste). HW_ALG, the only active SIRC project relying on project-specific logic, sets its branch
  rule in its own qaboard.yaml: `tuning.branches: [develop, '*/*{subproject.name}*']`.
- webapp: the WebCDE button when outputs contain a `cde.sh` (`components/tags.jsx`), with `QABOARD_WEBCDE_INSTALLER`.
- webapp: `defaults.js` uses `reference_branch: 'develop'`, the CLI defaults to `master`.
- webapp: projects without `project.name` in their qaboard.yaml, or with `legacy` (`migrate_legacy_commits.py`), are
  hidden from the projects list.
- webapp: `package.json` has `"proxy": "http://qa:5001"` for the dev server; a few docs links bypass `docs_root`;
  the projects list links to spectrum.chat, which is gone.
- CLI: `\\netapp\vol23_algo` → `vol24_algo` rewrite (`compat.py`), `CDE-Users/HW_ALG` manifest rules (`utils.py`),
  `\\netapp` shares in the Jenkins Windows runner, `WEBCDE_CONNECTION_ID` in the celery runner, `idb.py`.
- backend: DSK's SAML settings are in `backend/backend/api/saml/settings.json` (DSK must set `QABOARD_SAML_DIR`),
  HW_ALG cleanup commands (`clean.py`), one-off SIRC scripts in `backend/backend/scripts/`,
  `PYTHONWARNINGS` hides TLS warnings for everyone (`backend/Dockerfile`).
- services: `services/backend/passwd`, `services/nginx/passwd` and `services/backend/ldap/` are SIRC data
  (only mounted by `sirc.yml`); nginx runs with the `uucp` group.

## Ops
- The cantaloupe admin endpoint is enabled with `qaboard`/`qaboard`. It is only reachable inside the compose network.
- Base images: cantaloupe uses `alpine:3.10`, nginx uses Debian buster from archive.debian.org. Both are EOL.
- The baseline migration is empty: a new database can't be built by `alembic upgrade head`. The app creates the
  tables when it's imported (`Base.metadata.create_all`), and `migrate.sh` stamps a new database (no data, no version)
  at the head. A database with data but no version makes `migrate.sh` fail: stamp it by hand at the migration it has.
- PostgreSQL 12 is EOL (Nov 2024). Upgrade with dump/restore, e.g. when moving to kubernetes (CloudNativePG uses 16).
- Deploys need docker compose ≥ 2.24 on the hosts and on the GitLab runner (`${VAR:+...}` interpolation,
  `pull --policy`). SIRC's hosts run Docker Engine 24 (API 1.43): fine, but not healthcheck `start_interval`.
- With docker compose, nginx is restarted (~1s of refused connections) when the *proxy image* changes.
  Config changes are reloaded without a restart, and new versions with the same image don't restart it.
- SIRC staging uses the shared storage, the LSF bridge and `/home/ispq/qaboard/shared` like production.
- The SIRC GitLab pipeline was written without access to SIRC's GitLab/runners: check on the first run that
  the registry is enabled (else `QABOARD_BUILD_ON_HOST=1`), and the one-time host setup in
  `deployments/sirc/runbooks/deployment.md`.
- Publishing:
  - PyPI: create a GitHub release with a tag matching the version (`pypy.yml`). Needs trusted publishing
    configured on PyPI, or a `PYPI_API_TOKEN` secret.
  - GitLab's manual `publish:PyPi` job (twine from planet31) is redundant with the GitHub release.
  - Docker images: `publish-docker-images` needs `DOCKERHUB_USERNAME`/`DOCKERHUB_TOKEN` secrets.
- CI tests the CLI on Python 3.11 and 3.13, but `requires-python` says `>=3.7`. The code has no syntax or API newer
  than 3.7 (checked in October 2026: `qa batch` runs on 3.8, the unit tests need click 8.2 so Python 3.10). Before
  raising it, check the Python of the SIRC Windows nodes (installed by the `Install_qaboard_on_windows_nodes` Jenkins
  job) and of the projects' own environments: `pip install` refuses a `qaboard` that requires a newer Python.
- The website deploy workflow only runs on master pushes that touch `website/`.
- The helm chart (`charts/qaboard`) is validated (lint, kubeconform) but was not run on a cluster yet.
  `deployments/sirc/values.yaml` has `TODO(sirc)`s, see `website/docs/backend-admin/kubernetes.mdx`.
