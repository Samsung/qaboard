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

- **Users' files are served in QA-Board's origin**. `QABOARD_SANDBOX_HTML` (on by default since November 2026)
  sandboxes their HTML, SVG and XML (`services/nginx/conf.d/qaboard-files.conf`, the HTML and plotly viewers):
  in the web app's frames their scripts run in an origin of their own, opened in a tab they show without scripts, so
  their images still load with the session where files are restricted. Sites that turn it off get stored XSS. Next,
  serve the storage from another host name (e.g. `files.<qaboard>`, with its own sign-in handoff): reports opened in
  a tab could run their scripts too, and the class of bugs goes away. [L, behaviour]
- **Anonymous results**: where `ingest.auth` is `off` or `warn` (the default is `token` since November 2026), anyone can send results to any project, and through
  the `qaboard_config` they send, add hosts to the integrations' allow-list or Jenkins jobs that anonymous `qa` may start.
  They can also replace existing runs, sent with a token or not: runs are found by what anyone can read about them
  (`Output.get_or_create`), and the anonymous request repoints the run's folder. Only runs that sent their files over
  HTTP are protected (403 `ingest_token_required`). Per-project ingest policies and CI OIDC trust are milestone M5 (docs/design/user-management.md). [M, API]
- The image and webhook proxies only check certificates with `web.proxy_verify_tls` (`QABOARD_PROXY_VERIFY_TLS`), off
  by default so that existing installs keep reaching internal hosts. Turn it on for new installs: it needs a way to tell
  them apart, e.g. the setup flow (first_admin.py) saving it. [S, behaviour]
- The GitLab "play job" endpoint doesn't check that the job is listed in qaboard.yaml (GitHub workflows do): left out so
  that integrations defined only on branches keep working. [S, behaviour]
- `deployments/sirc/metabase.yml` has default passwords (`metabase`, its database and backups) and publishes Metabase's
  database on 5434 of docker-prod-srv-1. Read the password from `.env` (`MB_DB_PASS`, `POSTGRES_PASSWORD`) after an
  `ALTER USER metabase PASSWORD ...`, and drop the port (or bind it to 127.0.0.1) once nobody connects from elsewhere. [S, behaviour]
- **pgAdmin** (`dpage/pgadmin4:9`, which pulls 9.19 since October 29): 9.18 only trusts `X-Pgadmin-User` from
  `WEBSERVER_TRUSTED_PROXIES` (sirc.yml sets it), but 9.19 no longer signs webserver users in to an *internal* account
  of the same name, which is how SIRC signs every admin in (the default account, `api/admin_services.py`, with
  `WEBSERVER_AUTO_CREATE_USER=False`). Check `/pgadmin4/` at SIRC: if it's refused, pin `dpage/pgadmin4:9.18` there
  or let pgAdmin create a webserver account that owns the server. Then pin the version, and set
  `WEBSERVER_SHARED_SECRET` (nginx sends it in `X-Pgadmin-Webserver-Secret`, services/nginx/snippets/pgadmin.conf). [S, no change]

## Backend

- **celery is held at 5.6** in backend/uv.lock: 5.7 still pulls python-dateutil back to 2.9 (checked November 24).
  Retry `uv lock --upgrade-package celery` when its constraints relax. [S, no change]
- The backend still uses ~220 legacy `Model.query` calls: SQLAlchemy 2.1 keeps them, but `select()` is the way
  forward if a future version deprecates them. [L, no change]
- **History page with outputs** is ~1.4 s and 20 MB for 25k outputs (backend/benchmarks/bench_api.py, 2.5 s before
  outputs were serialized from SQL rows, `outputs_of_batches` in models/Output.py). What's left: aggregating 6 metrics
  (~0.7 s, see "Aggregated metrics" below), serializing (~0.4 s) and `ujson.dumps` (~0.15 s). Trimming what's sent, or
  paginating outputs, needs the web app's history to change. [M, API]
