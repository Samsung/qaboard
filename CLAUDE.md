# CLAUDE.md
Guidance for coding agents in this repository. Each top-level directory with its own rules has a `CLAUDE.md`, loaded
when you work on its files: read it before changing code there.

QA-Board is a self-hosted quality tracking platform: every commit's outputs and metrics next to a reference's, with
advanced viewers, reviewed by people and coding agents alike (positioning: "Positioning" in `website/STYLE.md`).
The `qa` CLI / SDK runs user code and sends results; the backend stores them in PostgreSQL; the web app shows them.

## Repository map
| Directory | What | Rules |
|---|---|---|
| `qaboard/` | Python package: the `qa` CLI (Click), the SDK (`qaboard.start_run()`), runners. Tests in `tests/` | `qaboard/CLAUDE.md` |
| `backend/` | Flask API (uWSGI), PostgreSQL (SQLAlchemy, Alembic in `backend/backend/alembic/`), a jobs worker. Tests in `backend/tests/` | `backend/CLAUDE.md` |
| `webapp/` | React SPA served by nginx, and the standalone viewers | `webapp/CLAUDE.md` |
| `website/` | Docusaurus docs site and the release notes | `website/CLAUDE.md` |
| `deployments/`, `charts/qaboard/` | Compose env files and `deploy.py`, site overlays (`sirc/`, `dsk/`), runbooks; the Helm chart | `deployments/CLAUDE.md` |
| `services/` | Images and config of the infrastructure: nginx, db, cantaloupe (IIIF image server), vips, pgadmin, metabase, flower | |
| `tests/` | Python tests of `qaboard/`; `tests/fixtures/` are shared with the web app's tests | |
| `skills/` | Skills for agents working in *users'* projects (`skills/README.md`) | |
| `examples/`, `docs-media/` | Demo projects whose history feeds the demo server; the pipeline that captures the docs' screenshots | `README.md` in each |
| `docs/` | Design docs, RFCs, warts, TODO (see below) | |
| `qatools/` | Backward-compatibility alias (`import qatools`) | |

## Setup
Python with `uv` (the backend needs 3.11+; CI tests `qa` on 3.11 and 3.13), `npm` for the web app, `yarn` for the website.
```bash
docker compose -f docker-compose.yml -f development.yml up -d   # full dev stack (SIRC: see deployments/CLAUDE.md)
uv sync --extra dev        # qaboard + dev tools; runner extras: --extra celery --extra dask --extra kubernetes --extra dask-kubernetes --extra mlflow
cd webapp && npm install && npm start      # Vite dev server, proxies the API to localhost:5151
cd website && yarn install && yarn start   # docs site
```
Without Docker (e.g. cloud containers): `uv run scripts/dev.py up && uv run scripts/dev.py seed` runs the server with
sample data; skill `.claude/skills/dev-server/SKILL.md` (sign in, screenshots, integration tests' database).

## CI and tests
CI: `.github/workflows/ci.yaml` (jobs `python`, `webapp`, `docker`, `helm`, `quickstart`, `helm-e2e`,
`kubernetes-runner-e2e`, image/chart publishing), `website.yml`, `docs-media.yml`; helper scripts in `.github/scripts/`.
CI runs the jobs a change needs: the `changes` job maps files to jobs in `.github/scripts/ci_changes.py` (the only
mapping, tested by `tests/test_ci_changes.py`); `uv run .github/scripts/ci_changes.py` shows what your branch runs.
Master, releases and workflow_dispatch run every job. On branches, `quickstart`, `helm-e2e` and `kubernetes-runner-e2e`
run only for changes to what they protect, or with the `run-e2e` PR label: **when your change can break them, run
them locally (commands in `docs/ci.md`) or add the label.** `ci-ok` is the one required check: a new job needs an
output of `changes`, an `if:` on it, and a place in `ci-ok`'s `needs`.
```bash
uv run green tests                                      # qaboard tests (unittest, green runner)
uv run flake8 backend qaboard                           # lint (config: .flake8)
uv run mypy -p qaboard --ignore-missing-imports         # types
cd backend && uv run python -m pytest -q -p no:cacheprovider tests   # needs C headers, see backend/tests/TESTING.md
cd webapp && npm run lint && npm run typecheck && npm test -- --run  # oxlint, tsc, vitest
cd webapp && npm run build && npm run e2e               # Playwright smoke tests on the production build
uv run website/release-notes/release_notes.py check --strict
```
CI also checks that merged Alembic migrations are never changed (`.github/scripts/check_migrations.py`) and that
`backend/uv.lock` is up to date (`uv lock --check --directory backend`).

## Rules that apply everywhere
- **Release notes in the same PR as any user-visible change** (web app, `qa` CLI, qaboard.yaml, server/admin): update
  the current month's `website/release-notes/YYYY-MM.md` (create it with
  `website/release-notes/release_notes.py draft YYYY-MM --write`), edit the feature's bullet rather than append, then
  run `release_notes.py check` and fix its warnings. Skip refactors, CI-only and typo changes. How to write them:
  `website/CLAUDE.md`.
