# Warts: further fixes

Found while surveying the code base (October 2026). The first list's items were fixed in the same month (see the
release notes and SECURITY.md); what's below is left, or was found while fixing them. Everything here is a **follow-up**.

- Tags: effort **S** (an hour) / **M** (a day) / **L** (more), and whether the fix changes **behaviour/API**
  (*no change*, *behaviour* = what users or admins observe, *API* = HTTP routes/params/responses, CLI flags, qaboard.yaml).
- Within each section, items are ordered by value/effort. Search for the quoted code: line numbers drift.
- Not repeated here: [docs/known-issues.md](docs/known-issues.md) (site-specific code, ops, EOL images, migrations),
  [docs/TODO.md](docs/TODO.md) (docs and small product items) and [webapp/TODO.md](webapp/TODO.md) (viewers to check,
  dependencies, performance).

## Security

- **Users' files are served in QA-Board's origin**, and by default their HTML and SVG run scripts there (stored XSS).
  `QABOARD_SANDBOX_HTML=true` sandboxes them (`services/nginx/conf.d/qaboard-files.conf`, the HTML and plotly viewers):
  in the web app's frames their scripts run in an origin of their own, opened in a tab they show without scripts, so
  their images still load with the session where files are restricted. Turn it on by default once users know, then
  serve the storage from another host name (e.g. `files.<qaboard>`, with its own sign-in handoff): reports opened in
  a tab could run their scripts too, and the class of bugs goes away. [L, behaviour]
- **Anonymous results**: while `ingest.auth` is `off` (the default), anyone can send results to any project, and through
  the `qaboard_config` they send, add hosts to the integrations' allow-list or Jenkins jobs that anonymous `qa` may start.
  Per-project ingest policies and CI OIDC trust are milestone M5 (docs/design/user-management.md). [M, API]
- `trigger_jenkins_build` (api/integrations.py) doesn't check the scheme and port of `build_url` for signed-in users;
  `jenkins_status_url_allowed` could apply, if templated build URLs in qaboard.yaml keep working. [S, behaviour]
