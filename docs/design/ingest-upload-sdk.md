# Sending results without `qa run` or a shared storage: `start_run()`, `qa upload`, HTTP upload

Status: v3 (2026-11-17). A first version is implemented, as experimental: §1 says what, §2 the decisions behind it,
§3 what is left. v1 (2026-10-26) proposed a separate run client; v2 (2026-11-14) rebuilt the plan on
`qaboard.start_run()` (`docs/rfcs/python-sdk-runs.md`). `docs/design/http-upload.md` is the full protocol this
implements a small part of. Known limits: `docs/warts.md` ("Results sent over HTTP").
User docs: `website/docs/upload-results.mdx`, `storage/uploads.mdx`, `backend-admin/uploads.mdx`.

## 1. What is built

| Piece | Where |
|---|---|
| `qa upload`: files other tools wrote become a run, without a `run()` | `qaboard/upload_command.py`: `start_run()` from the shell |
| Metrics from test reports and benchmark files | `qaboard/junit.py` (`junit_metrics`), `qaboard/benchmarks.py` (`benchmark_metrics`) |
| Recognized files (tests, benchmarks, profiles) on the cards of runs created from code, without qaboard.yaml | `webapp/src/viewers/runView.js` (`with_run_files`), names in `viewers/fileTypes.js` |
| Results sent over HTTP: no `storage`, `storage: upload` or `QA_STORAGE=upload` | `qaboard/config.py` (`uploads_results`), `qaboard/payloads.py` (`"storage": "upload"`) |
| The uploader, shared by `qa run` and `start_run()` | `qaboard/upload.py` |
| The server: one folder, one endpoint | `backend/backend/uploads.py`, `PUT /api/v1/output/<id>/files/<path>` in `backend/api/outputs.py`, `QABOARD_UPLOAD_ROOT` |
| `start_run(label=, batch=)`, the project in CI, the guard inside `qa run` | `qaboard/active_run.py` |

### How a run without a shared storage goes
1. The run is saved like a local one, in the project's `output/` folder. Nothing new on the client's disk: no
   staging area, no state file.
2. `POST /api/v1/output/` with `"storage": "upload"` creates it. **The server chooses the folder**,
   `<upload root>/<project>/-/<commit>/<batch>/<configuration>/<input>/`, and empties it when a run starts again
   (not for `--keep-previous` and `resume=True`). Clients never send a folder.
3. While the run goes on, a thread sends what people look at then: `log.txt` and `series.jsonl` by what was added
   (`?offset=`), `series.json` and `run.json` when they change, and the files matching `outputs.live`.
4. When it ends: everything else, each file with its SHA-256, 4 at a time, **then** the final `POST /output/`. The
   server only takes files of runs that are pending or running, so a finished run's files are all there and don't
   change.
5. From then on they are files of a storage root: nginx serves them under `/s/`, the image server, the file
   browser, exports, deleting runs and retention work unchanged.

Like the SDK's metrics, the uploader sends the state of the folder, not events: it compares files with what it
sent (size and date) and sends what differs. A failed request needs no replay.

## 2. Decisions

