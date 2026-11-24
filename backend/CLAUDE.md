# backend/CLAUDE.md
The Flask API (`backend/backend/`), served by uWSGI. Cross-directory rules ("Change together"): root `CLAUDE.md`.

## Running and testing
- Runs in Docker: `docker compose -f docker-compose.yml -f development.yml up -d` from the repo root; logs, shell,
  running as your user: `README.md`.
- Tests: `uv run python -m pytest -q -p no:cacheprovider tests` here. `tests/TESTING.md`: the C headers `uv sync`
  needs, the mock strategy (`conftest.py` shields imports; call handlers directly in `dummy_app.test_request_context()`,
  no `test_client()`, no global `@patch`), and the SQL tests that need `QABOARD_TEST_DATABASE_URL` (else skipped).
  The backend venv installs a non-editable copy of `qaboard/`: `uv sync` again before testing changes made there.
  `integration_tests/` run the real app on a database they create (`BACKEND_TEST_MODE=no-mock`).
- Migrations: Alembic (`backend/alembic/`). A merged migration is never changed: databases record which ran by id.
- The HTTP API (e.g. the tuning endpoints) is documented in `backend/openapi.yaml`; `tests/test_openapi.py` checks
  that it is valid and its routes exist.

## Audit log
An endpoint or job that runs code, deletes or changes something records an event with `audit('category.verb', ...)`
(`backend/audit.py`), in the same transaction as the change, and registers it in `backend/audit_actions.py` (label,
category, `project=True` to show it in the project's audit log); otherwise it says why in `NOT_AUDITED` there.
`tests/test_audit_actions.py` checks both. The web app reads labels from `/api/v1/audit/actions` and shows `meta` as
details: a new action needs no frontend change. Docs: `website/docs/backend-admin/audit-log.mdx`.

## Runs and their files
- **Locations**: runs store their full location in `outputs.output_dir_override`: a path, or a URL like `s3://...`
  resolved by the storage locations admins add (`backend/locations.py`). Never resolve it with `Path()`: use
  `Output.output_dir` or `locations.local_path`.
- **Uploads**: runs without a shared storage send their files to the one folder the server keeps for that,
  `QABOARD_UPLOAD_ROOT` (`backend/uploads.py`). Client side: `qaboard/CLAUDE.md`.
- **Heartbeats**: runs report at least every 2 minutes and are failed when silent (`backend/heartbeats.py`).
- **Local changes**: the server caps `runs.local_changes` and keeps only known fields (`backend/local_changes.py`).
- **Reference branch**: `backend/reference_branch.py`, kept in sync with the web app and `qa` (root `CLAUDE.md`).
- Refusal codes are `qaboard/conventions.py` `Reason`, shared with `qa`. `tests/test_active_run.py` (repo root) fakes
  these endpoints: change it with them.
- Design and decisions: `docs/design/ingest-upload-sdk.md`; limits: `docs/warts.md` (Backend, Uploads).

## Batches the server starts
- `QABOARD_TUNING_RUNNER`, decided in `backend/server_runner.py`: unset, the server starts no batches; `local` and
  `celery` (in its own container) are opt-ins (`runner_jobs.py`, `local_jobs.py`).
- `qa batch --commit <sha>` and the web app start batches through the tuning endpoints (`backend/api/tuning.py`).
- Commit artifacts sent with `qa save-artifacts`: `backend/api/commit_artifacts.py`. Batches started from them get a
  token of the user that only changes that batch: `tokens.mint_for_batch`, `batch_allows` in `backend/tokens.py`,
  `actor.BATCH_TOKEN_ENDPOINTS`.
- Design and trust model: `docs/design/kubernetes-runner.md`; limits: `docs/warts.md` (Runners).

## Other
- Sign-in (`backend/sign_in/`): local, LDAP, SAML and OpenID Connect providers.
- Background jobs (deletes, cleanups, schedules, storage usage): `backend/jobs/`, a queue in the database run by
  `qaboard-admin jobs worker` next to the web server (`jobs/worker.py`). Celery/RabbitMQ is only a runner for batches.
