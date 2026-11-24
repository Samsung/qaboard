# qaboard/CLAUDE.md
The Python package: the `qa` CLI (`qa.py`, Click) and the SDK. Tests: `tests/` at the repo root (`uv run green tests`).
Cross-directory rules ("Change together"): root `CLAUDE.md`.

## Standalone modules
Projects import these from their code, so they import only the standard library (`TestIsolation` in each test file
checks it): `benchmarks.py` (+ `.metrics`), `flamegraphs.py`, `series.py`, `media.py` (+ numpy/PIL when the values
are theirs), `local_changes.py`, `system_metrics.py` (+ `.series`). The web app reads the same formats
(benchmarks, series, media): root `CLAUDE.md`.

## Runs from code (SDK)
- `qaboard.start_run()` creates runs from code that starts by itself (training loops, notebooks), without `qa run`:
  `active_run.py`. `plan_run()` says which run it would start (`qa --dryrun upload`). Without a qaboard.yaml it says
  once what it chose (`active_run.defaults_chosen`).
- Series it logs: `series.py`; media per step: `media.py` (*media.jsonl* and *media/*).
- Design and what's left out: `docs/rfcs/python-sdk-runs.md`, next steps `docs/rfcs/python-sdk-runs-follow-ups.md`;
  user docs: `website/docs/logging-from-code.mdx`.

## Sending results
- What `qa` and the SDK send with results is built in `payloads.py` only.
- `qa` always shares results (`config.default_share`: not with `--offline`, without a server, or without the storage
  here). `--share` is a hidden no-op.
- Reference branch: `reference_branch()` in `config.py`, in sync with the backend and web app (root `CLAUDE.md`).
- **No shared storage needed**: without `storage` in qaboard.yaml (or `storage: upload`), `qa run` and `start_run()`
  save runs in the project's `output/` and send their files (`upload.py`) to the server's `QABOARD_UPLOAD_ROOT`.
- `qa upload` (`upload_command.py`) is `start_run()` from the shell, for files other tools wrote; `junit.py` and
  `benchmarks.py` read their metrics, by the file names the web app's viewers recognize.
- Everything a run tells the server besides its results (files, heartbeats): `reporting.py` `RunReporter`, used by
  `qa run` and `start_run()`. Runs report at least every 2 minutes, else the server fails them (`heartbeat.py`).
- Requests go through `http_client.py` (retries only when a call asks for them); `api.notify_qa_database` and a few
  older callers still use `requests` directly. Refusal codes: `conventions.py` `Reason`, shared with the backend.
- A run's files fetched from the server, and their cache: `run_files.py`.
- `tests/test_active_run.py` has a fake server that answers like the real endpoints: change them together.
- Design and decisions: `docs/design/ingest-upload-sdk.md` (what's left: §3); limits: `docs/warts.md`.

## Local changes
Local runs record how their code differs from their commit (`local_changes.py`): a summary in `data.local_changes`,
the patches in the run's `.qaboard/` (out of manifests). `qa batch` computes them once for its runs, which check a
fingerprint. `qa restore` (`restore.py`) gets the code back. Design: `docs/rfcs/local-changes.md`.

## Runners
- `qa batch` starts runs with a runner (`runners/`): local, lsf, celery, dask (workers on LSF, Slurm, PBS, SGE,
  HTCondor, OAR, Moab, Kubernetes or local: `runners.dask.cluster.type`), kubernetes (Indexed Jobs), windows (Jenkins).
- Optional dependencies are extras (`--extra celery --extra dask --extra kubernetes --extra dask-kubernetes`; also
  `mlflow`). CI's Python 3.14 job installs them all, 3.11 none: code must work without them.
- `qa doctor [--runner X] [--test-job]` checks a setup and prints fixes; runners implement `doctor()`.
- `qa batch --commit <sha>` (`on_server.py`) has the server start the batch on a pushed commit, through the web app's
  tuning endpoints (`backend/backend/api/tuning.py`).
- An image per commit (`{commit}` in `runners.kubernetes.image`, with `workdir`) is looked up in its registry before
  pods start (`runners/registry.py`).
- Without a shared storage, `qa save-artifacts` sends a commit's artifacts to the server and `qa fetch-artifacts`
  downloads them into a cache keyed by their hash (`commit_artifacts.py`).
- End-to-end: `.github/scripts/kubernetes_runner_e2e.py` (on kind); server-started batches on the Helm chart without a
  shared storage: `.github/scripts/helm_e2e.py --kubernetes` (CI's `helm-e2e` job).
- Design and trust model: `docs/design/kubernetes-runner.md`; limits: `docs/warts.md` (Runners).
