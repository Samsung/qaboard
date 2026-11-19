# Sending results without `qa run` or a shared storage: `start_run()`, `qa upload`, HTTP upload

Status (2026-11-19): implemented and experimental; this page is the map for the next features (§3). §1 says what
exists and where, §2 the decisions that constrain what comes next, §3 what is left, in order. `docs/design/http-upload.md`
is the full protocol this implements a small part of (parts, content store); `docs/rfcs/python-sdk-runs.md` the SDK.
Known limits: `docs/warts.md` ("Results sent over HTTP"). User docs: `website/docs/upload-results.mdx`,
`storage/uploads.mdx`, `storage/artifacts.mdx`; admins: `backend-admin/uploads.mdx`, `backend-admin/runners.mdx`.

## 1. What is built

### Client (`qaboard/`)
| Piece | Where |
|---|---|
| `start_run()`: runs from code; `plan_run()` says which run it would start, with no request and no side effect (`RunPlan`), also printed by `qa upload --dryrun` | `active_run.py` |
| `qa upload`: files other tools wrote become a run (`start_run()` from the shell) | `upload_command.py` |
| What runs send: one payload definition | `payloads.py` (`"storage": "upload"`) |
| Whether results go over HTTP: no `storage`, `storage: upload` or `QA_STORAGE=upload` | `config.py` (`uploads_files`) |
| **Every request to the server**: base URL and `/api/v1/` paths, the token, TLS (`QABOARD_API_VERIFY`), retries (opt-in per call: 408, 429 with `Retry-After` up to 60 s, 5xx but 501/505, network errors; not bad URLs or untrusted certificates), bodies given again per try (callables), `give_up()`, downloads checked by SHA-256. Errors are `ResultsError` (`status`, `reason`, `is_transient`, `is_refusal`) | `http_client.py`; `results._request` is a thin wrapper |
| **Refusal reasons**, shared with the server (`from qaboard.conventions import Reason`), and the groups clients act on (`UPLOAD_REFUSALS`, `RUN_FILES_REFUSALS`, `NO_ARTIFACTS`) | `conventions.py` `Reason` |
| **What a run tells the server besides its results**: the uploader, heartbeats, the run the server never heard of (`finish(create=)`), the end of the log after a refused end (`ended(known=False)`). Idempotent steps under a lock, a context manager; used by `qa run` (`qa.py` `_reporter`) and `start_run()` | `reporting.py` `RunReporter` |
| The uploader: live files while the run goes on (`log.txt`, `series.jsonl` by `?offset=`, `series.json`, `run.json`, `outputs.live`), then everything with its SHA-256, 4 at a time, then the final `POST /output/` | `upload.py` `Uploader` |
| Heartbeats (at least every 2 minutes, `PATCH .../progress`) | `heartbeat.py`, driven by `RunReporter` |
| A run's files fetched from the server, with their cache (`cache_root`, `attempt_key`, `fetch_file`: whole or nothing). Today the reference's manifests for `qa check-bit-accuracy`, once per finished run. **`local_path()` goes here** | `run_files.py` (`fetched_manifests`), `bit_accuracy.py` calls it |
| Metrics of uploaded files, by the file names the web app's viewers recognize | `junit.py`, `benchmarks.py`, `webapp/src/viewers/fileTypes.js` |
| A commit's artifacts: `qa save-artifacts` sends them file by file, `qa fetch-artifacts` downloads them into `<cache>/<hash>/` | `commit_artifacts.py` |
| The Kubernetes driver's log to the server: read and echoed without waiting for the network, sent every 3 s by a thread (4 MiB buffer, oldest dropped with a note, 60 s at the end), offsets and the 409 resync, no retries inside the request (a lost answer would write twice) | `batch_log.py` (`LogSender`) |
| An image per commit: `{commit}` in `runners.kubernetes.image`, looked up in its registry before pods start | `runners/registry.py`, `runners/kubernetes.py` (`check_commit_images`, `in_pods`, `fetched_artifacts`) |

