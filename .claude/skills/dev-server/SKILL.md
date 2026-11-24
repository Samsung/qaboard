---
name: dev-server
description: Start a local QA-Board development server from this checkout without docker compose (PostgreSQL, backend, web app), fill it with a small realistic dataset, sign in, and take Playwright screenshots of its pages. Use when you need to run, see or screenshot the web app or the API with data, check a change in the real app, run `qa` against a server, or need a PostgreSQL for the backend's integration tests.
---

# Run QA-Board locally, with data

`scripts/dev.py` runs everything from this checkout, as processes, with its state in `.dev/` (gitignored):
PostgreSQL (the installed binaries, else docker), the Flask backend (reloads on code changes), the jobs worker, a
small proxy that does nginx's job, and the web app's Vite server (reloads too). Docker compose isn't needed.

```bash
uv run scripts/dev.py up      # idempotent; cold: ~10 s (+1 min for npm install the first time)
uv run scripts/dev.py seed    # ~20 s, once: prints the seeded pages' URLs
uv run scripts/dev.py status  # what runs, URLs, credentials (--json)
uv run scripts/dev.py down    # stop everything when you're done; `reset` also deletes the data
```

| | |
|---|---|
| Web app | http://localhost:3000 (`npm start`): proxies `/api` and `/s/` to the server |
| Server | http://localhost:5151: the API (flask on :5152) and the runs' files under `/s/`; app pages redirect to :3000 |
| Sign in | `admin` / `qaboard-dev` (admin). An API token is in `.dev/token` |
| Logs | `uv run scripts/dev.py logs backend` (also `webapp`, `proxy`, `jobs-worker`, `postgres`) |

Options: `up --no-web` (API only), `--no-worker`, `--port 5161 --web-port 3010` when the ports are taken (e.g. by
another checkout's server), `--postgres docker`. Errors say what's missing and how to install it.

## The seeded data
Made by the real `qa batch`, as CI jobs, from two tiny projects in `scripts/dev_seed/` (git repositories in
`.dev/seed/`; their code reads each commit's `build/flags.json`):
- `dev/image-pipeline`: 3 commits on `main`, 2 on `feat/stronger-denoise`; batch `ci` (4 scenes x 2 configurations:
  PNG images, a Plotly profile, a text report, metrics `psnr`, `noise`, `halo`, `runtime`) and a `tune-strength`
  batch (a matrix of parameters).
- `dev/test-suite`: 2 commits on `main`, 1 on `perf/table-varint`; JUnit reports (a failing and a flaky test) and
  benchmarks, with their metrics.

`seed` refuses any server but the one `up` started (its database carries this server's id). To add data, change
`STORIES` in `scripts/dev.py` or the projects, then `reset`, `up`, `seed`. `seed --force` re-runs the batches.

## Your own runs, psql, integration tests
`eval "$(uv run scripts/dev.py env)"` exports `QABOARD_URL` and `QABOARD_TOKEN` (then `uv run qa batch ...` or
`qaboard.start_run()` send results here), `PG*` for `psql`, and `BACKEND_TEST_MODE`/`QABOARD_TEST_DATABASE_URL` for
`cd backend && uv run python -m pytest integration_tests/<file>` (they create their own database next to ours).

## Screenshots
```bash
node scripts/dev-screenshot.cjs /dev/image-pipeline/commits .dev/shots/commits.png      # signed in as admin
node scripts/dev-screenshot.cjs '<a URL seed printed>' .dev/shots/commit.png --full --wait 5000
```
It prints the page's errors (failed requests, console errors). The first page after `up` takes ~20 s: Vite compiles
the app. Then Read the PNG to look at it. For your own Playwright script: `require('playwright')` works in cloud
containers (Chromium preinstalled); sign in with `context.request.post('http://localhost:3000/api/v1/user/auth/',
{form: {username: 'admin', password: 'qaboard-dev'}, headers: {Origin: 'http://localhost:3000'}})`, and set
`localStorage['qaboard.release-notes.last-seen'] = '9999-12-31'` if you use a production build (`npm run preview`).

## Limits
- No IIIF image server (`/iiif/` 404s, which only matters for images too large for the browser), no access checks
  on `/s/` files.
- Without network access to gravatar.com, avatars' requests fail with 500 (harmless; `docs/warts.md`).
- `docker compose -f docker-compose.yml -f development.yml up -d` remains the full stack (nginx, cantaloupe...).
