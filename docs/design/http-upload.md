# HTTP upload of run outputs: design proposal

Status: proposal v1 (2026-10-12), for review. Context: `docs/docs-overhaul-plan.md` §1 "Data and ingest", §5 (tutorial
step 6: GitHub-hosted runners need HTTP upload) and §10 ("HTTP upload: yes, designed properly first").
Line references are to this branch's tree.

## TL;DR
- **Same files, same paths, new transport.** The server stores uploaded runs under a root it manages, at the
  same paths the CLI would use with `storage: <that root>`. URLs stay `/s/<abs path>`, so nginx, the file
  browser, Cantaloupe, manifests, delete and retention keep working unchanged.
- **Protocol:** an upload session per run. Files are content-addressed blobs (`PUT /blobs/<sha256>`); files over
  32 MiB are sent as S3-multipart-shaped parts; small files go in content-addressed tar packs. An explicit
  `commit` verifies everything and makes the run visible. The server tells the client where to send each blob,
  so presigned object-storage URLs can replace our endpoints later without changing the CLI.
- **Correctness:** every byte is verified (sha256) before it becomes visible. All calls are idempotent and
  resumable. A run's files appear only at commit, and `log.txt` streams live as it does today.
- **Efficiency:** unchanged outputs (the common bit-accurate case) are deduplicated per repository with
  hardlinks into a content store, so they cost neither bandwidth nor disk. Text is compressed in transit.
- **Security first:** uploads always need an API token scoped to `ingest` and to the project. The same
  check gates the existing ingest endpoints behind `QABOARD_INGEST_AUTH=off|warn|token`. Clients never
  choose absolute paths. A few existing gaps must close before ingest faces the internet (§1.3).
- **Phases:** 1) security baseline (M), 2a) upload core (L), 2b) dedupe, quotas, artifacts, bit-accuracy (M-L),
  3) object storage (XL).

---

## 1. How it works today (verified)

### 1.1 Write path: the CLI
- **Where outputs go.** `storage` in qaboard.yaml, or `$QA_STORAGE`, gives the roots
  (`qaboard/config.py:159-198`, env override at `:172`). The CLI creates them at import time (`:224-225`) and
  derives `outputs_commit_root = <root>/<project_root>/<sha[:2]>/<sha[2:16]>` (`:353`, `qaboard/conventions.py:227`).
  Run folders are `<batch dir>/<config hash>/<input slug>` (`conventions.py:241-265`). Only CI and `--share`
  runs use the storage: local runs write `./output/` (`conventions.py:241-244`).
- **`qa run`** (`qaboard/qa.py:188-283`):
  - cleans the folder (`:216`) and tees stdout/stderr to `<output_dir>/log.txt` (`:233`);
  - posts `is_running` (`:241`), runs the user code, then writes `metrics.json` and `manifest.outputs.json`
    (`:351`) and posts the final status (`:371`).
- **Manifests** map each file to `{st_size, md5}`, plus `md5_data`, width and height with internal image tools
  (`qaboard/utils.py:339-440`). `log.txt` is excluded (`:450`). On Windows, the md5 of a text file is computed
  after normalizing line endings (`:345`), so it's a comparison hash, not the hash of the stored bytes.
- **Ingest calls.** `notify_qa_database` POSTs JSON to `/api/v1/output/`, `/batch/` or `/commit/`
  (`qaboard/api.py:136-200`), with `Authorization: Bearer $QA_TOKEN` when a token exists (`:48-53`).
  Failures are only warnings (`:187`).
- **The server trusts the path.** `POST /api/v1/output/` has no authentication (`backend/backend/api/outputs.py:129-249`).
  It only checks that `output_directory` is inside `QABOARD_STORAGE_ROOTS` (`:144`, `backend/backend/storage.py:39-47`),
  then stores it as `Output.output_dir_override` (`:227`).
- **`qa save-artifacts`** copies files to `artifacts_commit_root` and writes `manifests/<group>.json`
  (`qa.py:906-1005`).
- **`qa batch` reads paths back.** It matches existing runs by comparing `url_to_dir(output_dir_url)` with
  local paths (`qa.py:740`, `qaboard/runners/job.py:99-110`). Pending runs fall back to reading `metrics.json`
  from disk (`job.py:116-127`).

### 1.2 Read paths: the server, all on the same absolute path
| Reader | Today |
|---|---|
| nginx `/s/<abs path>` | `alias /var/qaboard/` (`services/nginx/conf.d/qaboard.conf:57-64`): storage is mounted in the proxy under `/var/qaboard` |
| Storage roots | `QABOARD_STORAGE_ROOTS` (`backend/backend/config.py:25`). The server only writes, deletes or runs code inside them (`storage.py:39-67`) |
| Manifests | The web app reads `<output_dir_url>/manifest.outputs.json` through nginx, or `/api/v1/output/<id>/manifest` for running runs (`webapp/src/viewers/OutputCard.jsx:218`). The endpoint **rewrites** the manifest, without hashes, for running runs or on `?refresh`, and it's unauthenticated (`outputs.py:101-120`) |
| Cantaloupe IIIF | `FilesystemSource` with `path_prefix = /repository/` (`services/cantaloupe/cantaloupe.properties:130,145`); compose mounts `/:/repository` (`docker-compose.yml:203`); the identifier is the absolute path (`webapp/src/viewers/images/utils.js:13-25`) |
| Pixel tooltip, ROI diff, PDF report | Backend reads images by path from `url_to_dir(...)` (`backend/backend/api/image.py:135-200`) |
| File browser | Lists folders with `os.scandir` inside the storage roots (`backend/backend/files.py:39-44,181-197`, `backend/backend/api/files.py:178-199`). Maps a folder to its run through `output_dir_override` (`api/files.py:152-173`) |
| Restricted files | nginx `auth_request` (`services/nginx/snippets/qaboard-files-auth.conf`) → `check_read_access` (`api/files.py:77-122`). Project folders come from `project.storage_roots()` (`:49`) |
| Delete | `Output.delete` → `check_storage_path` + `rmtree` (`backend/backend/models/Output.py:310-360`). Falls back to running as the file's owner via setuid or sudo (`backend/backend/fs_utils.py:41-50`) |
| Redo | Writes `redo.sh` in the run folder and runs `qa batch` from the artifacts folder as the user, via the LSF bridge (`Output.py:213-307`) |
| Mark failed | Database only: `PUT /api/v1/output/<id>` (`webapp/src/files/api.js:81`, `outputs.py:42-63`) |
| Tuning | Writes scripts in the batch folder and runs `qa batch` from `ci_commit.artifacts_dir` with `QA_OUTPUTS_COMMIT` (`backend/backend/api/tuning.py:254-279,381-560`). Restores missing artifacts with `qa save-artifacts` from a git worktree (`backend/backend/models/CiCommit.py:160-183`; binaries are not restored) |
| `qa check-bit-accuracy` | New results are local (`qaboard/bit_accuracy.py:472`). References are read from storage at `outputs_project_root/<ref commit dirs>` (`:527`). Compares manifests when both exist and no custom compare is set (`:259`), else compares files (`:266-273`) |
| Live logs | `useLogTail` polls `<output_dir_url>/log.txt` every 2 s with HTTP Range (`webapp/src/components/logs/useLogTail.js:20`, `fetchRange.js:30-50`, `RunLogs.jsx:211`). nginx turns gzip off for Range requests (`snippets/qaboard-files.conf:27-32`) |
| Retention | `backend/backend/clean.py` (`storage.garbage.after` in qaboard.yaml) |