- The webhook and git proxies use `verify=False` (internal hosts with certificates the server doesn't trust): make it a
  setting, on by default for new installs. [S, behaviour]
- OIDC user names can match a name listed in `QABOARD_ADMINS` when the IdP lets users choose their `preferred_username`:
  match env admins on (provider, subject) or verified emails only for OIDC. [S, behaviour]
- The GitLab "play job" endpoint doesn't check that the job is listed in qaboard.yaml (GitHub workflows do): left out so
  that integrations defined only on branches keep working. [S, behaviour]
- `deployments/sirc/metabase.yml` has default passwords and publishes Metabase's database on 5434. [S, behaviour]
- `services/pgadmin/passfile` hard-codes the default database password: generate it from `QABOARD_DB_PASSWORD`. [S, no change]
- pgAdmin 9 trusts `X-Pgadmin-User` from any peer (at SIRC, only nginx can reach it): pin `dpage/pgadmin4` to a version
  with `WEBSERVER_TRUSTED_PROXIES` once released, and set a shared secret. [S, no change]

## Backend

- **History page with outputs** is still ~2 s and ~19 MB for 25k outputs (backend/benchmarks/bench_api.py): building ORM
  objects and `Output.to_dict`. Serialize from SQL rows (no ORM), or paginate/stream outputs. [M]
- `GET .../manifest` writes manifests (api/outputs.py): make the refresh a POST, with OutputCard.jsx's `?refresh=true`. [S, API]
- `/api/v1/tests/group` (api/tuning.py) creates projects on a GET. [S, API]
- `trigger_jenkins_build` holds a uwsgi worker for 5-30 s (sleeps, then polls Jenkins' queue), and `jenkins_build` retries
  with nested bare `except`s. The status check fails with a 500 while a build is queued (no `building` in a queue item). [M]
- Commit search uses `ILIKE` over the project's commits (~40 ms for 5k commits). For projects with 100k+ commits, add
  `pg_trgm` GIN indexes on `message`/`branch` (needs `CREATE EXTENSION pg_trgm`). [S]
- `Output.metrics` is a JSON (text) column: aggregations parse it for every key. JSONB (a big table rewrite) would make
  aggregations and filters on metrics much cheaper. [L]
- `protected_ref_commits` (models/Project.py) runs git commands on every access, and is used in loops (clean.py, webhooks). [M]
- Project ids and clones are not qualified by host: two hosts with the same `group/repo` share a project. Tokens are
  shared by all users (no per-user OAuth). See docs/git-hosts-roadmap.md. [L, behaviour]
- Clones made before tokens moved to headers still have the token in their remote URL (`.git/config`): strip it once
  with `git remote set-url origin <url without credentials>` over `QABOARD_DATA_GIT_DIR`. Header authentication needs
  git ≥ 2.31 on the backend image (fine for ours, check custom ones). [S]
- Gitea's avatar URL, the Bitbucket signature header and the Gitea/Bitbucket payload fields were written from their docs
  and tested on sample payloads only: check them against real servers. [S]
- If `QABOARD_GIT_HOSTS` points to a file the kubernetes migration Job doesn't mount, the backend fails to import and
  the migrations Job fails (it used to stamp the database and skip the migrations silently). [S]
- api/export_to_folder.py `load_commit` hides database errors with a bare `except: return None`. [S, no change]
- The admin users page's `?admin=true` filters on `users.email`, so an admin whose only verified email is on a linked
  OIDC identity isn't listed. [S, behaviour]
- `created_at = datetime.datetime.utcnow()` in `start_tuning` (api/tuning.py), and other `utcnow()` (deprecated in 3.12). [S, no change]
- `backend/tests/test_storage.py` fails when run alone (`TypeError: type 'pw' is not subscriptable` in its `outputs_api`
  fixture): it depends on another test's mocks. [S, no change]
- In fs_utils.py, the `if __name__ == "__main__"` block sits before `measure()`'s definition. [S, no change]

## CLI

- `requires-python = ">=3.7"` (pyproject.toml) while the test suite needs click 8.2, so Python 3.10, and CI tests 3.11
  and 3.13. Before raising it, check the Python of the Windows nodes and of projects' venvs (docs/known-issues.md). [S, behaviour]
- `from qaboard import config` gives the config dict (qaboard/__init__ re-exports it), not the module: on Python < 3.13,
  `mock.patch('qaboard.config.x')` in tests/test_auth.py patches the dict and 56 tests error. [S, no change]
- `qaboard.api` binds `project` at import time: a test had to reload it. [S, no change]
- `qa batch` leaves `QA_BATCH` set in the process on its early returns (`--list`...), and its failure branch deletes
  `QA_BATCH` even when the batch was nested. [S, behaviour]
- `qaboard.utils.save_outputs_manifest` has no `mode`: the server chmods the manifests it writes. [S, no change]
- `qaboard/scripts/get_batch_storage.py` sends requests without timeouts and defaults to `http://qa`. [S, behaviour]
- Internal names left in `qaboard/`: the idb.py docstring, `\\netapp` in jenkins_windows.py's docstring, compat.py's
  regexes; tests use `gitlab-srv` strings. [S, no change]
- `api/tuning.py` and `qaboard/runners/celeryconfig.py` default to `pyamqp://guest:guest@qaboard:5672//`: read
  `CELERY_BROKER_URL` only, and fail clearly when it's unset with `QABOARD_TUNING_RUNNER=celery`. [S, behaviour]

## Webapp

- 81 "[Blueprint] <Popover> positions content incorrectly under React 19" warnings in the tests: some components still
  use `<Popover>` instead of `<PopoverNext>`. [S, behaviour]

## Deployments, services, charts

- nginx's `/iiif/` sets `X-Forwarded-Host $host:$server_port`: Cantaloupe gets the container's port, not the published
  one (e.g. :80 instead of :5151), so `info.json` ids may be wrong behind port mapping. The chart has the same lines. [S, behaviour]
- The `pgadmin` volume is mounted at `/root/.pgadmin`, but the image keeps its data in `/var/lib/pgadmin`: nothing
  persists (pgAdmin sets itself up again when its container is recreated). [S, behaviour]
- `deployments/sirc/sirc.yml` mounts `/data:/data` in Cantaloupe instead of `/repository/data` (Cantaloupe is disabled there). [S, no change]
- `.gitignore` lists `drafts/`, which moved to `deployments/sirc/runbooks/`, and ci.yaml's path filter still names it. [S, no change]
