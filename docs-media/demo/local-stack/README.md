# A local QA-Board stack without Docker, seeded with trainings

For development, `scripts/dev.py` is the general version of this stack (any user, any ports, per checkout); this one
is kept for the logged-media showcase's screenshots. `scripts/dev.py` reuses `fileserver.py`.

For screenshots where Docker images can't be pulled: Postgres and Redis from the system's binaries, the backend and
the web app from this checkout, and training runs logged from Python with `qaboard.start_run()`, the W&B shim and
the MLflow plugin.

It assumes Debian or Ubuntu, as root, e.g. in a container: Postgres from `/usr/lib/postgresql/*/bin`, a bind mount for
its data, results under `/mnt/qaboard`. Elsewhere, use the Docker setup (`docker-compose.yml`).

```bash
uv run docs-media/demo/local-stack/stack.py up      # (re)starts everything, idempotent; prints the user and token file
uv run docs-media/demo/local-stack/seed.py          # demo repository + 9 runs, ~1 min; prints the pages' URLs
node docs-media/demo/local-stack/check.cjs          # screenshots of those pages (deviceScaleFactor 1), page errors
uv run docs-media/demo/local-stack/stack.py status | down | reset   # reset: deletes the database and the results
```

| | |
|---|---|
| Web app | http://localhost:3000 (`npm start`, Vite: proxies `/api` to the backend, `/s/` to the file server) |
| Backend | http://localhost:5152 (`flask run` from `backend/`, plus `qaboard-admin jobs worker`) |
| Run files | http://localhost:5151/s/mnt/qaboard/... (`fileserver.py`, in place of nginx's `/s/`) |
| User | `maya` / `qaboard-demo` (local account, admin); its API token in `<stack>/token` |
| State | `<stack>` = `$QABOARD_LOCAL_STACK`, default `$TMPDIR/qaboard-local-stack`: `postgres/`, `data/`, `logs/`, `pids/`, `seeded.json` |
| Results | `/mnt/qaboard` (`QABOARD_UPLOAD_ROOT`): the runs have no shared storage and upload their files, like the product's default |

## How it maps to the Docker setup
- **Postgres** (`/usr/lib/postgresql/*/bin`) runs as the `postgres` user, which may not reach `<stack>` (e.g. when a
  parent folder is `0700 root`): `<stack>/postgres` is bind-mounted at `/var/lib/postgresql/qaboard-local-stack`.
- **Backend**: the environment of `docker-compose.yml` + `development.yml` (`QABOARD_DB_*`, `REDIS_*`, `QABOARD_DATA_DIR`,
  `QABOARD_LOGIN_TYPE=LOCAL`), plus `QABOARD_UPLOAD_ROOT=/mnt/qaboard` and `QABOARD_URL=http://localhost:3000` (the links
  `qa` prints). Migrations as `migrate.sh` does: `flask routes` creates the tables, then `alembic stamp head` (or `upgrade`).
  `uv sync` in `backend/` needs `libldap2-dev libsasl2-dev libxmlsec1-dev libxml2-dev libxslt1-dev libpq-dev pkg-config`.
- **nginx** isn't installed: `fileserver.py` serves `/s/<absolute path>` under the results root, with Range requests,
  and passes folder listings (`Accept: application/json`) to the backend like nginx's `uwsgi_pass`. No access checks
  (nginx asks `/api/v1/files/authorize`), no IIIF image server (`/iiif/` 404s).
- The release notes popup is off with `npm start`; `check.cjs` also sets `qaboard.release-notes.last-seen`.

## The demo project (`project/`)
`kitefin/denoiser`, a git repository made by `seed.py` in `$TMPDIR/qaboard-demo-project`, no `storage` in its
qaboard.yaml (uploads), `reference_branch: main`. `train.py` simulates a denoiser with a detection head on procedural
scenes (`scenes.py`, numpy only), in seconds: series per step (`train/loss`, `lr`, `val/loss` and `val/psnr` every
25 steps), media every 200 steps (`val/samples` with ids and a shuffled order, `val/detections/*` with boxes,
`denoise/audio`, a `predictions` table with image cells, `weights/conv1` histograms, `answers/prompt-1` texts), and
metrics at the end.

- `main`: "Train the denoiser on procedural scenes": `train.py` (the reference), `train_wandb.py` through
  `python -m qaboard.integrations.wandb` (batch `wandb-shim`), `train_mlflow.py` with `MLFLOW_TRACKING_URI=qaboard:`
  (batch `mlflow-plugin`).
- `feat/attention-skips`: "Add attention to the skip connections" (`model.py`: higher capacity, surer detections):
  `train.py` (the new run), an lr sweep (batch `lr-sweep`: 3e-4, 1e-3, 3e-3, the last unstable), W&B and MLflow again.

Runs go through the web app's address as CI jobs (`CI=true GIT_COMMIT GIT_BRANCH`, the user's token), so their batches
are `default`, `lr-sweep`... rather than `@maya| ...`. They run with this checkout's qaboard:
`uv run --project <repo> --inexact --extra mlflow` (`--inexact` keeps the other extras installed); the MLflow runs
add Pillow and pandas with `--with` (MLflow needs them for `log_image(array)` and `log_table`).