### 1.3 Gaps that matter once ingest is reachable from the internet
Fine behind a firewall today. They become real once GitHub-hosted runners can reach the server.
1. **Ingest is unauthenticated.** That covers `POST /api/v1/output/`, `/batch/` and `/commit/`. `/batch/` deletes
   outputs for `qa optimize`, but only the optimization's own: runs it moved in from its best iteration (marked by the
   server) and its `<label>|iter<N>` batches (`backend/backend/api/batch.py`).
2. **Stored XSS.** The HTML viewer injects output HTML with `dangerouslySetInnerHTML` (`webapp/src/viewers/html.jsx:93,96`),
   and nginx serves uploaded HTML and SVG from the app's origin. Whoever can write outputs can run JavaScript
   in reviewers' sessions.
3. **IIIF has no `auth_request`** (`conf.d/qaboard.conf:68-76`), so images of restricted projects bypass the file checks.
4. **The image APIs read any path** the backend can read, and the report writes a PDF without `check_storage_path`
   (`image.py:138,166-167,187-197`).
5. **Tokens:**
   - they're stored in plain text (`backend/backend/models/User.py:56-91`) and accepted in `?token=` URLs
     (`backend/backend/api/auth.py:236`);
   - they have no scopes and no expiry by default;
   - there's no UI to list or revoke them (`auth.py:72-85`);
   - the migration lacks the model's `data` column and makes `expires_at` NOT NULL
     (`alembic/versions/cda62d01ead8_add_token_table.py`).
6. **Manifests can be rewritten.** A `GET .../manifest?refresh=true` (unauthenticated) rewrites a manifest
   without hashes (`outputs.py:107-112`), which breaks bit-accuracy for that run.

---

## 2. Goals and non-goals
**Goals**
- `qa run` and `qa batch` work on machines without the shared storage: GitHub-hosted runners, laptops off the
  VPN, pods without an RWX volume. Their runs look and behave exactly like shared-storage runs.
- Every reader in §1.2 keeps working, with no change to URLs or the web app.
- **Correct:** bytes are verified, a run becomes visible only when complete, retries are idempotent, large files resume.
- **Safe to expose:** tokens, per-project permission, limits, and clients never control server paths.
- **Efficient:** bit-accurate outputs upload nothing, uploads run in parallel, and text is compressed.
- **One protocol** that later fronts object storage, with presigned direct uploads.

**Non-goals**
- Replacing shared storage where it exists: it stays the default for existing projects.
- Uploads from the browser, or a general file host or artifact registry.
- Streaming output files while a run is running (only `log.txt` streams).
- Dedupe across repositories, and client-side encryption.
- `{user}` templates in upload-mode storage paths (the server root has none).
- Object storage before phase 3: designed for here, not built.

---

## 3. CLI: UX and configuration

### 3.1 Storage modes
```yaml
storage: /mnt/qaboard           # unchanged: shared filesystem ("direct")
```
```yaml
storage: upload                 # new: QA-Board stores the results, no shared filesystem needed
```
```yaml
storage:
  linux: /mnt/qaboard
  upload: auto                  # new: direct when /mnt/qaboard is the server's storage, else upload
```
- **`upload`:** `never` (default when a path is set), `auto` or `always`. `storage: upload` means
  `always` with no path. With no `storage` at all, the CLI uploads if the server accepts uploads; today
  that's a configuration error (`config.py:190-198`). The quickstart then needs no storage line.
- **Overrides:** `QA_STORAGE=upload` (the existing override) and `QA_UPLOAD=auto|always|never`.
- **Auto-detection.** The server writes `<upload root>/.qaboard-storage.json` with a random id, and
  `GET /api/v1/config` returns it (§4.3). In `auto`, the CLI writes directly when the configured path is
  inside the advertised root, the marker exists locally with the same id, and the folder is writable.
  Otherwise it uploads. We never guess from "the path exists": a stale local folder or a different NFS
  export would otherwise swallow results.
- **Paths.** In upload mode, the CLI computes paths *relative* to the storage root, with the same conventions
  as today: `<project_root>/<sha[:2]>/<sha[2:16]>/<subproject>/output/<batch>/<config hash>/<input>`. The
  server prefixes its root. The CLI needs no network call to compute paths, and Windows clients skip the
  path mappings (`qaboard/compat.py`).
- **`--output` with an absolute path** is refused in upload mode. `--prefix-outputs-path` stays relative to the commit folder.

### 3.2 Staging directory
- In upload mode, `context.output_dir` is a local folder: `$QA_STAGING`, by default
  `${XDG_CACHE_HOME:-~/.cache}/qaboard/staging/<server host>/<relative path>`. User code is unchanged.
- `qa get outputs_commit` prints the staging path; `qa get storage_mode` prints `direct|upload`.
- Staging is kept, like today's local `output/` folders, and cleaned when the same run runs again.
  `QA_STAGING_KEEP=manifests` deletes bulk files after a committed upload but keeps `run.json`,
  `metrics.json` and the manifests. `qa batch` and bit-accuracy checks need those.