| Question | Decision | Why |
|---|---|---|
| A new run client? | No: `start_run()` is the one way to create runs outside `qa run`; `qa upload` is its command line | One vocabulary, one payload definition (`qaboard/payloads.py`) |
| Batch, label or experiment | `label` stays the CLI's word, `batch=` the SDK's; `start_run()` takes both. One alone is the batch in the web app. Both, like `qa --label nightly batch unit-tests`: `label` is the web app's batch, `batch` the group of tests on the run's card (`data.batch`). No `experiment` | Too late to rename `--label`; the two-argument case mirrors `qa batch` |
| Nested runs | Minimal: `qa run` exports `QABOARD_RUN_DIR`, and `start_run()` refuses to start that same run again (it would remove its files). No attaching | Not a concern yet |
| Recognized files on cards | For runs created from code (`data.sdk`): series, test reports, benchmark files, profiles, 4 per kind, unless the project's visualizations already have that kind | `qa upload junit.xml` must show something in a project without configuration |
| Metrics of uploaded files | The existing readers, by the same file names as the web app's viewers. Explicit `-m` wins | Reuse; one definition of "is a test report" per side, tested against each other |
| Syncing later, heartbeats | Not built. A request is tried 3 times; a run the server never heard of is not sent later | Not worth new commands yet |
| Projects created before runs | Out of scope: `qa` still creates projects by sending results | Comes with project permissions |
| `--append` to a finished run | Dropped: one upload is one run | Finished runs don't change; fewer states |
| Which protocol | One `PUT` per file, with an offset to append, and no session, parts or content store | Test reports, benchmarks, logs and most images are small. Parts and deduplication wait for a project with huge outputs and no shared storage |
| Who chooses the folder | The server, from the run's identity. Paths clients name are inside it, validated, written to a temporary name then renamed | Clients can't write anywhere else; no path of the client's machine reaches the server |
| Tokens | Always, for files and for creating a run that uploads, whatever `ingest.auth` says | Whoever can upload stores files the server then serves |
| Storage backends in the server | **One: a folder.** Object storage is mounted as a file system by the deployment (S3 Files, JuiceFS...), per project if wanted: a project's files are all under `<upload root>/<project>/`, and files are only renamed inside a run's folder | Every reader (nginx, Cantaloupe, the file browser, deletions) already works on files. A second backend would touch each of them (§4) |
| Default when no `storage` is set | Send to the server | It was an error before; new projects need no storage line |
| What needs a shared storage | Artifacts, runs started from the web app, `qa check-bit-accuracy`, `qa optimize`. `qa save-artifacts` does nothing and says so, so one CI job works both ways | The server has no build and no inputs |

## 3. What is left
In `docs/warts.md`, with sizes. The ones that matter first:
1. An end-to-end test in CI, against the real server and nginx (the quickstart job), and a try on Windows.
2. Stale runs' heartbeat and sending a run later, with the SDK's follow-ups (`docs/rfcs/python-sdk-runs-follow-ups.md`).
3. Quotas per project.
4. For projects with huge outputs: parts, "which hashes do you have", the content store (`http-upload.md`).
5. Bit-accuracy checks against manifests through the API, so that they work without a shared storage.

## 4. If the server ever talks to object storage itself
Not built, and not planned until a mounted file system proves not to be enough: this is what it would take, kept
from v1.

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
- A run records where its bulk lives: `Output.data.storage = {profile, prefix}`; absent means the filesystem.
- `/s/<path>` keeps its URLs. nginx's `auth_request` asks the backend, which answers with `X-Accel-Redirect` to
  the local alias, or to an internal location proxying a presigned URL of the right bucket (same origin, Range
  works, no CORS). Large videos can get a `302` to the presigned URL.
- Cantaloupe: `S3Source` with a delegate script mapping the identifier to the profile's bucket and key.

### 4.4 Open source to build on
| Need | Pick | Notes |
|---|---|---|
| One API over many storages (put, ranged get, delete, list, presign) | **Apache OpenDAL** (Python bindings; S3-compatible, GCS, Azure, local, WebDAV, SFTP, HDFS…) | **obstore** if the cloud object stores are enough; **fsspec** is slower and presigns per backend. Check presign support per service first. Keep our `BlobStore` to five calls so the library stays swappable |
| Self-hosted S3 for the quickstart, Kubernetes, on-prem | **Garage** or **SeaweedFS**; **Ceph RGW** where Ceph exists | **MinIO**'s community edition stopped shipping binaries in Oct 2025 and is no longer maintained (2026): not the default (`http-upload.md` question 11; the public roadmap still names it) |
| S3 API over an existing NFS | **Versity S3 Gateway** | One code path for shared-storage sites, if ever wanted |
| Exotic storages without code (SharePoint, SMB, SFTP) | **rclone** `serve s3` / `serve webdav`, run by the site | |
| Resumable uploads | Our own parts (milestone 3) | tus: rejected in `http-upload.md` §4.2, still true |

---
