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
- webapp, tuning form (`components/tuning/forms.js`): branch rule for `CDE-Users/HW_ALG`, platform picker for
  `dvs/psp_swip` and `tof/swip_tof` (should come from `inputs.platforms`), blocking tuning as `ispq`
  (should be `tuning.runners.lsf.forbidden_users`), `openstf` defaults, pasted text with `=` rewritten as CDE registers,
  a feedback `mailto:`.
- webapp: "Algorithmic bottlenecks" section for `dvs/psp_swip` (`Dashboard.js`), the WebCDE button when outputs
  contain a `cde.sh` (`components/tags.js`), `/algo/X/inputs` → `/algo/X_inputs` in IIIF paths (`viewers/images/utils.js`).
- webapp: `defaults.js` uses `reference_branch: 'develop'`, the CLI defaults to `master`.
- webapp: projects without `project.name` in their qaboard.yaml are hidden from the projects list ("legacy SIRC projects").
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
- On a fresh database `alembic upgrade head` fails (the baseline migration is empty). `init.sh` falls back to
  `alembic stamp head` and the app creates the tables, so it works, but it's noisy.
- GitLab `smoke-test:dev` runs backend tests against the CI instance, which uses the production database
  (`QABOARD_DEV_DB_HOST=qa`).
- Publishing:
  - PyPI: create a GitHub release with a tag matching the version (`pypy.yml`). Needs trusted publishing
    configured on PyPI, or a `PYPI_API_TOKEN` secret.
  - GitLab's manual `publish:PyPi` job (twine from planet31) is redundant with the GitHub release.
  - Docker images: `publish-docker-images` needs `DOCKERHUB_USERNAME`/`DOCKERHUB_TOKEN` secrets.
- CI tests the CLI on Python 3.11 only, but `requires-python` says `>=3.7`.
- The website deploy workflow only runs on master pushes that touch `website/`.