### 3.3 A run in upload mode
1. `POST /api/v1/output/` with `"storage": "upload"`, the relative `output_directory` and `is_running`.
   The server moves the previous run folder to its trash and creates an empty one. That's what
   `clean_output_dir` does today, at `qa.py:216`.
2. A background thread streams the local `log.txt` with `POST /api/v1/output/<id>/log`, every 2 s or 1 MiB.
   That matches the web app's polling.
3. `run()` and `postprocess()` write into staging. The manifest gains `sha256`, computed in the same read as `md5`.
4. `POST /api/v1/uploads` (begin) returns which blobs the server lacks. The CLI uploads them with 4 workers
   (`QA_UPLOAD_CONCURRENCY`): small files in packs, large ones in parts.
5. The CLI flushes the log, then `POST .../commit` sends the final status, metrics and data. That replaces the
   final `notify_qa_database` (`qa.py:371`). The run is now visible as finished.

```
$ QA_STORAGE=upload qa batch ci
Results: https://qaboard.example.com/group/repo/commit/ab12cd34ef
[upload] 37 runs: 2.1 GB, of which 1.9 GB already on the server; sent 210 MB in 14 s
```
- **GitHub Actions:** set `QABOARD_URL`, `QA_TOKEN: ${{ secrets.QA_TOKEN }}` and `QA_STORAGE: upload`.
  Fork PRs don't get the secret, so they can't upload.

### 3.4 Offline mode, failures and exit codes
- **`--offline`:** runs are written to staging with `.qaboard-upload.json` (`state: pending`) and nothing is sent.
  `qa upload --pending [paths]` (new command) replays the `POST /output/` from `run.json` and `metrics.json`,
  then uploads.
- **Network errors:**
  - Retries use exponential backoff with jitter (0.5 s doubling to 30 s) and honor `Retry-After` on 429 and 503,
    for up to `QA_UPLOAD_TIMEOUT` (10 min).
  - Then the run is left `pending` locally, and the CLI sends a best-effort `is_failed` with `data.error = "upload failed"`.
  - `qa run` exits 1 in CI and warns elsewhere (`QA_UPLOAD_ERRORS=fail|warn`). Today, failing to notify is
    only a warning (`api.py:187`), but silently losing CI results is worse.
- **Server too old:** `/api/v1/config` has no `uploads`. `always` fails with "this server doesn't accept
  uploads (QA-Board ≥ X)", and `auto` falls back to direct.
- **CLI too old:** an old CLI with `storage: upload` would post a relative path. The server answers 400 with
  "this project uploads its results: upgrade qaboard to ≥ X". The CLI sends `User-Agent: qaboard/<version>`.

### 3.5 CLI code changes
| File | Change |
|---|---|
| `qaboard/config.py` | Resolve the mode. Don't `mkdir` remote roots in upload mode (`:224-225`, else `qa` exits at `qa.py:59-61`). Relative path helpers |
| `qaboard/run.py` | `RunContext.storage_path` (relative) next to `output_dir` (local). Payloads send the relative path |
| `qaboard/qa.py` | `run` (start, log streamer, commit), `postprocess_`, path matching (`:740`), `save_artifacts` (`:906-1005`), new `qa upload` |
| `qaboard/runners/job.py` | Match runs by relative path (`:99-110`). A pending run whose upload never committed is failed, not "done" (`:116-127`) |
| `qaboard/utils.py` | `file_info` computes md5 and sha256 in one pass (`:371-401`) |
| `qaboard/bit_accuracy.py` | References through the API (§7). `cmpmanifests` takes dicts (`:146`) |
| `qaboard/upload.py` (new) | Session, packs, parts, retries, log streamer, local state |

---

## 4. Upload protocol

### 4.1 Options considered
| Option | For | Against |
|---|---|---|
| **A. Per-file PUT, content-addressed** (`PUT /blobs/<sha256>`) | Simplest. Idempotent by construction, dedupe for free | No resume inside a file. Multi-GB bodies would cross nginx and uwsgi (`harakiri = 300`, 2 processes × 4 threads: `backend/uwsgi.ini:20,106`, `docker-compose.yml:87`). One request per file is too many for 10k-file runs |
| **B. tus.io** (tusd) | Open protocol, resumable, mature Go server with an S3 store and hooks | A new service to deploy and secure (auth through hooks). No content addressing or dedupe. One upload is one file, so we'd still need our own session and commit. Parallel chunks need the concatenation extension. Python servers are immature |
| **C. S3-style multipart** (initiate, parts, complete) | Parallel and resumable parts. Maps 1:1 onto presigned multipart on S3, R2, GCS (XML API) and MinIO | More round trips. We'd implement it ourselves on the filesystem |
| **D. Presigned direct to object storage** | Bytes bypass QA-Board, so it scales with the bucket | Needs object storage. Checksum verification varies by provider. No help for the filesystem backend |
| **E. One archive per run** (`tar.zst`) | One request, good for many small files | Dedupe only per run, no resume, extraction risks (traversal, bombs), server CPU |

### 4.2 Recommendation
- **A** for files up to the part size, **C-shaped parts** for larger ones, and **content-addressed packs** for
  small files. Packs are E, restricted so that member names are hashes.
- All of it happens inside a session with an explicit commit.
- The begin response gives a URL for every blob and part. Phase 3 hands out presigned URLs (**D**) instead,
  with no change to the CLI's control flow.
- **Not tus.** Its strength, resuming a single file, is covered by parts. Its costs are a new service and no dedupe.
- **No new data-path service either.** nginx buffers request bodies (`uwsgi_request_buffering`, on by
  default), so slow clients don't hold uwsgi workers. Bodies are bounded by the part size (32 MiB), so a
  worker spends about 100 ms on local I/O and hashing per request.
- Ingest gets its own uwsgi pool (`upstream ingest`, the same image) as soon as CI batches are large, so the
  UI never waits behind uploads (phase 2b).

### 4.3 Endpoints and payloads
All of them need `Authorization: Bearer <token>` with the `ingest` scope for the project. Errors are
`{"error": "...", "reason": "..."}`, like the file APIs.