### Server (`backend/backend/`)
| Piece | Where |
|---|---|
| One folder (`QABOARD_UPLOAD_ROOT`, default `/mnt/qaboard` when no storage roots are set), one endpoint per file: `PUT /api/v1/output/<id>/files/<path>` (`?offset=` to append, `X-Content-SHA256`), written to a temporary name then renamed | `uploads.py` (`save_file`), `api/outputs.py` |
| Folders the server chooses: `<root>/<project>/-/<commit>/<batch>/<configuration>/<input>/`, the commit's artifacts in `<commit>/artifacts/`. One pattern for commit folders (`FULL_COMMIT_ID`, `COMMIT_FOLDER`, `COMMIT_FOLDERS_IN_PATH`), also used by the storage scan | `uploads.py` (`run_dir`, `commit_folder`, `is_run_dir`, `is_commit_artifacts_dir`), `jobs/scan.py` |
| nginx checks the token before it takes a body: `auth_request` to `PUT /api/v1/uploads/authorize` (gets the URI as `QABOARD_ORIGINAL_URI`). **Fail closed**: `snippets/qaboard-files-server.conf` sets `$qaboard_files_server_included`, which the auth snippets require (500 otherwise, `nginx -t` fails if no server includes it); the authorize answer's `X-QABoard-Upload-Checked` reaches the upload as the uwsgi param `QABOARD_UPLOAD_CHECKED`, and endpoints that take files refuse without it (`proxy_misconfigured`). `flask run` alone isn't checked | `services/nginx/snippets/qaboard-uploads-auth.conf`, `qaboard-uploads-authorize.conf`, `uploads.unchecked_by_proxy`; the chart uses the same snippets |
| Storage locations: runs store their full location (a path or `s3://...`), resolved by the locations admins add, inside the storage roots | `locations.py`, `models/StorageLocation.py`, Admin → Storage |
| Heartbeats: running runs silent for `QABOARD_SILENT_RUN_TIMEOUT_MINUTES` are failed by the jobs worker | `heartbeats.py` |
| A commit's artifacts through the server: `PUT /api/v1/commit/<commit>/artifacts/files/<path>`, `GET .../artifacts` (files, SHA-256, mode, a hash of the whole), files served by nginx under `/s/` | `api/commit_artifacts.py`, `CiCommit.uploaded_artifacts_dir`, `artifacts.py` (`cd_lines`, `runner_unsupported`) |
| **Where the server starts batches** (tuning, `qa optimize`, redo, `qa batch --commit`): `QABOARD_TUNING_RUNNER` unset means nowhere, refused up front with `no_server_runner`; `local`/`celery` (in the backend's container, warned about in Admin → Settings and the security checklist), `kubernetes` (a driver pod), `lsf` / the LSF bridge for redo | `server_runner.py` (`server_runner`, `redo_runner`, `refusal`), `local_jobs.py`, `runner_jobs.py` (`submit_driver`, `driver_files`) |
| **Batch tokens** (`qab_bat_`, `read` + `ingest`): minted per batch the server starts, for the user who started it (`tokens.mint_for_batch`), with the batch in `Token.data` (project, commit, label, `optimize`). Writes: deny-by-default outside `actor.BATCH_TOKEN_ENDPOINTS`, and those only for its commit and label (`label|iterN` for `qa optimize`, sub-projects included: `tokens.batch_allows`); never commit artifacts. Reads stay project-wide. Revoked when the batch stops, expire 10 minutes after its last run (`end_batch_token`), or after a day idle for optimize and redo (`until_stopped`) | `tokens.py`, `actor.py`, refusals `batch_token_limited` |
| End-to-end: `qa upload`, `start_run()`, `qa run` with uploads, bit accuracy against an uploaded reference, a killed run failed by heartbeats, batches started from the web app (`QABOARD_TUNING_RUNNER=local` in CI's `.env`); on Kubernetes with the Helm chart | `.github/scripts/uploads_e2e.py` (CI `docker`), `.github/scripts/helm_e2e.py --kubernetes` (CI `helm-e2e`) |

### How a run without a shared storage goes
1. The run is saved like a local one, in the project's `output/`. No staging area, no state file.
2. `POST /api/v1/output/` with `"storage": "upload"` creates it. **The server chooses the folder** and empties it
   when a run starts again (not for `--keep-previous` and `resume=True`). Clients never send a folder: what they say
   about the run only reaches the path as names the server makes (`uploads.folder_name`: a slug, with a hash unless
   the text was one already). Before it writes or deletes, the server checks the folder is one it could have chosen
   for that project (`is_run_dir`), for a run it marked as uploading (`data.uploads_files`).
3. While the run goes on, `RunReporter`'s uploader sends what people look at then.
4. When it ends: everything else, then the final `POST /output/`. The server only takes files of pending or running
   runs, so a finished run's files are all there and don't change.
5. From then on they are files of a storage root: `/s/`, the image server, the file browser, exports, deletions and
   retention work unchanged.

The uploader sends the state of the folder, not events: it compares files with what it sent (size and date) and
sends what differs. A failed request needs no replay.

### How batches the server starts get a commit's code
- With a shared storage: from the commit's artifacts folder, as always.
- With uploaded artifacts: **every batch fetches its own copy** into a temporary cache (`artifacts.cd_lines`,
  `EXIT_TRAP`), on the server's machine too; the runs save their files in the copy, then send them with the batch's
  token. In a fetched copy the kubernetes runner has its run pods fetch too (`fetched_artifacts`).
- On Kubernetes, the driver pod doesn't see the server's batch folder: it gets its files in its ConfigMap (768 KiB at
  most, `runner_jobs.driver_files`) and sends its output with `qa send-batch-log` (`PUT /api/v1/batch/submissions/<id>/log`).
  The server writes how to read the pod's logs at the top of log.txt (`QABOARD_POD_LOGS`).
- The server's own `qa` reaches QA-Board through nginx (`QABOARD_HOST`: `proxy` in docker-compose.yml, the proxy's
  Service in the chart), so its uploads are checked like everyone's.
- Image per commit: `{commit}` or `{commit:.N}` only between braces. `check_commit_images` sends `HEAD
  /v2/<repository>/manifests/<tag>` (OCI and Docker types; Bearer, anonymous or with credentials, or Basic). Credentials:
  readable `image_pull_secrets` and `~/.docker/config.json`, never the server's own (`local_registry_credentials: false`).
  404 stops the batch; 401/403 after authenticating, other statuses and network errors warn and continue. `workdir` maps
  the runs' `cd` and log paths under the repository's root (`in_pods`).

## 2. Decisions that constrain what comes next

| Question | Decision | Why |
|---|---|---|
| A new run client? | No: `start_run()` is the one way to create runs outside `qa run`; `qa upload` is its command line; `plan_run()` is what both say before starting | One vocabulary, one payload definition |
| Batch, label or experiment | `label` is the CLI's word, `batch=` the SDK's; one alone is the web app's batch. Both: `label` is the batch, `batch` the group on the run's card (`data.batch`). No `experiment` | Too late to rename `--label` |
| Nested runs | `qa run` exports `QABOARD_RUN_DIR`; `start_run()` refuses to start that same run again. No attaching | Not a concern yet |
| Default run name of `qa upload` | In CI `<job>/<file>` (the job alone with several paths), elsewhere the file's name; `--input` for names that last | Jobs must not replace each other's runs |
| Syncing later | Not built: a run the server never heard of is not sent later | Not worth new commands yet |
| Heartbeats | Clients say so when the run starts (`heartbeat: true`); every report of a running run sets `outputs.reported_at`; silent runs are failed with `data.failed_reason`, and run again if they report again | Old clients are never failed for being silent. No new endpoint or state |
| `--append` to a finished run | Dropped: one upload is one run | Finished runs don't change |
| Which protocol | One `PUT` per file, an offset to append; no session, parts or content store | Most files are small. **Parts and deduplication wait for a project with huge outputs** (§3 item 2) |
| Who chooses the folder | The server, from the run's identity. Client paths are inside it, validated, written to a temporary name then renamed | Clients can't write anywhere else |
| Tokens | Always, for files and for creating a run that uploads, whatever `ingest.auth` says | Whoever uploads stores files the server then serves |
| Retries | Per call, never by default: an append or a log whose answer was lost must not be sent twice unless the caller handles offsets (`http_client.request(retries=...)`) | One helper, no hidden resends |
| Storage backends in the server | **One: a folder.** Object storage is mounted by the deployment (S3 Files, JuiceFS...) | Every reader (nginx, Cantaloupe, the file browser, deletions) works on files (§4) |
| Where a run is | **Each run stores its full location** (a path or a URL); storage locations map URL prefixes to how the server reaches them. `Output.output_dir` resolves it (`locations.local_path`); never `Path()` | Editing a location never strands runs; buckets added without a restart; credentials attach to the location later (`options`) |
| Default when no `storage` is set | Send to the server | New projects need no storage line |
| Does a new server take files? | Yes with the default storage (`QABOARD_UPLOAD_ROOT` and `QABOARD_STORAGE_ROOTS` unset, `/mnt/qaboard` writable); `off` turns it off | A new project and a new server must work together |
| Where storage settings live | The boundary (storage roots, the upload root) in environment variables; the routing (locations) in the database, inside the roots (`locations.check_path`) | Someone who takes over an admin's session must not move where the server writes |
| Does the server run project code? | **Not by default** (`QABOARD_TUNING_RUNNER` unset). `local`/`celery` are an explicit opt-in, warned about; unknown values are refused rather than falling back | Anyone who can send a project's artifacts or start its batches would run code as the backend |
| What a batch token reaches | Its batch: commit + label (+ optimize iterations), writes deny-by-default. Not the command id: redo runs pending runs under their first command id, and optimize evaluations are batches of their own | The token sits in a namespace's ConfigMaps |
| How artifacts reach the server | Files, not a bundle: one `PUT` per file (SHA-256 required), then the manifests, one copy per (sub)project | The server reads, checks and deletes them with the shared-storage code (`artifacts.py`); CI sends only what changed |
| How batches get them | Every batch fetches its own copy into a temporary cache, wherever `qa batch` runs; no server-side tar | One path everywhere; nothing left on disk |

## 3. What is left
Sizes: [S] an hour, [M] a day, [L] more. In order:

1. **`qaboard.local_path("qaboard://<run>/checkpoints/last.pt")`** [M]: a run's file as a local path, from the
   folder when its location is mounted here, else downloaded once into the cache keyed by the manifest's hash. Like
   W&B's `use_artifact().download()` or MLflow's `download_artifacts("runs:/...")`, for checkpoints. Build it in
   `run_files.py` on `fetch_file` and `http_client.download(sha256=)`; it shares the cache with `fetched_manifests`
   and `qa fetch-artifacts`. Needs: resolving a `qaboard://` run reference (by id, or project/commit/batch/input
   like `qaboard.runs()`), and an eviction for caches outside temporary folders.
2. **Huge outputs** [L]: parts (resumable uploads of files over `QABOARD_UPLOAD_MAX_FILE_MB`), "which hashes do you
   have" before sending, and the content store (`http-upload.md`), which also deduplicates bit-accurate reruns and
   artifacts across commits and subprojects (or hardlinks by hash first [M]). The uploader's request layer
   (`Uploader._request` over `http_client`) and `Reason` are where the new answers go.
3. **Limits** [M]: quotas per project, a limit on files per run (inodes), a free-space check atomic with concurrent
   uploads.
4. **A backend test that runs the real `Uploader` against the Flask app** [M], instead of the tests' fake server
   (`tests/test_active_run.py`, which must answer like the real endpoints meanwhile).
5. **Storage locations** [M each]: credentials (encrypted, `backend/encryption.py`); the scans, storage usage
   (`storage_usage.py`, the Storage page) and the file browser on locations and on runs stored as URLs; clients that
   mount a location writing there directly; a test that fails when code outside `models/` and `locations.py` reads
   `output_dir_override`; the storage roots still list the upload root apart (`config.storage_roots`).
6. **Runners** [S each]: LSF, Slurm, Celery and Jenkins jobs fetching uploaded artifacts (the `fetched_artifacts`
   hook in their command line); once-per-node fetching with a hostPath cache; SHA-256 in the manifests of
   `qa save-artifacts --out`; a retry of the image check while CI is still pushing, and digest pinning.
7. **Code left as is, to fold when touched** [S each]: `submit_driver` could mint the batch token instead of
   receiving it; the artifacts endpoint `/api/v1/commit/<commit>/artifacts/...` overlaps `/api/v1/commit/<path:commit_id>`
   (its fallback for branches named `*/artifacts` is a hidden coupling); `QABOARD_SANDBOX_HTML` on by default for
   uploaded runs. The CLI's "can I read this run's folder here?" checks (`runners/job.py`, `bit_accuracy.py`,
   `qa.py`) were left apart: each is `not uploads_files` with a different local condition.
