# Warts: further fixes

Found while surveying the code base (October 2026). The first list's items were fixed in the same month (see the
release notes and SECURITY.md); what's below is left, or was found while fixing them. Everything here is a **follow-up**.

- Tags: effort **S** (an hour) / **M** (a day) / **L** (more), and whether the fix changes **behaviour/API**
  (*no change*, *behaviour* = what users or admins observe, *API* = HTTP routes/params/responses, CLI flags, qaboard.yaml).
- Within each section, items are ordered by value/effort. Search for the quoted code: line numbers drift.
- Not repeated here: [known-issues.md](known-issues.md) (site-specific code, ops, EOL images, migrations),
  [TODO.md](TODO.md) (docs and small product items) and [webapp/TODO.md](../webapp/TODO.md) (viewers to check,
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
- The webhook and git proxies use `verify=False` (internal hosts with certificates the server doesn't trust): make it a
  setting, on by default for new installs. [S, behaviour]
- The GitLab "play job" endpoint doesn't check that the job is listed in qaboard.yaml (GitHub workflows do): left out so
  that integrations defined only on branches keep working. [S, behaviour]
- `deployments/sirc/metabase.yml` has default passwords and publishes Metabase's database on 5434. [S, behaviour]
- `services/pgadmin/passfile` hard-codes the default database password: generate it from `QABOARD_DB_PASSWORD`. [S, no change]
- pgAdmin 9 trusts `X-Pgadmin-User` from any peer (at SIRC, only nginx can reach it): pin `dpage/pgadmin4` to a version
  with `WEBSERVER_TRUSTED_PROXIES` once released, and set a shared secret. [S, no change]

## Backend

- **pytest is capped `<9.2`** (backend/pyproject.toml): 9.2's monkeypatch deletes the attributes it restores on the
  shared MagicMock models of `conftest.py` (pytest#10644), which breaks 12 later tests. Stop patching shared mocks
  (fixtures that build fresh ones), then drop the cap. [S, no change]
- **celery is held at 5.6** in backend/uv.lock: 5.7 pulls python-dateutil back to 2.9 and kubernetes to 37. Retry
  `uv lock --upgrade-package celery` when its constraints relax. [S, no change]
- The backend still uses ~143 legacy `Model.query` calls: SQLAlchemy 2.1 keeps them, but `select()` is the way
  forward if a future version deprecates them. [L, no change]
- **History page with outputs** is still ~2 s and ~19 MB for 25k outputs (backend/benchmarks/bench_api.py): building ORM
  objects and `Output.to_dict`. Serialize from SQL rows (no ORM), or paginate/stream outputs. [M]
- `GET .../manifest` writes manifests (api/outputs.py): make the refresh a POST, with OutputCard.jsx's `?refresh=true`. [S, API]
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
- Reruns' directories (qaboard/attempts.py): `qa batch` writes *latest_attempt.txt* when it reserves a new attempt,
  before the job starts. While the job waits in a queue (LSF...), or for good if it never starts (batch killed),
  `latest_dir()` and every reader (`--list-output-dirs`, `qa get`, postprocess, scripts reading the pointer) get the
  empty new directory, while the complete results are still in the previous attempt. Fix: `qa batch` picks the
  directory without writing (`attempts.next_dir`) and passes it to `qa run` (option or env, through every runner:
  local, lsf, celery, dask, kubernetes, windows), which writes the pointer when it starts; `reserve()` skips only
  directories where a run started, not those that exist (runners' logs create it). Loses the lock between two
  batches that submit the same run at once. [M, behaviour]
- `qaboard/scripts/get_batch_storage.py` sends requests without timeouts and defaults to `http://qa`. [S, behaviour]
- Internal names left in `qaboard/`: the idb.py docstring, `\\netapp` in jenkins_windows.py's docstring, compat.py's
  regexes; tests use `gitlab-srv` strings. [S, no change]
- `qaboard/runners/celeryconfig.py` defaults to `pyamqp://guest:guest@qaboard:5672//` (the backend no longer does):
  read `CELERY_BROKER_URL` only, and fail clearly when it's unset. [S, behaviour]

## Runs created from code (`qaboard.start_run()`, November 2026)

Experimental: `qaboard/active_run.py`, `qaboard/series.py`. Design: `docs/rfcs/python-sdk-runs.md`. Follow-ups (a
run-centric page, screenshots for the docs, gaps against experiment trackers): `docs/rfcs/python-sdk-runs-follow-ups.md`.

- Not verified against a real server and database end to end: the SDK's tests use an HTTP server that records
  requests, the backend's tests mock the database, the web app's a mocked API. Nor on Windows, in Jupyter, or with a
  site package. [M, no change]
- A process killed without warning (SIGKILL, out of memory, a node that dies) leaves its run "running" in the web
  app, like `qa run`. `resume=True` or a new attempt fixes the row. [M, behaviour]
- Distributed trainings that start the script once per GPU must call `start_run()` in one process only: each call is
  a new attempt, that removes the previous one's files. Forked workers that log are ignored, with a warning: their
  values never reach the run. [M, behaviour]
- `log()` writes under the run's lock, which the background thread also holds while it writes `series.json` and
  reads the attempts' logs and `metrics_definitions.json`: on a slow NFS, `log()` can wait for those. Snapshot under
  the lock, write outside. [S, no change]
- A process that changes directory to another project keeps the first one's settings: `qaboard/config.py` reads the
  project once, when imported (the commit is read again for each run). The SDK shares `qa`'s definitions of what is
  sent and where runs are saved (`qaboard/payloads.py`, `config.commit_data`, `read_commit`, `commit_outputs_dir`). [S, behaviour]
- `capture_output` saves what Python prints, not what C libraries write to the file descriptors, unlike `qa run`. [S, behaviour]
- `ActiveRun.run` is a `Run`, whose `log_metrics()` is the script route, refused for running runs: two
  `log_metrics` that look alike. [S, behaviour]
- The card's implicit "Logged series" can't be hidden: a batch of 200 such runs polls 200 files. In the Summary's
  comparison, a highlight is lost when the plots are drawn again while the pointer is on a run (a live refresh). [S, behaviour]
- Python's and the web app's series parsers round times differently on exact halves of a millisecond. [S, no change]
- `finish()` hashes every file of the run's folder for the manifest, like `qa run`: slow with tens of GB of
  checkpoints. [S, behaviour]
- A run whose every message to the server failed isn't sent later: `qa sync` doesn't know about series or about
  runs it didn't start. [M, behaviour]
- Every logged series is a metric by default (its last value), the learning rate too: projects with hundreds of
  series get hundreds of metrics (`summary="none"`, or per series). [S, behaviour]
- The web app shows cards in **Visualizations** for projects without visualizations only when a run of the batch
  was started from code (`data.sdk`): a `series.jsonl` written by another program needs an `outputs.visualizations`
  entry. `data.dirty` is recorded, not shown. The implicit "Logged series" view isn't in the View options. [S, behaviour]
- The Summary's comparison of runs' series (`SeriesComparison.jsx`) downloads one `series.json` per run, up to 40,
  only for runs started from code; which runs are hidden and the color-by parameter aren't in the URL; averaging
  the runs of a group (mean and spread over seeds) isn't done. [M, behaviour]
- In notebooks, `capture_output` wraps `sys.stdout` and `sys.stderr` until `finish()`. [S, behaviour]
- `Run._new` (qaboard/results.py) was the placeholder for this: `ActiveRun.run` builds its `Run` itself, and only
  tests use `_new`. [S, no change]

## Results sent over HTTP (`storage: upload`, `qa upload`, November 2026)
Design: `docs/design/ingest-upload-sdk.md`. Tested with unit tests and a fake server (`tests/test_upload*.py`,
`tests/test_active_run.py`, `backend/tests/test_uploads.py`), and end to end in CI's `docker` job
(`.github/scripts/uploads_e2e.py`: `qa upload`, `start_run()` and `qa --share run` with `QA_STORAGE=upload` against
`docker-compose.yml`'s defaults, through nginx and the image server); **not** on Windows, nor on any object storage
mount.

- The end-to-end test doesn't cover `qa check-bit-accuracy` against an uploaded reference, nor heartbeats (a run
  killed mid-way). [S, no change]
- What `qa run` prints after its files are sent (that some couldn't be sent, that the server refused the results)
  isn't in the *log.txt* the server has: files are sent before the run is said to have ended, and don't change
  after. [S, behaviour]
- `qa upload` keeps a copy of what it sends in the project's (or the current folder's) *output/*, like any shared
  run: CI workspaces don't mind, laptops may. [S, behaviour]
- A first security review found that run folders were built from clients' input paths ("../" led to other projects'
  files): fixed, with tests (`backend/tests/test_uploads.py`). The endpoint deserves a second, independent look
  before servers that accept files face the internet. [M, no change]
- Files a run removed after they were sent (`outputs.live`) stay on the server. [S, behaviour]
- A run killed without a chance to say so (SIGKILL, a lost machine) is failed after
  `QABOARD_SILENT_RUN_TIMEOUT_MINUTES` (`backend/backend/heartbeats.py`), with the files it sent: only runs from
  clients that send heartbeats, and only when the jobs worker runs. Its files are not cleaned. A run the server
  never heard of isn't sent later. [S, behaviour]
- No quotas per project, no deduplication (a bit-accurate rerun sends everything again), no resume inside a file:
  files over `QABOARD_UPLOAD_MAX_FILE_MB` are refused. [L]
- `qa batch` with cluster runners only works when the nodes share the working directory with the machine that
  starts the batch, or on Kubernetes with an image per commit. Runs started from the web app (tuning, redo) run from
  the artifacts `qa save-artifacts` sent, with a token per batch, on the server's machine or Kubernetes only: not
  with the LSF or Celery runners. Tokens are revoked when the batch's last run ends or it is stopped, except
  `qa optimize`'s (it starts batch after batch): they expire a day after its runs stop. On Kubernetes, the driver pod
  gets the batch's files in its ConfigMap (1 MiB at most) and sends its log with the token: once the runs ended
  and the token is revoked, the rest of the log is only in the pod's logs; `qa optimize` can't resume an experiment
  started again (its journal stays in the pod). See `docs/design/ingest-upload-sdk.md` §3 item 2. `qa check-bit-accuracy`
  compares fetched manifests only, not files (`QA_BITACCURACY_CMP`); `qa optimize` keeps its journal on the machine
  that runs it. `qaboard.runs(url)` gives uploaded runs' `output_dir` on the server, not a local folder. [L]
- Storage locations (`backend/backend/locations.py`) are reached through folders the admin mounts: no credentials,
  no native object storage access, and no web app page yet (`qaboard-admin storage-locations`). The storage scans,
  storage usage per folder, and the file browser's listing only know `QABOARD_STORAGE_ROOTS` and the upload root:
  runs in a location are measured and deleted, but their folders are never scanned for orphans. Clients can't yet
  write to a location directly (a cluster that mounts the bucket still uploads). [M]
- For a project with `storage: upload`, the folders the server derives from storage settings (a commit's or a
  batch's folder, `Project.storage_roots`) are under the upload root, with the shared storage's layout: nothing is
  there. Runs' own folders are always the ones saved with them (`output_dir_override`). [S, no change]
- `examples/software-quality/qa/junit.py` and `qaboard/junit.py` read reports the same way, twice: the example is
  meant to be copied. [S, no change]
- `/iiif/` doesn't check who asks, and `/s/` only where the deployment restricts files (`SECURITY.md`): uploads
  don't change that, but they make servers reachable from more places. [M, behaviour]

## Runners (Kubernetes, Dask on any scheduler, `qa doctor`, November 2026)

Design and follow-ups: [docs/design/kubernetes-runner.md](docs/design/kubernetes-runner.md). Security boundaries are
documented for admins in `website/docs/backend-admin/runners.mdx`: we rely on the cluster's own tools (namespaces,
Pod Security, admission policies, Kueue/ResourceQuota) rather than re-implementing them.

### What was verified, what wasn't
- Real: the Kubernetes runner on a kind cluster (`.github/scripts/kubernetes_runner_e2e.py`, CI job
  `kubernetes-runner-e2e`), Dask with `cluster.type: local`, a real Celery worker for stopping batches
  (`tests/test_celery_stop.py`), backend integration tests on Postgres for stop/tuning/redo. The server starting and
  stopping batches on kind, installed with the Helm chart, for a project without a shared storage
  (`.github/scripts/helm_e2e.py --kubernetes`, CI job `helm-e2e`).
- Only with fakes/mocks: LSF, Slurm, PBS, SGE, HTCondor, OAR and Moab commands (submit, cancel), Jenkins, Dask on
  Kubernetes (`KubeCluster`), the server starting batches on a cluster with a shared storage. Try them on a real cluster before
  advertising them. `run_as: user` with a non-root UID first runs for real in CI. [M, no change]

### Kubernetes
- **A namespace is a trust domain** for batches started from the web app: the driver pod runs the project's code with
  a ServiceAccount that can create Jobs, so users who start batches in a namespace can act as each other (documented;
  `QABOARD_KUBERNETES_RUN_AS=<uid>:<gid>` runs them all as one account). Real per-user isolation: the backend creates
  the run Jobs itself, the driver calls back with a per-batch credential (design doc, "Follow-ups"). [L, API]
- Without a shared filesystem, `qa batch` needs an image per commit (`{commit}` in `image`, with `workdir`) and
  `storage: upload`; inputs still come from mounts or the user's code. Batches started from the web app still need
  a shared storage, or the artifacts `qa save-artifacts` sent: the pods download them, once per pod. Images per commit are looked up in their registry with pull
  secrets or `docker login` only (no credential helpers, no cloud IAM: ECR/GCR/ACR without a pull secret read as
  "can't tell"), once, without waiting for a CI that is still pushing; `--prefix-outputs-path` isn't mapped to
  `workdir`. [M, API]
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
- Image pulls that keep failing for a pod fail the batch after 5 minutes, unless pods of its Job run or ran (a node's
  problem); waiting in a Kueue queue is never fatal. A fatal problem deletes all the batch's Jobs, also the groups
  whose pods run fine: the batch fails as a whole, like with Ctrl-C. [S, behaviour]
- The per-run `timeout` needs GNU coreutils' `timeout` in the image (BusyBox's is refused: it signals only its child):
  no portable fallback (killing `qa run` and what it started needs a process group). `qa doctor --test-job` checks
  it, and runs fail saying so. [S, behaviour]
- Why pods are pending is in the runs' `log.pending.txt` (and `log.pending.txt` next to a detached job's `log.txt`).
  When the pods run as another user than `qa batch`, it only writes there if the output directory exists (creating it
  would make it ours). A note written just as the pod starts can stay behind (the pod deletes the file when it
  starts). The server shows a driver's note only for a day after it's submitted: it doesn't follow drivers, whose
  submissions stay "submitted". [S, behaviour]
- The server only stops batches in namespaces listed in `QABOARD_KUBERNETES_NAMESPACES` (otherwise a warning), and the
  pending driver pod is only watched for 20s after it's submitted. When the driver fails to start in those 20s, the
  server deletes only its Job (`qaboard.io/role=driver`), like after: run Jobs its `qa batch` may have created keep
  running until the batch is stopped. [S, behaviour]

### Dask on other schedulers
- `--no-wait` and server-side stops on Slurm/PBS/SGE/HTCondor/OAR/Moab need those commands where the driver or the
  server runs; the backend image doesn't ship them. Old Torque truncates job names over 15 characters; Moab is assumed
  to run on Torque/PBS. [M, no change]
- OAR: the driver can't receive the environment (OAR has no option for it), and dask-jobqueue's 30-minute walltime
  stays unless `walltime` is set (`qa doctor` warns). [S, behaviour]
- Dask on Kubernetes needs the Dask operator; `KubeCluster` can't pick a kubeconfig context (only the current one);
  the scheduler pod asks for 1 CPU and 2Gi. [S, behaviour]
- The Dask scheduler is unauthenticated, and the tasks it holds carry the runs' environment, secrets included: the
  docs give a NetworkPolicy, which only helps on clusters that enforce them, and not between users of a namespace.
  Real fix: distributed's TLS security (a certificate per batch, in a Secret the pods mount). [M, behaviour]

### Celery and runs on the server
- From the server, stopping Celery batches only reaches the server's broker (`CELERY_BROKER_URL`): batches sent to a
  team's own broker or vhost keep running (broker URLs from batch data can't be trusted). [M, behaviour]
- Workers remember revoked tasks in memory: a worker started after a stop may still run the batch's queued tasks,
  unless workers use `--statedb`. Terminating running tasks needs Celery 5.3+ and the prefork pool. [S, behaviour]
- `qa batch` started by the server (`QABOARD_TUNING_RUNNER=local`/`celery`, and redo without the LSF bridge) runs as a
  detached process of the backend container: another replica can't stop it, and redeploying the backend kills it.
  Running projects' code on the server trusts every project developer with what the server's account can read (the
  environment is scrubbed, files aren't). [M, behaviour]

- Batches started from the web app through the LSF bridge get no QA-Board token (the bridge doesn't pass the server's
  environment): on a server with `ingest.auth: token`, their runs can't save results unless a shared HOME holds a
  `qa auth login`. The other runners get the batch's token (`tokens.mint_for_batch`). [S, API]
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

- Several references together (the image viewer's default once two references are stacked, "One at a time | Together"
  after the reference tabs, December 2026): only the image viewer shows them; every other viewer (videos, plots, text,
  benchmarks, flame graphs...) and the metrics still compare with the selected reference only. [L, behaviour]
- Since Together is the default, each stacked reference that stays ticked loads all its runs (slow for commits with
  thousands of runs), and adds one or two tiled image viewers per run card: past a handful of references, the page gets
  slow. Loading only the runs matched to the cards shown would help. [M, no change]
- "How far apart" in the image viewer is the mean difference of the displayed views (8-bit, at screen resolution), not
  of the files: a guide, not a bit-accuracy check. Images with another aspect ratio than the anchor's are compared at
  the same width, so their bottoms don't match. [M, behaviour]

## Deployments, services, charts

- **PostgreSQL 12 is EOL** (compose, production.yml): upgrade with dump/restore (known-issues.md). [M, behaviour]
- **RabbitMQ 3 is EOL**: move to 4.x after `rabbitmqctl enable_feature_flag all` (known-issues.md). [S, behaviour]
- **Python 3.14 for the backend image**: builds (November 2026); change `backend/.python-version`, the site-packages
  path in `backend/Dockerfile` and CI's matrix together. [S, no change]
- **Cantaloupe**: drop `services/cantaloupe/logback.xml` with 5.0.9. 5.0.6 fixed TurboJpegProcessor's 415 on
  non-JPEG output: check whether `ManualSelectionStrategy` in `cantaloupe.properties` is still needed (keep Java2d
  for JPEG: the pixel tooltip and diffs need exact values). [S, no change]
- nginx's `/iiif/` sets `X-Forwarded-Host $host:$server_port`: Cantaloupe gets the container's port, not the published
  one (e.g. :80 instead of :5151), so `info.json` ids may be wrong behind port mapping. The chart has the same lines. [S, behaviour]
- The `pgadmin` volume is mounted at `/root/.pgadmin`, but the image keeps its data in `/var/lib/pgadmin`: nothing
  persists (pgAdmin sets itself up again when its container is recreated). [S, behaviour]
- `deployments/sirc/sirc.yml` mounts `/data:/data` in Cantaloupe instead of `/repository/data` (Cantaloupe is disabled there). [S, no change]
- `.gitignore` lists `drafts/`, which moved to `deployments/sirc/runbooks/`, and ci.yaml's path filter still names it. [S, no change]