**Capabilities:** `GET /api/v1/config` gains:
```json
"uploads": {"enabled": true, "root": "/mnt/qaboard", "storage_id": "8f0c…", "part_size": 33554432,
            "pack_max_file": 1048576, "max_file": 53687091200, "encodings": ["gzip", "zstd"], "min_cli": "1.3.0"}
```

**Begin:** `POST /api/v1/uploads`, with an `Idempotency-Key: <uuid per run attempt>` header:
```json
{
  "target": {"output_id": 81234},
  "files": {
    "run.json":        {"size": 412,        "sha256": "9f…", "md5": "1c…"},
    "isp/out.tiff":    {"size": 629145600,  "sha256": "ab…", "md5": "e2…", "width": 10240, "height": 10240},
    "video/front.mp4": {"size": 8589934592, "sha256": "cd…", "md5": "77…"}
  }
}
```
- `target` can also be `{"batch_id": 9, "prefix": "qa-batch-logs/20261012-101500-1a2b3c4d"}` (batch logs) or
  `{"artifacts": {"project": "group/repo", "commit": "<sha>", "group": "binary"}}`.
- Response `201`, or `200` for the same idempotency key:
```json
{
  "id": "4c1e…", "state": "open", "expires_at": "2026-10-13T10:15:00Z", "part_size": 33554432,
  "target_dir": "/mnt/qaboard/group/repo/ab/cdef0123456789/output/1a2b-ci/9c8d-linux/front",
  "blobs": {
    "9f…": {"status": "pack"},
    "ab…": {"status": "missing", "parts": 19, "url": "/api/v1/uploads/4c1e…/blobs/ab…/parts/{n}"},
    "cd…": {"status": "present"}
  },
  "pack_url": "/api/v1/uploads/4c1e…/packs", "commit_url": "/api/v1/uploads/4c1e…/commit"
}
```
`present` blobs are already in the repository's content store (§4.6) and are not sent.

**Data:**
| Request | Body | Server |
|---|---|---|
| `PUT …/blobs/<sha256>` | the file (≤ part size). `Content-Length`; optional `Content-Encoding: gzip\|zstd` | Streams to `incoming/`, hashing as it writes. Checks size and sha256, fsyncs, links into the content store |
| `PUT …/blobs/<sha256>/parts/<n>` | part `n` (1-based) of a large file, with `Repr-Digest: sha-256=:<base64>:` (RFC 9530) | `pwrite` at `(n-1) × part_size` into `incoming/<id>/<sha256>.partial`, verifies the part digest, records the part |
| `POST …/packs` | `application/x-tar` (optionally gzip/zstd), ≤ part size. Each member is a regular file named by its sha256 | Checks each member: a regular file, in this upload's manifest, the declared size, hash equal to its name |
| `GET /api/v1/uploads/<id>` | | State, and per blob: present, missing, or the parts received (to resume) |
| `POST …/commit` | `{"output": {"metrics": {…}, "is_failed": false, "data": {…}}, "log_size": 182734}` | §4.4. `200` committed, `202` committing (poll `GET`), `409` with `missing: [...]` |
| `DELETE /api/v1/uploads/<id>` | | Aborts and frees `incoming/` |
| `POST /api/v1/output/<id>/log?offset=<n>[&reset=1]` | raw log bytes | Appends to `<run folder>/log.txt` under a file lock. If the file is longer than `offset`, the overlap is skipped (a retry). If shorter, `409 {"size": n}`. Capped at 256 MiB, with a truncation note |

**Status codes:**
- `401` no or invalid token; `403` scope or project; `404` unknown upload; `410` expired;
- `409` offset, missing blobs or superseded upload; `413` too large; `415` encoding; `422` size or digest mismatch;
- `429` rate limited (with `Retry-After`); `507` quota or disk.

**nginx** gets a dedicated location:
```nginx
location ^~ /api/v1/uploads/ {
  include uwsgi_params;
  uwsgi_pass backend;            # or `ingest` (phase 2b)
  client_max_body_size 40m;      # part size + slack. /api has the 1m default today in compose
  uwsgi_read_timeout 900;
  limit_conn qaboard_ingest 64;  # bounds the proxy's body buffers: 64 × 32 MiB
}
```

### 4.4 Atomic visibility
- **Running.** The Output row exists while the run is running, as today: `is_running`, with live `log.txt`.
- **Finished.** It becomes finished only at commit, and only after its files are complete and verified.
- **Commit:**
  1. Lock the Output row (`SELECT … FOR UPDATE`). An Output has at most one open upload: a newer begin
     supersedes the older one.
  2. Check that every manifest blob is present. Re-read and hash multi-part blobs, then link them into the
     content store.
  3. Build `<run folder>.incoming-<id>/` with hardlinks (or copies, §5) from the content store.
  4. The server writes `manifest.outputs.json` itself, from the verified manifest. It has the same format as
     today, plus `sha256`. Client-only fields (`md5`, `md5_data`, `width`, `height`, `format`) are kept as-is,
     with the same trust as today.
  5. Move `log.txt` into it, then swap the folders:
     - on Linux, `renameat2(RENAME_EXCHANGE)` is atomic;
     - elsewhere, NFS included: rename to `.old-<id>`, then rename into place. A reader can see a 404 for
       microseconds, and the log viewer already retries (`useLogTail.js:130`).
  6. In the same transaction: `is_pending = is_running = False`, the metrics, and `data.upload = {id, bytes, bytes_new}`.
- **Async commits.** Commit runs inside the request when the run is small (< 5k files and < 2 GiB to
  verify). Otherwise it's queued (Celery when enabled, else a uwsgi mule) and answers `202`.
- **Recovery.** An upload in state `committing` records which step it reached. Retried commits and the GC
  (§6.5) finish it or roll it back.

### 4.5 Idempotency, retries, resume
- **Begin** is keyed by `Idempotency-Key`, saved in the run's `.qaboard-upload.json`, so the same attempt
  gets the same session.
- **Blobs** are keyed by their hash, **parts** by `(blob, n)`, and **packs** by member hashes. Re-sending
  is harmless: the server keeps the first verified copy.
- **Commit** is keyed by the upload id. A second commit returns the first result.
- **Resume.** After a crash, the CLI reads its state file, calls `GET /api/v1/uploads/<id>`, and sends only
  what's missing. A `410` (expired, 24 h by default) starts a new session, and dedupe makes the restart cheap.