- `GET .../manifest?refresh=true` writes manifests (api/outputs.py; signed-in users only, never for uploaded runs that ended): make the refresh a POST, with OutputCard.jsx's. [S, API]
- `trigger_jenkins_build` holds a uwsgi worker for 5-30 s (sleeps, then polls Jenkins' queue), and `jenkins_build` retries
  with nested bare `except`s. The status check fails with a 500 while a build is queued (no `building` in a queue item). [M]
- Commit search uses `ILIKE` over the project's commits (~40 ms for 5k commits). For projects with 100k+ commits, add
  `pg_trgm` GIN indexes on `message`/`branch` (needs `CREATE EXTENSION pg_trgm`). [S]
- **Aggregated metrics are the main cost of the commit lists**: in bench_api.py, "commits: last 3 days + metrics"
  (327 commits, 187k runs, 4 metrics) takes 1.2 s, 1.55 s on the table the migration left bloated (2-2.2 s while
  `outputs.metrics` was JSON text, before d3f5b7c9e1a4). ~0.9 s are `batches_stats`'s query: reading the 4 keys from
  the JSONB (~0.3 s), converting them to numbers (~0.25 s), the medians (~0.15 s). Aggregates computed once when a
  batch's runs end, kept in the batch, would remove it. [L]
- The JSONB migration (d3f5b7c9e1a4) adds a `json_typeof(jsonb)` function, so that older versions' queries keep
  working on the converted column (rollbacks, rolling deploys); models/Output.py adds it to new databases. Drop both
  once versions from before November 2026 are no longer supported. Metabase questions written with `json_*`
  functions on `outputs.metrics` need `jsonb_*` now. [S]
- `protected_ref_commits` (models/Project.py) runs git commands on every access (it opens the clone once: ~40 ms with
  3000 tags). Webhooks' commit deletion calls it for each commit. [S]
- Project ids and clones are not qualified by host: two hosts with the same `group/repo` share a project. Tokens are
  shared by all users (no per-user OAuth). See docs/git-hosts-roadmap.md. [L, behaviour]
- Gitea's avatar URL, the Bitbucket signature header and the Gitea/Bitbucket payload fields were written from their docs
  and tested on sample payloads only: check them against real servers. [S]
- If `QABOARD_GIT_HOSTS` points to a file the kubernetes migration Job doesn't mount, the backend fails to import and
  the migrations Job fails (it used to stamp the database and skip the migrations silently). [S]
- Logs (backend/logs.py): most modules still `print()` (api/integrations.py, api/tuning.py, clean.py, runner_jobs.py,
  sign-in, git_utils.py, the scripts...): they reach `docker compose logs` without level, time or request id, and not
  as JSON. Move them to `logging.getLogger(__name__)` when touching them. nginx neither sends the backend an
  `X-Request-ID` nor logs the one the backend returns, so its access log and the backend's don't share ids yet
  (`uwsgi_param HTTP_X_REQUEST_ID $request_id;`, and `$upstream_http_x_request_id` in its log format). [S]
- `GET /api/v1/git/proxy` (api/integrations.py, the avatars from gravatar) answers 500 with a traceback when the
  server can't reach the host (seen behind a proxy that blocks gravatar.com, with scripts/dev.py): a 502 or 404,
  without logging a traceback, would do. [S]

## CLI

- Reruns' directories (qaboard/attempts.py): `qa batch` writes *latest_attempt.txt* when it reserves a new attempt
  (`reserve_or_keep`), before the job starts. While the job waits in a queue (LSF...), or for good if it never starts
  (batch killed, job lost), `latest_dir()` and its readers (`qa batch --list-output-dirs`, `qa get output_dir`,
  `qa check-bit-accuracy`, run.py's `RunContext`, scripts reading the pointer) get the new, empty directory, while
  the complete results are still in the previous attempt. Why it isn't a quick fix:
  - `qa batch` matches the server's runs to its own by directory (`url_to_dir(o['output_dir_url']) ==
    run_context.output_dir`, after `latest_dir`): the server records the reserved directory for pending runs, so a
    second `qa batch` would stop seeing them pending, and start them again, unless the pointer says so, or matching
    is by run id.
  - The job's `qa run` must get the attempt `qa batch` picked: the command line is the only channel every runner has
    (local, lsf, celery, dask, kubernetes, windows), but a new `qa run` option breaks workers and Windows nodes with an
    older `qa`, and `VAR=x qa run` isn't valid in cmd.exe. Then `qa run` writes the pointer when it starts.
  - `_next_attempt` skips the directories that exist (runners' logs create them before the job starts): it would
    have to skip only those where a run started, and two attempts queued at once must not move the pointer back.
  Tests need: a queued job (pointer still on the previous attempt, which `--list-output-dirs` gives), its start
  (pointer moves), a job that never starts, two batches submitting the same run. [M, behaviour]
- Internal names left in `qaboard/`: compat.py's `\\netapp\vol23_algo` -> `vol24_algo` rewrite of inputs' paths
  (`linux_to_windows`) is one site's: it belongs in its site package (like `QABOARD_PATH_MAPPINGS`), which needs a new
  site setting and a release of the site package before `qa` drops it. [S, behaviour]
- Logs (qaboard/log_setup.py): `QA_VERBOSE` still prints with `click.secho` in api.py, config.py, analytics.py and
  qa.py (payloads, answers): move what is diagnostics to `logger.debug`. Config resolution happens on import of
  qaboard/config.py, before `-v` is parsed: `qa -v` logs a summary of what it resolved, not each step. Requests that
  don't go through http_client.py log only when they pass `hooks=LOG_HOOKS` (doctor.py, gate.py, optimize.py,
  credentials.py, the Jenkins runner don't yet). [S]

## Runs created from code (`qaboard.start_run()`, November 2026)

`qaboard/active_run.py`, `qaboard/series.py`. Design: `docs/rfcs/python-sdk-runs.md`. Follow-ups (a
run-centric page, screenshots for the docs, gaps against experiment trackers): `docs/rfcs/python-sdk-runs-follow-ups.md`.

- Verified end to end only without a shared storage (CI's `docker` job, `.github/scripts/uploads_e2e.py`); with a
  shared storage, the SDK's tests use an HTTP server that records requests, the backend's mock the database. In
  Jupyter, checked by hand (November 2026: `jupyter nbconvert --execute`, ipykernel 7.4, against the tests' fake
  server): a cell run twice ends the first run, a run left running ends with the kernel, each cell's output shows
  under it. Not on Windows, or with a site package. [M, no change]
- Without `project.reference_branch`, the reference is the repository's default branch: the git server's webhooks', else
  the first one a run sends (`project_default_branch`, kept in `project.data.git`), else `main`
  (`backend/backend/reference_branch.py`, `qaboard/config.py reference_branch`). A renamed default branch isn't
  followed, and clients without `origin/HEAD` (a fresh `git init`, some CI checkouts) say `main`, while the server may
  know another. Runs outside git all go to one placeholder commit per user, `<local:user>`, which compares with
  nothing. [S, behaviour]
- What `start_run()` chose (`active_run.defaults_chosen`) is said once per process: a Jupyter kernel that changes
  project or directory isn't told again. [S, no change]
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
- In notebooks, `capture_output` wraps `sys.stdout` and `sys.stderr` until `finish()`: what every cell prints meanwhile
  goes to the run's log.txt too. The wrapper passes ipykernel's `set_parent()` on (`TeeStream.DELEGATED`), not other
  attributes of the stream it wraps. [S, behaviour]
- `Run._new` (qaboard/results.py) was the placeholder for this: `ActiveRun.run` builds its `Run` itself, and only
  tests use `_new`. [S, no change]

## Local changes (`data.local_changes`, `qa restore`, November 2026)
Design: `docs/rfcs/local-changes.md` ("Later" lists the features left out).

- Each run of a local `qa batch` runs `git status` again to check the batch's fingerprint: on a repository where
  status takes seconds, a 1000-run batch pays it 1000 times. Pass the fingerprint check only to runners that read
  the working tree, or trust the batch's capture for a few seconds. [S, behaviour]
- A `qa run` whose first request to the server failed saves no patch: it only talks to the server again when it ends
  (heartbeats don't get the server's level). `start_run()` saves it once a later request gets through. [S, behaviour]
- The counts and the patch are two `git diff` passes (each runs git-lfs's filters again): compute the numstat from
  the patch when it is kept. [S, no change]
- With a storage shared with the server, `qa` writes the patches itself: `runs.local_changes` is followed by `qa`,
  not enforced. Only uploads are refused. [M, behaviour]
- Changes inside submodules aren't recorded (`--ignore-submodules=dirty`): say which submodules have changes. [S, behaviour]

## Logging with W&B and MLflow code (`qaboard/integrations/`, November 2026)

`qaboard/integrations/wandb/` (drop-in, `mirror()`, `python -m`), `qaboard/integrations/mlflow/` (tracking store
plugin, `qaboard:` and `qaboard+<uri>`). What QA-Board lacks as a product is in the compatibility matrices of
`website/docs/from-wandb.mdx` and `from-mlflow.mdx`, and said at runtime through `_common.Unsupported`: keep the three
in sync. Limits of the shims themselves:

- Both use private parts of `active_run.py`: `_summaries` (wandb's `define_metric` after the start), `_series.last_step`,
  `_default_input`, `_metric_value`, `_jsonable`, and install `start_run()`'s exit hooks early (a run first started at
  exit can't register atexit hooks). Make them public, or a small `ActiveRun.set_summary()`, before a third shim. [S, behaviour]
- Runs start lazily (at the first metric, log, artifact or end) so that the config or params set after `init` are
  part of the identity: *log.txt* misses what was printed before. [S, behaviour]
- MLflow: all params logged before the first metric become configurations (`QABOARD_MLFLOW_CONFIGS` narrows them):
  autolog's dozens of params make long configurations. Params are parsed back to numbers. [S, behaviour]
- MLflow standalone: reading runs or artifacts of other processes raises; `synchronous=False` is logged synchronously.
  Mirror: `get_tracking_uri()` and artifact URIs show the `qaboard+`/`qaboard-artifacts:` forms; a hand-written
  `mlflow-artifacts:/` URI doesn't resolve; no Databricks. Checked by hand against MLflow 3.18.0 (November 2026, the
  tests' fake QA-Board server): `qaboard:`, `qaboard+sqlite:`, `qaboard+file:` (MLflow 3 wants
  `MLFLOW_ALLOW_FILE_STORE=true` for any `file:` store) and `qaboard+http:` to a local `mlflow server`, with params,
  tags, metrics with steps, `log_text/dict/image/table/artifact`, `get_run()` and a failed run; the tests pass with it.
  `MirrorRegistry` was checked once, against an MLflow 3.18 server. [M, behaviour]
- Only Python clients: MLflow's R/Java/REST clients would need the server to accept MLflow's REST API
  (`docs/rfcs/python-sdk-runs-follow-ups.md` D). [L, decide]
- wandb: when wandb isn't installed, the runner puts the shim in `sys.modules['wandb']`: libraries that probe for
  wandb (Transformers' `report_to`) may think it's installed and reach submodules the shim lacks (warned no-ops).
  `WANDB_MODE=offline` keeps the QA-Board run local too. A bare `sys.exit(3)` after `mirror()` or the drop-in import
  ends the run as finished (with `python -m` or a `with` block it is failed). Tests use a fake wandb (`TestRunner` is
  skipped where wandb is installed). Checked by hand against wandb 0.31.2 (November 2026, `WANDB_MODE=offline`, the
  run made shared by the test script): `python -m` (exit codes, an exception), `mirror()`, `define_metric`, summary,
  artifacts, `alert`, and without wandb installed. [S, behaviour]

## Logged media (`qaboard/media.py`, `webapp/src/viewers/media/`, November 2026)

`run.log()` with `qaboard.Image/Audio/Video/Table/Histogram/Text/Html/Plotly/File`, `run.log_media()` and
`log_image/audio/video/table/histogram/text()`; the card's **Logged media**; the audio viewer. Format: the docstring
of `qaboard/media.py`, tested with the web app's parser on `tests/fixtures/media/`.

- Every logged item is a file, kept: nothing downsamples media like `series.json` does series. A training that logs
  a batch of images at every step fills the storage, and *media.jsonl* (read whole by the web app, histograms inline)
  grows: 1000 steps of 50 histograms of 64 bins is ~20 MB. Keep at most N steps per key in the web app's view, or
  thin out old steps. [M, behaviour]
- Files are written synchronously by `log_media()` (encoding included): a big batch of images slows the step it is
  logged at. A writer thread, like the series'. [S, behaviour]
- Boxes are kept simple, to be redesigned: one list per image, `group` and `label` as texts, no class ids or
  per-class colors and toggles. Masks aren't kept (wandb's `masks=` is said once). [M, decide]
- Videos from frames are GIFs, with Pillow: no MP4 encoding (it needs ffmpeg). [S, behaviour]
- MLflow: `log_image(key=, step=)` keeps one image per key and step (index 0, the last wins); `log_table` is a table at
  the run's last step, re-logged when MLflow appends to it; *.parquet* tables are only files. Tests write MLflow's
  files themselves (`key+step+N+timestamp+T+uuid.png`, `~` for `/`, and the 2.x `%` form): its `log_image` needs
  Pillow. Checked by hand with MLflow 3.18.0's own `log_image(key=, step=)` and `log_table`, standalone and mirrored.
  [S, behaviour]
- wandb: `wandb.plot.*` charts are logged as their tables, not drawn; `Object3D` and `Molecule` from data aren't
  kept; the real wandb's private attributes (`_path`, `_image`, `_boxes`, `_sample_rate`) are read: tests use a fake
  wandb. Checked by hand against wandb 0.31.2: images from arrays, files and Pillow with boxes (`minX`... and
  `middle`/`width`/`height`, pixels and fractions) and masks (said, not kept), audio and videos from data (wandb itself
  needs soundfile and moviepy for them), `Html`, `Plotly`, `Histogram`, a `Table` with image cells, `plot.line_series`.
  [S, behaviour]
- Only runs started from code log media: `qa run`'s `run()` has no `context.log_media()`. They can write
  *media.jsonl* themselves, but the card shows **Logged media** only for runs with `data.sdk`. [S, decide]
- `qaboard.runs(url)` runs have `series()`, not `media()`: reading another run's media needs its folder. [S, behaviour]
- *media.jsonl* has the times things were logged: bit-accuracy checks see differences, like with *series.jsonl*. [S, behaviour]
- While a run goes on, the uploader lists and stats all of *media/* every 10 seconds (only for runs with a
  *media.jsonl*): with 10^5 files on NFS, send the files the new lines of *media.jsonl* list instead. [S, behaviour]
- A run that isn't resumed starts a new *media.jsonl* but leaves old *media/* files there when it was given its folder
  (`start_run(output_dir=...)`; QA-Board's own folders are emptied): not listed, but uploaded. [S, behaviour]
- Keys are made safe for paths (`media.safe_key`), but not for Windows' reserved names: a key `aux` or `con/x` can't be
  saved there (not tried: nothing was run on Windows). [S, behaviour]
- MLflow: in mirror mode, `mlflow/run_id` and `mlflow/url` differ in every run, so the card and the "vs. reference"
  callout show them as changed settings: params that describe a run rather than configure it need a place of their
  own (run metadata, or a prefix the params diff skips). `log_metric()` without a step is a one-point series at step
  0, plotted full size next to the curves: don't plot series of fewer than 2 points. [S, behaviour]
- Every series is a metric (its last value), the learning rate too: a cosine schedule's run shows `lr 0` in its
  metric chips. Default `summary="none"` for names like `lr`, or let shims mark them. [S, behaviour]
- The demo stack's runs log every key at the same steps as their reference: the "from step N" chips, reference-only
  keys and the timeline's separate rows never show in its screenshots. Seed one pair whose reference logs at other
  steps and one key only the reference has (`docs-media/demo/local-stack/project/train.py`). [S, no change]
- Maintenance, later: split `qaboard/media.py` into encoders (Image, Audio... with png/wav) and storage (MediaLog,
  read_media); `Table.encode()` raises while `MediaLog._prepare` special-cases tables (let tables encode their cell
  files); `Html`/`Text` tell paths from contents by heuristics (an explicit `path=`); `FullAudioViewer` (~260
  lines): extract its zoom window, region drag and shortcuts; `test_logging_media` is one 50-line script in a
  subprocess (split the warn-and-skip cases from the API's shape). [S, no change]
- The local stack (`docs-media/demo/local-stack/`) assumes Debian or Ubuntu as root (bind mount, `runuser`,
  `/usr/lib/postgresql`, `/mnt/qaboard`), and its ports and defaults are repeated in its scripts: a non-root path
  (`pg_ctl` on `PATH`, results under the stack folder) and one `stack.json` that `stack.py up` writes. [S, no change]
- Web app: the evolution strip and the contents' thumbnails are for images only; `space` swaps which of new and
  reference comes first, it isn't an in-place flip; `f` opens the sample inline, not full screen. [S, behaviour]
- Web app: clicking a series plot to pick the media's step is checked in a browser only (Plotly doesn't run in
  jsdom): a Playwright check on the demo stack would keep it. The series' cursor uses the reference's media steps
  only when the series view gets the reference run (it has the series file too). [S, behaviour]
- Web app: the image viewer draws a set of regions over every image it shows, not per side: the new and reference
  runs' boxes are two sets ("Boxes of <name>"), one shown at a time. [S, behaviour]
- Web app: keys render lazily with placeholders sized from width and height, not a virtualized list; up to 40 images
  of the neighboring steps are prefetched. The audio viewer decodes and draws on the main thread (~2 s for 10 minutes
  of stereo 48 kHz): a worker. [S, behaviour]
- The step and the opened sample are in `?controls=` (`media_step`, `media_focus` with the run's id), not in
  `src/selection.js`: several cards on a page would collide on a page-level key or sample. [S, decide]
- Web app, narrow windows (~700 px): the app's sidebar doesn't collapse by itself, so a run card gets ~460 px; the
  section fits in it (it wraps and scrolls its tables) but shows little. Collapsing the sidebar under a width is the
  app's. Hovering the timeline previews the new run's first image only, small: new and reference, wider. [S, behaviour]
- Web app: without an image server, or when it can't read a file, the image viewer shows the file as the browser
  decodes it (PNG, JPEG, WebP, GIF, AVIF, BMP): no tiles (a big image loads whole), and region thumbnails, which are
  IIIF, stay empty. TIFFs and raw formats still need the server. [S, behaviour]

## Results sent over HTTP (`storage: upload`, `qa upload`, November 2026)
Design: `docs/design/ingest-upload-sdk.md`. Tested with unit tests and a fake server (`tests/test_upload*.py`,
`tests/test_active_run.py`, `backend/tests/test_uploads.py`), and end to end in CI's `docker` job
(`.github/scripts/uploads_e2e.py`: `qa upload`, `start_run()` and `qa --share run` with `QA_STORAGE=upload` against
`docker-compose.yml`'s defaults, through nginx and the image server, `qa check-bit-accuracy` against an uploaded
reference, a killed run failed by the heartbeats, batches started from the web app); **not** on Windows, nor on any
object storage mount.

- `qa upload` keeps a copy of what it sends in the project's (or the current folder's) *output/*, like any shared
  run: CI workspaces don't mind, laptops may. [S, behaviour]
- Left by the security reviews of the endpoints that write files (first three in `backend-admin/uploads.mdx`):
  - uploaded HTML, SVG and XML run as the people who open them where admins turn `QABOARD_SANDBOX_HTML` off. `/s/`
    sends `nosniff` [S, behaviour];
  - with `QABOARD_TUNING_RUNNER=local` or `celery` (opt-in, warned about in Admin → Settings), anyone who can send a
    project's artifacts or start its batches runs code as the backend's account and reads its files (only the
    environment is scrubbed) [M, behaviour];
  - no limit on the number of files or a project's bytes (inodes, quotas), and the free-space check isn't atomic
    with concurrent uploads [M];
  - a redo's token can write any running run of the batch it redoes (same commit and label, e.g. CI's runs in it),
    not only the redone ones, and point its runs' `output_directory` anywhere under the storage roots (shared
    storage); reads of batch tokens stay project-wide; with a batch token, `POST /api/v1/commit/` answers OK and saves
    nothing, and the windows runner's status checks (`/jenkins/build/`) don't name the project, so they're not limited
    to its jobs (only the status comes back) [S, API];
  - in the chart, the backend's NetworkPolicy (`backend.networkPolicy`) keeps other pods from its uwsgi port only
    where the network plugin enforces NetworkPolicies (not checked on a cluster: no `helm template` run either); the
    ingress buffers bodies before nginx checks tokens [S];
  - commit ids aren't normalised: `CiCommit.get_or_create` looks them up case-sensitively and by prefix, so an
    upper-case or short id from a project token creates another commit (batch tokens need the exact full id, and
    never create commits or projects). Lowercasing for everyone would move shared-storage folders, which both the
    server and `qa` derive from the id as given, and orphan existing upper-case rows [S, behaviour];
  - the files pre-check (`snippets/qaboard-files-server.conf`, `/__qaboard/files-auth`) still passes the raw
    `$request_uri`, unlike the uploads one (`$uri`): switching needs `path_from_url` to stop decoding a second time,
    else `%252e` becomes `..` [S];
  - a SIGKILL (or uWSGI's harakiri) during a write leaves a `.qaboard-upload-*` file next to it: not served, and
    removed by the jobs worker after a day (only when it runs). [S]
  - files show as they arrive, and a run started again while its previous attempt still sends gets the old
    attempt's late files (`ingest-upload-sdk.md` §3 item 6) [S-M];
  - uploads share uWSGI's threads with the web app, with no limit per token (§3 item 4) [M].
- Files a run removed after they were sent (`outputs.live`) stay on the server. [S, behaviour]
- A run killed without a chance to say so (SIGKILL, a lost machine) is failed after
  `QABOARD_SILENT_RUN_TIMEOUT_MINUTES` (`backend/backend/heartbeats.py`), with the files it sent: only runs from
  clients that send heartbeats, and only when the jobs worker runs. Its files are not cleaned. A run the server
  never heard of isn't sent later. [S, behaviour]
- No quotas per project, no deduplication (a bit-accurate rerun sends everything again), no resume inside a file:
  files over `QABOARD_UPLOAD_MAX_FILE_MB` are refused. [L]
- `qa batch` with cluster runners only works when the nodes share the working directory with the machine that
  starts the batch, or on Kubernetes with an image per commit. Runs started from the web app (tuning, redo) run from
  the artifacts `qa save-artifacts` sent, with a token per batch, on Kubernetes or, when admins opt in, the server's machine only: not
  with the LSF or Celery runners. Tokens are revoked when the batch is stopped and expire 10 minutes after its last
  run ends, except `qa optimize`'s and redo's: they expire a day after their runs stop. On Kubernetes, the driver
  pod gets the batch's files in its ConfigMap (768 KiB at most) and sends its log with the token: what it prints
  after the token expired, that the server refused, beyond 4 MiB while the server is slow, or after 60 s at the end
  is only in the pod's logs (the log's first line says how to read them) [S]; `qa optimize` can't resume an experiment
  started again (its journal stays in the pod). See `docs/design/ingest-upload-sdk.md` §1 and §3 item 13. `qa check-bit-accuracy`
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
- `/s/` and `/iiif/` check who asks in the default nginx configuration and the chart (`snippets/qaboard-files-auth.conf`,
  `qaboard-iiif-auth.conf`, `proxy.restrictFiles`), not in sites' own configurations that leave the snippets out, nor
  on image servers hosted elsewhere (`QABOARD_IMAGE_SERVERS`, e.g. SIRC's). nginx keeps the image server's answers a
  minute per image and credentials: access removed takes up to a minute to apply to images. [S]

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
  the server rather than by `qa run` itself. `run_script` runs each run in a subshell (to count failures and redirect
  its log), so `exec` alone doesn't help: a `trap` in *run-N.sh* that forwards TERM to the running subshell's
  process group, or a tiny init. Check it on kind (`.github/scripts/kubernetes_runner_e2e.py`): unit tests only see
  the script's text. [S, behaviour]
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
- `qa batch` started by the server with `QABOARD_TUNING_RUNNER=local`/`celery` (opt-in since November 2026) runs as a
  detached process of the backend container: another replica can't stop it, and redeploying the backend kills it.
  Tuning with `lsf` and no bridge still runs `bsub` from the server's container. The web app doesn't know that a
  server starts no batches: its buttons stay enabled until the refusal comes back. [M, behaviour]
- Listing a batch's tests in the form (`POST /api/v1/tests/group`) runs `qa batch --list` with the project's code
  when its entrypoint defines `iter_inputs`: only with `local`/`celery`, in the scrubbed environment, synchronously in
  the request (240 s at most). With other runners the form can't count the runs (`unlisted`): it could ask the runner
  (a Kubernetes pod) instead. [M, behaviour]
- The backend restores artifacts with `qa save-artifacts` in a git worktree of the commit (`CiCommit.save_artifacts`,
  "Restore the artifacts"), with the server's full environment: it runs QA-Board's `qa` on the repository's
  *qaboard.yaml*, not the project's code. [S, no change]
- Batches started from the web app through the LSF bridge get no QA-Board token (the bridge doesn't pass the server's
  environment): on a server with `ingest.auth: token`, their runs can't save results unless a shared HOME holds a
  `qa auth login`. The other runners get the batch's token (`tokens.mint_for_batch`). [S, API]

### LSF
- The bridge template wraps `{bsub_command}` in single quotes: a job script containing a single quote breaks on the
  bridge host. Send the script through ssh's stdin instead. [S, behaviour]
- SIRC's `bsub_su` wrapper isn't in the repo (`deployments/sirc/runbooks/lsf-bridge.md`). The bridge path's
  environment isn't scrubbed like local dispatches. [S, no change]

### System metrics (`qaboard/system_metrics.py`, November 2026)
- Not tried on real clusters: LSF and Slurm cgroups, Kubernetes pods, NVML and nvidia-smi only through fakes in
  `tests/test_system_metrics.py`. Check a GPU job and an LSF job with cgroups, and a cgroup v1 node. [S, no change]
- `CUDA_VISIBLE_DEVICES` indexes are matched to NVML's indexes: CUDA counts the fastest GPU first unless
  `CUDA_DEVICE_ORDER=PCI_BUS_ID`, so on machines with different GPU models the run can be shown another GPU.
  Prefer the GPUs its processes use when they're known, and read `SLURM_STEP_GPUS`. [S, behaviour]
- `start_run(resume=True)` starts *system.series.json* over: its writer keeps no history to resume from. [S, behaviour]
- The process tree is found again at each sample (`psutil` `children(recursive=True)`, which reads every process of
  the machine): on hosts with thousands of processes, measure its cost. [S, no change]
- Older `qa` don't ignore *system.series.json* in bit-accuracy checks: mixed versions see differences. [S, no change]

### `qa doctor`
- No server version compatibility check (the server doesn't expose its version). CLI overrides like `--lsf-queue`
  and `QA_BATCH_LSF_*` aren't reflected in its checks. [S, behaviour]

## Webapp

- Under load (the full run on 4 cores takes ~7 minutes), tests that pass alone time out: `AppNavbar.test.jsx` ("arrow
  keys then Enter"), `ReferenceTabs.test.jsx` ("with one reference, users stack more", the 5 s test timeout). Lazy
  components found with `findBy*` need more than its default second (`loggedMedia.test.jsx` waits 5 s for the
  histogram view). A longer `testTimeout` and `asyncUtilTimeout` for the whole suite, or fewer workers. [S, no change]

- Several references together (the image viewer's default once two references are stacked, "One at a time | Together"
  after the reference tabs, November 2026): only the image viewer shows them; every other viewer (videos, plots, text,
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
- **Cantaloupe**: drop `services/cantaloupe/logback.xml` with 5.0.9. 5.0.6 fixed TurboJpegProcessor's 415 on
  non-JPEG output: check whether `ManualSelectionStrategy` in `cantaloupe.properties` is still needed (keep Java2d
  for JPEG: the pixel tooltip and diffs need exact values). [S, no change]
- nginx's `/iiif/` sets `X-Forwarded-Host $host:$server_port`: Cantaloupe gets the container's port, not the published
  one (e.g. :80 instead of :5151), so `info.json` ids may be wrong behind port mapping. The web app ignores them
  (`iiifTileSource` in webapp/src/image-viewer/sources.js), other IIIF clients don't. Use `$qaboard_forwarded_host`
  (conf.d/qaboard-forwarded.conf), after checking which of `X-Forwarded-Host`'s port and `X-Forwarded-Port` Cantaloupe
  uses. The chart has the same lines. [S, behaviour]
- The `pgadmin` volume is mounted at `/root/.pgadmin`, but the image keeps its data in `/var/lib/pgadmin`: nothing
  persists (pgAdmin sets itself up again when its container is recreated). Mounting it at `/var/lib/pgadmin` keeps
  admins' pgAdmin settings, but the entrypoint only loads servers.json and the passfile when it creates its database:
  a new `QABOARD_DB_PASSWORD` would then need the passfile copied again (website/docs/backend-admin/deployment.mdx). [S, behaviour]
