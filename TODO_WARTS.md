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

## Runners (Kubernetes, Dask on any scheduler, `qa doctor`, November 2026)

Design and follow-ups: [docs/design/kubernetes-runner.md](docs/design/kubernetes-runner.md). Security boundaries are
documented for admins in `website/docs/backend-admin/runners.mdx`: we rely on the cluster's own tools (namespaces,
Pod Security, admission policies, Kueue/ResourceQuota) rather than re-implementing them.

### What was verified, what wasn't
- Real: the Kubernetes runner on a kind cluster (`.github/scripts/kubernetes_runner_e2e.py`, CI job
  `kubernetes-runner-e2e`), Dask with `cluster.type: local`, a real Celery worker for stopping batches
  (`tests/test_celery_stop.py`), backend integration tests on Postgres for stop/tuning/redo.
- Only with fakes/mocks: LSF, Slurm, PBS, SGE, HTCondor, OAR and Moab commands (submit, cancel), Jenkins, Dask on
  Kubernetes (`KubeCluster`), the server starting batches on a real cluster. Try them on a real cluster before
  advertising them. `run_as: user` with a non-root UID first runs for real in CI. [M, no change]

### Kubernetes
- **A namespace is a trust domain** for batches started from the web app: the driver pod runs the project's code with
  a ServiceAccount that can create Jobs, so users who start batches in a namespace can act as each other (documented;
  `QABOARD_KUBERNETES_RUN_AS=<uid>:<gid>` runs them all as one account). Real per-user isolation: the backend creates
  the run Jobs itself, the driver calls back with a per-batch credential (design doc, "Follow-ups"). [L, API]
- No shared filesystem, no runs: pods must see the code, inputs and outputs at the same paths. HTTP upload
  (`docs/design/http-upload.md`) then an image per commit remove that. [L, API]
- Secrets aren't forwarded to pods (they'd be stored in ConfigMaps): runs that send results to a server that requires a
  token need a Secret through `job_template` (`env.valueFrom.secretKeyRef`) or a shared HOME after `qa auth login`.
  An `env_from_secret` option would be simpler. [S, API]
- The pods' PID 1 is `sh`, which doesn't forward SIGTERM to `qa run`: stopped runs are marked failed by `qa batch` or
  the server rather than by `qa run` itself. Use `exec`/a tiny init when there's one run per pod. [S, behaviour]
- One namespace and kubeconfig context per batch: runs whose input type sets another one get a warning and use the
  batch's. When a group needs several Jobs (different pod specs, or too many runs for one ConfigMap), `concurrency`
  applies to each Job (with a warning). [M, behaviour]
- Kubernetes ≥ 1.29 only (per-index retries, `backoffLimitPerIndex`): older clusters are refused, by `qa doctor` and
  when a Job loses the field. [S, no change]
- Image pulls that keep failing fail the batch after 5 minutes; waiting in a Kueue queue is never fatal. [S, behaviour]
- The server only stops batches in namespaces listed in `QABOARD_KUBERNETES_NAMESPACES` (otherwise a warning), and the
  pending driver pod is only watched for 20s after it's submitted. [S, behaviour]

### Dask on other schedulers
- `--no-wait` and server-side stops on Slurm/PBS/SGE/HTCondor/OAR/Moab need those commands where the driver or the
  server runs; the backend image doesn't ship them. Old Torque truncates job names over 15 characters; Moab is assumed
  to run on Torque/PBS. [M, no change]
- OAR: the driver can't receive the environment (OAR has no option for it), and dask-jobqueue's 30-minute walltime
  stays unless `walltime` is set (`qa doctor` warns). [S, behaviour]
- Dask on Kubernetes needs the Dask operator; `KubeCluster` can't pick a kubeconfig context (only the current one);
  the scheduler pod asks for 1 CPU and 2Gi. [S, behaviour]

### Celery and runs on the server
- From the server, stopping Celery batches only reaches the server's broker (`CELERY_BROKER_URL`): batches sent to a
  team's own broker or vhost keep running (broker URLs from batch data can't be trusted). [M, behaviour]
- Workers remember revoked tasks in memory: a worker started after a stop may still run the batch's queued tasks,
  unless workers use `--statedb`. Terminating running tasks needs Celery 5.3+ and the prefork pool. [S, behaviour]
- `qa batch` started by the server (`QABOARD_TUNING_RUNNER=local`/`celery`, and redo without the LSF bridge) runs as a
  detached process of the backend container: another replica can't stop it, and redeploying the backend kills it.
  Running projects' code on the server trusts every project developer with what the server's account can read (the
  environment is scrubbed, files aren't). [M, behaviour]

- Batches started from the web app get no QA-Board token, whatever the runner: on a server with `ingest.auth: token`,
  their runs can't save results unless a shared HOME holds a `qa auth login`, or (Celery) the workers set
  `QABOARD_TOKEN`. The server could mint a short-lived, project-scoped ingest token per batch. [M, API]
- `runner_jobs.submit_driver` checks that the kubernetes runner exists, which can't fail (it's always registered):
  check that the `kubernetes` package is installed instead, with the install hint. [S, behaviour]
- The worker job script `qa doctor` shows for Dask is named `doctor_dask`, not the batch's real name. [S, no change]

### LSF
- The bridge template wraps `{bsub_command}` in single quotes: a job script containing a single quote breaks on the
  bridge host. Send the script through ssh's stdin instead. [S, behaviour]
- SIRC's `bsub_su` wrapper isn't in the repo (`deployments/sirc/runbooks/lsf-bridge.md`). The bridge path's
  environment isn't scrubbed like local dispatches. [S, no change]

### `qa doctor`
- No server version compatibility check (the server doesn't expose its version). CLI overrides like `--lsf-queue`
  and `QA_BATCH_LSF_*` aren't reflected in its checks. [S, behaviour]

## Webapp

- `AppNavbar.test.jsx` ("arrow keys then Enter") failed once under load in the full run and passes alone: a timing
  assumption in the test. [S, no change]

- 81 "[Blueprint] <Popover> positions content incorrectly under React 19" warnings in the tests: some components still
  use `<Popover>` instead of `<PopoverNext>`. [S, behaviour]

## Deployments, services, charts

- nginx's `/iiif/` sets `X-Forwarded-Host $host:$server_port`: Cantaloupe gets the container's port, not the published
  one (e.g. :80 instead of :5151), so `info.json` ids may be wrong behind port mapping. The chart has the same lines. [S, behaviour]
- The `pgadmin` volume is mounted at `/root/.pgadmin`, but the image keeps its data in `/var/lib/pgadmin`: nothing
  persists (pgAdmin sets itself up again when its container is recreated). [S, behaviour]
- `deployments/sirc/sirc.yml` mounts `/data:/data` in Cantaloupe instead of `/repository/data` (Cantaloupe is disabled there). [S, no change]
- `.gitignore` lists `drafts/`, which moved to `deployments/sirc/runbooks/`, and ci.yaml's path filter still names it. [S, no change]