- **Logs:** offsets make retries exact (§4.3).

### 4.6 Dedupe, hashes, large files, concurrency, compression
- **Hashes.**
  - sha256 is the identity: hashlib uses OpenSSL's hardware acceleration, and it's collision-safe.
  - md5 isn't the identity: it's forgeable, and on Windows it's computed after normalizing line endings
    (§1.1). It stays the bit-accuracy comparison hash, as today.
  - Manifests carry both. `md5` keeps today's meaning; `sha256` is the hash of the bytes the server stores.
- **Dedupe.**
  - The content store is per repository (`project_root`), not global. A global store would let anyone with
    a token probe whether another project holds a given file.
  - A commit whose outputs are bit-accurate with its parent's sends only the manifest: every blob is `present`.
  - Any token holder of the repository can make a blob `present`, which is why the server verifies hashes
    itself and never trusts a client's claim.
- **Large files.**
  - A 100 MP 16-bit RGB TIFF (600 MB) is 19 parts; an 8 GB video is 256.
  - Limits: 10,000 parts and 50 GiB per file by default.
  - Parts are uploaded 4 at a time and resume per part.
  - The server re-reads multi-part blobs once at commit (sequential I/O, a few seconds per GB).
- **Concurrency.**
  - Client side: N parallel `qa run` processes × 4 workers.
  - Server side:
    - per-token request limits answer `429 Retry-After`;
    - `limit_conn` bounds nginx's buffered bodies;
    - a separate ingest pool keeps the UI responsive (phase 2b).
  - Two runs uploading the same new blob is safe: `link()` into the store fails with `EEXIST` for the
    second, which drops its copy.
- **Compression.** `Content-Encoding: gzip` by default (stdlib), and `zstd` when the `zstandard` module is installed.
  - Only for compressible files: by extension, or when a 64 KiB sample compresses by more than 1.2×.
  - Never for png, jpg, mp4, zip or gz.
  - Packs are compressed as a whole.
  - The server decodes while streaming and stops as soon as the decoded size exceeds the declared size, so
    decompression bombs are bounded.
  - Stored files are uncompressed, so readers don't change.

---

## 5. Server storage layout
**Recommendation: a server-managed root, with URLs unchanged (`/s/<abs path>`).**
```
/mnt/qaboard/                       # QABOARD_UPLOAD_ROOT: inside QABOARD_STORAGE_ROOTS, can be the existing shared storage
  group/repo/ab/cdef0123456789/…    # runs and artifacts, at today's paths (hardlinks or copies)
/mnt/.qaboard-uploads/              # QABOARD_UPLOAD_STATE_DIR: same filesystem (checked with st_dev), not served
  cas/<project_root>/sha256/ab/<hash>   # content store, files chmod 0444
  incoming/<upload id>/…                # parts and packs being received
  trash/<upload id>/…                   # folders replaced by a commit or a re-run
```
**For:**
- No reader changes:
  - nginx, the file browser, Cantaloupe and the image APIs only need the root mounted at the same path
    (backend read-write; proxy at `/var/qaboard/mnt/qaboard`; Cantaloupe already sees `/`);
  - `check_storage_path`, delete and `clean.py` work as-is.
- Mixed fleets get identical paths. A self-hosted runner that mounts the root writes directly (`auto`),
  a GitHub-hosted one uploads, and the server can't tell the difference. That works best when the upload
  root *is* the existing shared storage.
- The server owns the files, so deletes need no `sudo` (`fs_utils.py:41-50`).

**Against:**
- A POSIX volume is required on the server: fine for Compose. On Kubernetes, backend, proxy and Cantaloupe
  share the volume (RWX across nodes, or co-located pods). WS8's `results` value provides it.
- The root's path is baked into the database (`output_dir_override`), so moving it means a rewrite.
- Object storage needs a mapping layer (§10.2).

**Rejected alternative: run-id URLs** (`/u/<run id>/…`). They would decouple paths, but every reader
would change (IIIF identifiers, the file browser, manifest URLs, logs) for no gain until object storage.

**Hardlinks:**
- **Where they don't work** (some SMB or FUSE filesystems, detected at startup): copy, and the content
  store becomes a transfer cache only.
- **Risk:** a process that opens a linked file for writing would change it for every run sharing it.
  - Mitigations: store files are `0444`. Server-side runs clean their folder first (`unlink`, which is
    safe) and must not run as root. Writes in place (`--keep-previous`) on an uploaded run fail with
    `EACCES` instead of corrupting.
  - `QABOARD_UPLOAD_DEDUPE=hardlink|copy|off`.
- **Durability:** fsync each blob and its folder before linking it into the store, else a crash could leave
  a zero-filled "verified" blob that later runs would link.

---

## 6. Authentication and security

### 6.1 Tokens and per-project permission
Builds on today's `Token` (`User.py:56-91`) and the `Authorization: Bearer` request loader (`auth.py:230-246`).

**Data model:**
- Store `token_hash` (sha256) instead of the token. Existing tokens are hashed in place by the migration.
- Add `name`, `scopes` (`read`, `ingest`, `act`), `projects` (patterns like `group/repo`, `group/*`),
  `last_used_at` and `created_by`.
- The migration also fixes the `data` and `expires_at` drift (§1.3).
- `act` covers redo, tuning and deletes. Today, any token can do everything its user can.

**API:**
- `GET/POST /api/v1/user/tokens`, and `DELETE /api/v1/user/tokens/<id>`.
- The token is shown once. The default expiry is 1 year (`expires_at` is set).
- The existing `POST /api/v1/user/token/` stays as a legacy alias with every scope.
- A small "API tokens" page in the user menu.
- `?token=` is refused for writes: it ends up in access logs.

**Permission to ingest into project P:**
1. a valid token with `ingest`, whose `projects` match P;
2. `is_authorized_user(user, P)` (`auth.py:333`): read access, from `QABOARD_LOGIN_RESTRICTED_YAML`;
3. optionally, a new `ingest:` section in the same YAML, with the same rules as `projects:` (`matches_rules`,
   `auth.py:312`). Without it, any user with read access may write.