- **Docs in the same PR**: a change to how people use the web app updates its `website/docs/user-guide/` page; a change
  to qaboard.yaml keys, `qa` options or the `Run` object also updates `skills/` (CI checks their docs links).
- **Audit log**: an endpoint or job that runs code, deletes or changes something records an `audit(...)` event,
  registered in `backend/backend/audit_actions.py` (or listed in `NOT_AUDITED` with why). Details: `backend/CLAUDE.md`.
- **The repo and website are public**: no internal hostnames, paths, emails, people, commit shas or ticket ids in
  `website/` or release notes. Site-specific pages: `website/site-docs/<site>/`; runbooks: `deployments/<site>/runbooks/`.
- **Attribution**: end commits and PR descriptions with the attribution lines your session gives. Never put a model
  name in commits or code.

## Change together
Pieces in different directories that must agree; each side's `CLAUDE.md` points back here.
- **Reference branch** (`project.reference_branch`, else the repo's default branch sent as `git.default_branch`,
  else `main`): `backend/backend/reference_branch.py`, `reference_branch_of` in `webapp/src/defaults.js`,
  `reference_branch()` in `qaboard/config.py`.
- **File formats read in Python and in the web app**, tested on the same fixtures:
  `qaboard/benchmarks.py` / `webapp/src/viewers/benchmarks/parse.js` (`tests/fixtures/benchmarks/`),
  `qaboard/series.py` / `webapp/src/viewers/series/series.js` (`tests/fixtures/series/`),
  `qaboard/media.py` / `webapp/src/viewers/media/media.js` (`tests/fixtures/media/`).
- **File names the viewers recognize** (`webapp/src/viewers/fileTypes.js`) are the ones `qaboard/junit.py` and
  `qaboard/benchmarks.py` read metrics from.
- **The tests' fake server** (`tests/test_active_run.py`) answers like the real backend endpoints.
- **Refusal codes**: `Reason` in `qaboard/conventions.py`, shared with the backend.
- **Local changes** (`data.local_changes`): written by `qaboard/local_changes.py`, capped to known fields by
  `backend/backend/local_changes.py`, shown by `webapp/src/components/LocalChanges/`.
- **What `qa` and the SDK send with results** is built in one place: `qaboard/payloads.py`.

## Design docs, known warts, TODO
- Design: `docs/design/` (ingest/upload/SDK, Kubernetes runner, logged media, user management...), `docs/rfcs/`
  (SDK runs, local changes, ...). Read the relevant one before changing a subsystem.
- **Known warts**: `docs/warts.md`, by area (Security, Backend, CLI, SDK runs, Local changes, Logged media, Uploads,
  Runners, Webapp, Deployments). Add what you find but don't fix there, under its area.
- Site-specific leftovers: `docs/known-issues.md`. Docs to-dos: `docs/TODO.md`; web app follow-ups: `webapp/TODO.md`.