8. Trying Windows clients.

## 4. If the server ever talks to object storage itself
Not built, and not planned until a mounted file system proves not to be enough.

### 4.1 The principle: the server owns the index
Whatever the storage, the server keeps: the database (metrics, statuses), every run's manifest with sha256,
`log.txt`, the series, files under `QABOARD_INLINE_MAX` (default 1 MiB: test reports, benchmark files, folded
stacks, small JSON and text), and derived data (thumbnails, Cantaloupe's cache). Only bulk files go to the
project's storage. So history, the gate, the test and benchmark viewers' comparisons and bit-accuracy checks
(manifest against manifest) work without the project's bucket, and after its retention deleted the bulk; the
operator pays for a small, predictable index, projects for their bulk.

### 4.2 Options for project-paid storage
| Option | How | Against | Verdict |
|---|---|---|---|
| **A. Bring-your-own bucket** (S3-compatible, GCS, Azure Blob) | A project admin registers a storage profile. Uploads get presigned `PUT` URLs; reads go through `/s/` (§4.3). Credentials by role assumption (AWS), workload identity federation (GCP) or federated credentials (Azure); static keys, encrypted, only for on-prem S3 | Per-cloud credential code; egress is the project's when files are read | **Recommended** |
| **B. CI artifact stores** | A pointer per run, fetched on read | GitHub serves whole zips; needs a CI token per project; files vanish with CI retention | Not as storage. Maybe an import later |
| **C. OCI registry** (ORAS: GHCR, Harbor, Artifactory) | A run's files as an OCI artifact, blobs by sha256 | Range reads and browsing vary by registry | A spike where Artifactory is the only sanctioned store |
| **D. Server-managed** (filesystem, or the operator's bucket) | Today | The operator pays for everything | The default; A is opt-in per project |

S3's "Requester Pays" is about who pays for downloads, not storage: it doesn't help here.

### 4.3 Serving files from anywhere: one resolver
- A run records where its bulk lives: its full location, a URL (`outputs.output_dir_override`). The storage location
  matching it says how to reach it: today a mount, then a profile with credentials.
- `/s/<path>` keeps its URLs. nginx's `auth_request` asks the backend, which answers with `X-Accel-Redirect` to
  the local alias, or to an internal location proxying a presigned URL of the right bucket (same origin, Range
  works, no CORS). Large videos can get a `302` to the presigned URL.
- Cantaloupe: `S3Source` with a delegate script mapping the identifier to the profile's bucket and key.

### 4.4 Open source to build on
| Need | Pick | Notes |
|---|---|---|
| One API over many storages (put, ranged get, delete, list, presign) | **Apache OpenDAL** (Python bindings; S3-compatible, GCS, Azure, local, WebDAV, SFTP, HDFS…) | **obstore** if the cloud object stores are enough; **fsspec** is slower and presigns per backend. Check presign support per service first. Keep our `BlobStore` to five calls so the library stays swappable |
| Self-hosted S3 for the quickstart, Kubernetes, on-prem | **Garage** or **SeaweedFS**; **Ceph RGW** where Ceph exists | **MinIO**'s community edition stopped shipping binaries in Oct 2025 and is no longer maintained (2026): not the default (`http-upload.md` question 11) |
| S3 API over an existing NFS | **Versity S3 Gateway** | One code path for shared-storage sites, if ever wanted |
| Exotic storages without code (SharePoint, SMB, SFTP) | **rclone** `serve s3` / `serve webdav`, run by the site | |
| Resumable uploads | Our own parts (§3 item 2) | tus: rejected in `http-upload.md` §4.2, still true |