**Per-repository CI tokens:** a token created by a maintainer with `scopes: [ingest]` and
`projects: [group/repo]`, stored as a CI secret. Phase 4 can accept GitHub/GitLab OIDC JWTs instead
(audience: the server; claim: the repository), so no secret is needed.

### 6.2 Requiring tokens for ingest
- **Uploads always need a token.** An unauthenticated upload endpoint would be an open file host.
- **Metadata ingest** (`POST /api/v1/output/`, `/batch/`, `/commit/`, `/output/<id>/log`) goes through
  `QABOARD_INGEST_AUTH`:
  - `off`: today's behaviour;
  - `warn`: accept, but flag `data.ingest_auth = false` and log;
  - `token`: require a token.
- **Defaults:** quickstarts and Helm default to `token`; existing deployments start with `off` and move through `warn`.
- **Runs QA-Board starts** (tuning, redo) get a short-lived token (24 h, `ingest` on that project) through the
  environment of the process the server starts, never written into `qa_batch.sh` or `redo.sh`. Runs on LSF
  as another Unix user are open question 8.

### 6.3 Limits and quotas
| Limit | Default (env) |
|---|---|
| Part size, maximum body | 32 MiB (8–64 MiB, `QABOARD_UPLOAD_PART_SIZE`) |
| Per file, per run, files per run | 50 GiB, 200 GiB, 100k (the file browser lists at most 100k entries, `files.py:21`) |
| Open uploads per token, data requests in flight per token | 64, 32 (`429`) |
| Live log size | 256 MiB |
| Session lifetime | 24 h |
| Per-project quota | none (`QABOARD_UPLOAD_QUOTAS`: YAML `{project prefix: 2TB}`) |
| Free-space floor | refuse new uploads below 5% free (`507`) |

Quotas count physical new bytes (`bytes_new` at commit; GC subtracts what it frees) in `project_storage`.
GC reconciles them with a scan of the content store.

### 6.4 Untrusted input: paths, archives, content
- **Paths.**
  - The server builds every absolute path from its root and the relative run path, which must be under
    `<project_root>/` of the token's project. A token for `group/a` can't write into `group/b`.
  - Every relative path (run folders and manifest entries) must be NFC UTF-8, with no NUL, `\`, leading
    `/`, empty, `.` or `..` segments; segments of at most 255 bytes and paths of at most 4096; no
    `.qaboard*` names; no file that is also a folder.
  - Files are only created in folders the server just made (`incoming`), with `O_NOFOLLOW`. Clients can't
    create symlinks, so nothing redirects writes. Symlinks in outputs are skipped with a warning; phase 4
    can allow links that stay inside the run folder.
- **Archives.** Packs are the only archives. Members must be regular files (no links, devices or GNU sparse
  files) named by their hash, and their size is bounded by the manifest. Decoding is bounded by declared sizes (§4.6).
- **Content.** Nothing is executed or parsed at ingest, except tar headers. Serving needs fixes, since
  anyone with a token can write HTML (§1.3):
  - the HTML viewer renders in `<iframe sandbox srcdoc>`, never `dangerouslySetInnerHTML`;
  - `/s/` sends `X-Content-Type-Options: nosniff`, plus `Content-Security-Policy: sandbox allow-scripts`
    for `text/html` and `image/svg+xml` (a `map` on `$sent_http_content_type`);
  - `/iiif/` gets `auth_request`, with `/api/v1/files/authorize?iiif=<identifier>`;
  - the image APIs check `is_storage_path` and read access;
  - the manifest endpoint never rewrites a committed upload's manifest, and `refresh` needs a login.
- **Storage settings.** `Project.storage_roots()` maps `storage: upload` to the upload root. Otherwise
  `location_from_spec("upload")` returns a relative path (`qaboard/conventions.py:19-32`), the restricted
  folders of upload projects aren't computed (`api/files.py:49-56`), and their files would be public. The
  upload root must not be in `QABOARD_FILES_UNIX_PERMISSIONS`: the server owns every file there.

### 6.5 Retention and garbage collection
- **Nothing new for runs.** `clean.py` (`storage.garbage.after`) and the delete APIs remove run folders, which only unlinks.
- **New** `backend/backend/scripts/gc_uploads.py`, run daily by the same scheduler (cron or a Kubernetes CronJob):
  1. **Expired sessions:** free `incoming/`. If their Output is still pending, mark it failed with
     `data.error = "upload expired"`.
  2. **Commits:** finish or roll back those stuck in `committing`.
  3. **Trash:** delete folders older than 1 h.
  4. **Content store:** delete blobs with `st_nlink == 1` and `ctime` older than 24 h.
     - In copy mode, evict blobs older than 7 days instead.
     - Race: a begin saw `present`, then GC deleted the blob. Commit answers `409 missing`, the client
       uploads it, and the commit retries: it heals itself.

---

## 7. Readers with uploaded runs
| Reader | With uploaded runs | Change |
|---|---|---|
| nginx `/s/` | Same paths, root mounted in the proxy | Mount; deny `/.qaboard*`; headers (§6.4) |
| File browser, `run_of_folder` | Root is in `QABOARD_STORAGE_ROOTS`, and `output_dir_override` is absolute as today | Add the state folder to `private_dirs()` (`storage.py:24-36`). Owners show as the server's user |
| Manifests | The server writes them at commit, with `sha256` | Never recomputed for committed uploads (§6.4) |
| Cantaloupe | `FilesystemSource` reads the same path | None |
| Pixel tooltip, ROI diff, report | Same paths | Checks (§6.4) |
| Restricted files | `auth_request` as today | `Project.storage_roots()` for `storage: upload` (§6.4) |
| Delete | Unlinks; the content store is freed by GC | None (no sudo needed) |
| Mark failed | Database only | None |
| Redo, tuning | Need a runner that mounts the root (`local`, `celery`, later Kubernetes Jobs) and the artifacts | The `qa` started by the server runs in `auto` → direct; a short-lived token (§6.2) |
| Artifacts | `qa save-artifacts` uploads with `target.artifacts`. Commit merges files into `artifacts_commit_root` and writes `manifests/<group>.json` (no swap: artifacts are additive) | CLI. Binaries built on hosted runners must run in the server's runner image (open question 6) |
| Bit-accuracy | References come from the API, not from storage (below) | CLI |
| Live logs | The CLI appends, nginx serves `log.txt` with Range | Log endpoint |
| Batch logs | `qa-batch-logs/…` (`qaboard/batch_logs.py:47`) uploaded at the end with `target.batch_id` | CLI |

**Bit-accuracy without downloading everything.** Manifests already carry an md5 per file, so comparisons
need manifests, not files.
1. `batch_info(ref_commit, batch)` (`qaboard/api.py:218`) lists the reference outputs. Match them by relative
   run path, or with `matching_output` (`:282`) under `QA_BATCH_COMPLEX_MATCHING`.
2. `GET <output_dir_url>/manifest.outputs.json` for each, cached in staging by commit.
3. `cmpmanifests` on dicts compares `md5` (Windows-normalized, as today) and falls back to `sha256` when
   `md5` is missing.
4. Files are downloaded only when needed: with `QA_BITACCURACY_CMP` (custom compare, `bit_accuracy.py:30`),
   or when a manifest is missing. Then only the files whose hashes differ, with the token, into a cache.

The new side comes from the local staging manifests (`QA_STAGING_KEEP=manifests` is enough).
`check-bit-accuracy-manifest` compares against manifests stored in the inputs database, so it doesn't change.

---

## 8. Data model changes (one alembic migration)
- **`tokens`:**
  - add: `token_hash` (unique), `name`, `scopes` JSONB, `projects` JSONB, `last_used_at`, `created_by`;
  - change: `expires_at` becomes nullable, `data` is added if missing;
  - drop the plain-text `token` once hashed.
- **`uploads`:**
  - identity: `id` uuid, `idempotency_key` (unique per token);
  - owner: `project_id`, `user_id`, `token_id`;
  - target: `kind` (`output|batch|artifacts`), `output_id` / `batch_id` / `ci_commit_id`, `target_dir`;
  - state: `state` (`open|committing|committed|aborted|expired|superseded`), `files` JSONB (the manifest),
    `bytes_total`, `bytes_new`, `commit_step`, `error`;
  - timestamps: `created_at`, `expires_at`, `committed_at`.
- **`upload_parts`:** `(upload_id, sha256, part)` primary key, `size`, `received_at`. Only for multi-part blobs.
- **`project_storage`:** `(project_root)` primary key, `bytes`, `files`, `updated_at`. Used for quotas.
- **`outputs`:** no new column. `data.upload = {id, committed_at, bytes, bytes_new}`, and
  `data.storage` (the total size, already sent at `qa.py:352`). `to_dict()` adds `storage_path` (relative
  to the root) for the CLI's matching.

---

## 9. Failure modes
| Failure | What happens |
|---|---|
| CLI killed mid-upload | The Output stays running. A rerun or `qa upload --pending` resumes the same session. Otherwise GC expires it after 24 h and marks the run failed |
| Network drop on a part | Retried (idempotent per part). After `QA_UPLOAD_TIMEOUT`, the run is pending locally and the job exits 1 in CI |
| Digest or size mismatch | `422`. The CLI re-reads the file once (it may have changed under us), then fails the run with the path |
| Two attempts for the same run | The newer begin supersedes; the older client gets `409 superseded` and stops |
| Backend restarts during commit | `commit_step` is recorded. A retried commit or GC finishes it; the swap is the only non-idempotent step and is checked before redo |
| Disk full or quota | `507` before any byte is accepted (estimated from `bytes_new`). The CLI says which limit, and the project |
| GC deletes a blob a session saw as present | `409 missing` at commit; the CLI uploads it and commits again |
| Server unreachable at start | `auto`: direct if the storage is mounted, else staging and `pending`. `always`: staging and `pending` |
| Old CLI, `storage: upload` | `400` naming the minimum version |
| `qa batch` matching after a crash | A pending run without a committed upload counts as failed. Today's fallback reads local `metrics.json` and would wrongly mark it done |

---

## 10. Migration and phasing

### 10.1 Mixed shared-storage and upload projects
- Uploads are off until `QABOARD_UPLOAD_ROOT` is set. Shared projects and old CLIs are unaffected, and
  nothing about URLs changes.
- A project can mix both, even within one commit. With `upload: auto`, and the upload root equal to the
  shared root, the paths are identical. If the roots differ, each Output still points to its own folder;
  artifacts follow the last writer (`outputs.py:226`), so keep one mode per project for tuning.
- **SIRC-style deployments:** keep shared storage, adopt tokens through `QABOARD_INGEST_AUTH=warn`, and use
  uploads only where storage isn't mounted.

### 10.2 Object storage (phase 3)
The protocol is ready for it. What changes:

**Backend:**
- A `BlobStore` interface (`fs`, `s3`) for S3, R2, GCS (XML API) and MinIO.
- Begin returns presigned PUT and part URLs. Commit completes the multipart uploads and verifies
  `x-amz-checksum-sha256` where the provider supports it, else reads the object back.
- Packs still go to the server, which writes each member as an object.
- Run files become objects at `<prefix>/<run path>/<file>`: a server-side copy from the content store, or no
  copy, by resolving through the manifest.
- Deletes become object deletes, and GC partly moves to lifecycle rules.

**nginx `/s/`:**
- `auth_request` stays. The backend answers with `X-Accel-Redirect` to an internal location that proxies to
  the bucket with a presigned URL: same origin, Range works, no CORS.
- Optionally, a 302 to a presigned URL for large downloads and videos, which offloads bandwidth.

**Readers:**
- The file browser lists from manifests and the database instead of `os.scandir`.
- Cantaloupe uses `S3Source` with `ScriptLookupStrategy`, mapping the absolute-path identifier to a bucket
  key, and keeps `FilesystemCache` (`cantaloupe.properties:315`) for untiled 100 MP TIFFs.
- The pixel and ROI APIs read through the image cache folder.

**Server-side runs:** artifacts are materialized to scratch storage; outputs use upload mode.

### 10.3 Phases and sizes
S ≤ 2 days, M ≈ 1 week, L 2-3 weeks, XL 4+ weeks, for one engineer or one agent workstream with review.

| Phase | Content | Size |
|---|---|---|
| **1. Ingest security baseline** | Token model and migration, tokens API and page, `QABOARD_INGEST_AUTH`, HTML viewer sandbox, `/s/` headers, IIIF `auth_request`, image API checks, manifest refresh fix, admin docs on exposing a server | M |
| **2a. Upload core** | `/api/v1/config` uploads, models, begin/blobs/parts/packs/commit (copy mode), log endpoint, swap, CLI modes and staging, `qa upload`, relative-path matching, compose overlay, docs, release note. Unblocks the GitHub-hosted runner tutorial (overhaul plan §5) | L |
| **2b. Efficiency and completeness** | Hardlink dedupe and GC, quotas, artifacts and batch logs, bit-accuracy via the API, async commit, ingest pool, chart values, `helm-e2e` coverage, load test | M-L |
| **3. Object storage** | §10.2 | XL |
| **4. Later** | GitHub/GitLab OIDC tokens (M), safe symlinks in outputs (S), zstd by default (S) | — |

---

## 11. Test plan

**Backend unit tests** (`backend/tests/`, pytest, alongside `test_storage.py`, `test_files.py`, `test_security.py`):
- Path validation: traversal, absolute paths, NUL, unicode normalization, length, `.qaboard*`, file/folder clashes.
- Writes outside the token's project are refused.
- Tokens: hashing, scopes, project patterns, expiry, revocation, `?token=` refused for writes,
  `QABOARD_INGEST_AUTH` off/warn/token on every ingest endpoint.
- Sessions:
  - begin is idempotent; parts at offsets, out of order, duplicated;
  - digest and size mismatches; commit with missing blobs; double commit; supersede; expiry.
- Packs: links, devices and sparse members, a name that isn't the hash, oversized members, gzip and zstd bombs.
- Content store: dedupe hits, the `EEXIST` race, `0444` files, fsync ordering (with a fault-injecting fs shim),
  and copy mode when `link()` fails.
- Swap: a crash at each `commit_step`, then recovery; `RENAME_EXCHANGE` and its fallback.
- Log appends: overlap and gaps.
- GC: `nlink`, grace periods, expired sessions mark outputs failed.
- Readers:
  - the manifest endpoint doesn't rewrite committed uploads;
  - `restricted_project_dirs` covers `storage: upload`;
  - the image APIs refuse paths outside the storage;
  - quotas answer `507`.

**CLI unit tests** (`tests/`, green):
- Mode resolution (string, dict, env, `auto` with a matching or missing marker, old server).
- Staging and relative paths; Windows paths stay POSIX.
- md5 and sha256 in one pass, with Windows line-ending normalization.
- The uploader against a test server:
  - resume after a kill;
  - `429 Retry-After`;
  - `410` restarts;
  - `QA_UPLOAD_ERRORS`.
- `qa upload --pending`; `job.py` matching; bit-accuracy from API manifests, with a lazy file download for custom compares.

**Web app:** a Vitest test that the HTML viewer renders in a sandboxed iframe.

**E2E in the Compose CI stack** (the `docker` job in `.github/workflows/ci.yaml`, after "Smoke Test @api"):
- **Setup:**
  - an overlay sets `QABOARD_UPLOAD_ROOT` and mounts the volume in the backend, proxy and Cantaloupe;
  - the test creates a user and a token through the API.
- **The run:** `qa --share batch` runs a tiny example in a *separate container without the volume*.
- **Checks:**
  - the runs aren't pending, and the manifests have `sha256`;
  - `GET /s/<file>` returns the same bytes;
  - IIIF `info.json` answers `200` for an uploaded PNG;
  - a Range request on `log.txt` answers `206` while a slow run is running;
  - the file browser's JSON lists the folder;
  - delete removes the files.
- **Re-runs:** a second, bit-accurate run sends about 0 bytes (`bytes_new == 0`).
- **Refusals:** no token gets `401`, another project's token `403`, a traversal attempt `400`.
- **Phase 2b:** a Playwright check that the commit page shows an uploaded image.

**E2E in the planned `helm-e2e` kind job** (overhaul plan §5, WS8):
- Install the chart with the `results` volume and uploads on.
- Run a batch from a pod *without* the volume (upload), and one from a toolbox Job *with* it (`auto` →
  direct). Both appear with identical path conventions.
- `helm upgrade` keeps the content store and open sessions.

**Fault and load tests:**
- Fault injection in CI: SIGKILL during upload then a rerun; a backend restart during commit; a small tmpfs
  that fills up (`507` and the CLI's message).
- Load test, manual or nightly: 200 concurrent runs of 50 MB each. The UI API's p95 must stay under
  500 ms with the ingest pool split.

---

## 12. Open questions for the maintainer
1. **Ingest auth timeline:** `QABOARD_INGEST_AUTH=token` by default for new installs and quickstarts, and
   existing deployments move off → warn → token. OK? Large on-prem deployments would need a CI token
   distributed through the site package.
2. **Upload root:** the existing shared storage (recommended, identical paths in mixed fleets), or a
   separate volume?
3. **Hardlink dedupe** with `0444` store files, and no server-side runs as root: acceptable on your NFS?
   The fallback is copies, with dedupe for bandwidth only.
4. **Dedupe scope:** per repository (recommended, no cross-project probing), or global for more savings?
5. **Runners in upload mode for phase 2:** `local` only (recommended), with Celery, Dask and LSF workers
   uploading later? They need the token and network access.
6. **Tuning and redo for upload-only projects** need binaries uploaded as artifacts that run in the server's
   runner image. Accept that limitation for v1, or wait for containerized runners (Kubernetes Jobs, roadmap)?
7. **Failed uploads in CI:** fail the job (recommended), or warn as metadata failures do today?
8. **Runs QA-Board starts as another Unix user** through the LSF bridge: how should they receive a
   short-lived token? It can't be readable by other users or written into scripts.
9. **Limits:** part 32 MiB, file 50 GiB, run 200 GiB, 100k files, log 256 MiB. Do they fit the largest
   real runs you know of?
10. **OIDC:** pull GitHub/GitLab OIDC tokens (no stored secret) into phase 2, or keep them in phase 4?
11. **First object store:** MinIO (self-contained, good for the Kubernetes quickstart) or S3/R2?
12. **Staging:** keep by default (recommended, like local `output/`), or delete bulk files after a
    committed upload?
