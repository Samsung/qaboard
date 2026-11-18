# Sending results without `qa run` or a shared storage: `start_run()`, `qa upload`, HTTP upload

Status: v5 (2026-11-18). A first version is implemented, as experimental: §1 says what, §2 the decisions behind it,
§3 what is left. v5: uploads on by default, an end-to-end test in CI, and where storage settings should live. v4 added storage locations (runs store their full location), heartbeats, and `check-bit-accuracy`
and `optimize` without a shared storage. v1 (2026-10-26) proposed a separate run client; v2 (2026-11-14) rebuilt the plan on
`qaboard.start_run()` (`docs/rfcs/python-sdk-runs.md`). `docs/design/http-upload.md` is the full protocol this
implements a small part of. Known limits: `docs/warts.md` ("Results sent over HTTP").
User docs: `website/docs/upload-results.mdx`, `storage/uploads.mdx`, `backend-admin/uploads.mdx`.

## 1. What is built

| Piece | Where |
|---|---|
| `qa upload`: files other tools wrote become a run, without a `run()` | `qaboard/upload_command.py`: `start_run()` from the shell |
| Metrics from test reports and benchmark files | `qaboard/junit.py` (`junit_metrics`), `qaboard/benchmarks.py` (`benchmark_metrics`) |
| Recognized files (tests, benchmarks, profiles) on the cards of runs created from code, without qaboard.yaml | `webapp/src/viewers/runView.js` (`with_run_files`), names in `viewers/fileTypes.js` |
| Results sent over HTTP: no `storage`, `storage: upload` or `QA_STORAGE=upload` | `qaboard/config.py` (`uploads_files`), `qaboard/payloads.py` (`"storage": "upload"`) |
| The uploader, shared by `qa run` and `start_run()` | `qaboard/upload.py` |
| The server: one folder, one endpoint | `backend/backend/uploads.py`, `PUT /api/v1/output/<id>/files/<path>` in `backend/api/outputs.py`, `QABOARD_UPLOAD_ROOT` |
| `start_run(label=, batch=)`, the project in CI, the guard inside `qa run` | `qaboard/active_run.py` |
| Storage locations: buckets or disks added while the server runs, per project; runs store their full location | `backend/backend/locations.py`, `models/StorageLocation.py`, `qaboard-admin storage-locations` |
| Heartbeats: runs that stop reporting are failed | `qaboard/heartbeat.py`, `backend/backend/heartbeats.py` (`QABOARD_SILENT_RUN_TIMEOUT_MINUTES`) |
| `qa check-bit-accuracy` against references on the server: their manifests over HTTP, cached | `qaboard/bit_accuracy.py` (`fetched_manifests`) |
| On by default: a server with the default storage takes files in `/mnt/qaboard` (a volume in `docker-compose.yml`, the chart's results volume); refusals say why (`uploads.off_reason`, also in `/api/v1/config` for `qa doctor`) | `backend/backend/config.py` (`_upload_root`) |
| End-to-end test: `docker-compose.yml` without an overlay, `qa upload` and `start_run()` from the checkout, files through nginx and the image server | `.github/scripts/uploads_e2e.py`, CI's `docker` job |

### How a run without a shared storage goes
1. The run is saved like a local one, in the project's `output/` folder. Nothing new on the client's disk: no
   staging area, no state file.
2. `POST /api/v1/output/` with `"storage": "upload"` creates it. **The server chooses the folder**,
   `<upload root>/<project>/-/<commit>/<batch>/<configuration>/<input>/`, and empties it when a run starts again
   (not for `--keep-previous` and `resume=True`). Clients never send a folder, and what they say about the run only
   reaches the path as folder names the server makes (`uploads.folder_name`: a slug, with a hash unless the text was
   one already). Before it writes or deletes, the server checks that the folder is one it could have chosen for that
   project (`uploads.is_run_dir`), for a run it marked as uploading (`data.uploads_files`): the folder the database
   has isn't trusted, since other clients say where they saved theirs.
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
| Metrics of uploaded files | The existing readers, by the same file names as the web app's viewers. Explicit `-m` wins | Reuse; one definition of "is a test report" per side, both tested on `tests/fixtures/file-types.json` |
| Default run name of `qa upload` | In a CI job `<job>/<file>` (the job alone with several paths), elsewhere the file's name; `--input` for names that last | Two jobs that upload a junit.xml, or one job that uploads two files in turn, must not replace each other |
| Syncing later | Not built. A request is tried 3 times; a run the server never heard of is not sent later | Not worth new commands yet |
| Heartbeats | Clients that send them say so when the run starts (`heartbeat: true`); `qa run` and `start_run()` then report at least every 2 minutes (`PATCH .../progress`, empty for a bare heartbeat). Every report of a running run sets `outputs.reported_at`; the jobs worker fails those silent for 15 minutes, with `data.failed_reason` like "Fail stuck runs", and a silent run that reports again runs again | Old clients never send them, so they are never failed for being silent. No new endpoint, no new state: the run's state, like everything runs report |
| Projects created before runs | Out of scope: `qa` still creates projects by sending results | Comes with project permissions |
| `--append` to a finished run | Dropped: one upload is one run | Finished runs don't change; fewer states |
| Which protocol | One `PUT` per file, with an offset to append, and no session, parts or content store | Test reports, benchmarks, logs and most images are small. Parts and deduplication wait for a project with huge outputs and no shared storage |
| Who chooses the folder | The server, from the run's identity. Paths clients name are inside it, validated, written to a temporary name then renamed | Clients can't write anywhere else; no path of the client's machine reaches the server |
| Tokens | Always, for files and for creating a run that uploads, whatever `ingest.auth` says | Whoever can upload stores files the server then serves |
| Storage backends in the server | **One: a folder.** Object storage is mounted as a file system by the deployment (S3 Files, JuiceFS...); files are only renamed inside a run's folder | Every reader (nginx, Cantaloupe, the file browser, deletions) already works on files. A second backend would touch each of them (§4) |
| Where a run is, with many buckets | **Each run stores its full location**: a path as before, or a URL (`s3://bucket/prefix/<project>/-/...`). A table of *storage locations*, edited while the server runs, maps URL prefixes to how the server reaches them (today: where they are mounted) and to the projects whose new runs go there. `Output.output_dir` resolves it (`locations.local_path`); unreachable locations resolve to a folder that doesn't exist | No name or id to keep in sync: editing a location (mount, later credentials) never strands runs, a public instance can add buckets it doesn't own without a restart, and runs of one project can be in several buckets. Credentials and native access attach to the location row later (`options`), not to runs |
| Default when no `storage` is set | Send to the server | It was an error before; new projects need no storage line |
| Does a new server take files? | Yes, when it has the default storage: `QABOARD_UPLOAD_ROOT` unset, `QABOARD_STORAGE_ROOTS` unset, and `/mnt/qaboard` writable. `off` turns uploads off. Sites that set their storage roots choose the folder | The client's default (send to the server) met a server that refused it: a new project and a new server didn't work together. Files always need a token, so being on costs little. At SIRC (storage roots set) nothing changes |
| Where storage settings live | **The boundary in environment variables, the routing in the database.** Storage roots (and today the upload root) say where the server may write and delete: someone who takes over an admin's session must not move them (`settings.BOUNDARY`). Which folder a project's runs go to, inside them, is data: storage locations, edited without a restart | A new folder needs mounts in nginx and the image server anyway, so a restart. Today `qaboard-admin storage-locations add` takes any absolute path: the boundary is "has a shell on the server". Next (§3): locations must be inside a storage root, the upload root becomes the default location, and admins edit locations in the web app |
| What needs a shared storage | Artifacts and runs started from the web app (tuning, redo). `qa save-artifacts` does nothing and says so, so one CI job works both ways. `qa check-bit-accuracy` compares the reference's manifests, fetched over HTTP once per finished run; `qa optimize` reads metrics from the API | The server has no build and no inputs. Bit accuracy only needs hashes: no file downloads |

## 3. What is left
In `docs/warts.md`, with sizes. The ones that matter first:
1. ~~An end-to-end test in CI~~ (v5: `uploads_e2e.py`). Still to do: a try on Windows; `qa check-bit-accuracy`
   against an uploaded reference in the same test.
2. **Runs the server starts, without a shared storage.** The code of a commit must reach the job. What the industry
   does: on HPC schedulers (Slurm, LSF), a shared file system, as QA-Board does today; on Kubernetes and cloud
   batch, either an image per commit built by CI (W&B Launch, Kubeflow, Argo), or a stable base image and a code
   bundle fetched at start (SageMaker's `source_dir`, Ray's `working_dir`). Next steps, in order:
   - `{commit}` in `runners.kubernetes.image`, checked in the registry before launching ("no image for this
     commit" rather than `ImagePullBackOff`). Small; covers teams that build an image per commit.
   - Artifacts through the server: `qa save-artifacts` uploads the bundle with the same `PUT`, jobs fetch it once
     per node into a cache keyed by its hash. Covers everyone else, including a public instance.
   Inputs and datasets stay the user's (mounts, buckets, their code), as with every tool above.
3. `qaboard.local_path("qaboard://<run>/checkpoints/last.pt")`: a run's file as a local path, from the folder when
   its location is mounted here, else downloaded once into a cache keyed by the manifest's hash. Like W&B's
   `use_artifact().download()` or MLflow's `download_artifacts("runs:/...")`, for checkpoints. Shares the cache of 2.
4. Storage locations: a web app page, credentials (encrypted, `backend/encryption.py`), the scans and the file
   browser on locations, clients that mount a location writing there directly, then maybe native access (§4).
5. From the reviews of the first version, not done yet (each S unless said):
   - One object for a run's reporting (uploader, heartbeat, "the server never heard of the run") shared by
     `qa run` (module globals in `qaboard/qa.py` today) and `start_run()` [M]; the CLI's "can I read this run's
     folder here?" checks (`uploads_files` in `runners/job.py`, `bit_accuracy.py`, `qa.py`) as one helper.
   - The upload root as the default storage location, so that `uploads.bases()`, `locations.paths()` and the storage
     roots read one list; locations' paths checked to be inside a storage root (the boundary stays in the
     environment, §2); the location changes (`add`, `set`, `remove`) moved from `scripts/admin.py` to `locations.py`
     for a web app page in **Admin → Settings** [M]. `QABOARD_UPLOAD_ROOT` stays, as an override.
   - `bit_accuracy.fetched_manifests` through `results._request` and in a module shared with `local_path()`.
   - The refusal reasons (`uploads_disabled`, `not_running`...) in `qaboard/conventions.py` for the server too, and
     a backend test that runs the real `Uploader` against the Flask app instead of the tests' fake server [M].
   - `storage_usage.py` and the Storage page for runs stored as URLs; a test that fails when code outside
     `models/` and `locations.py` reads `output_dir_override`.
   - `qa upload --dryrun` without a server, printing the run's project, commit and label; CLI wording for the
     `start_run()` errors `qa upload` shows.
6. Quotas per project.
7. For projects with huge outputs: parts, "which hashes do you have", the content store (`http-upload.md`).

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
- A run records where its bulk lives: its full location, a URL (`outputs.output_dir_override`, built in v4). The
  storage location matching it says how to reach it: today a mount, then a profile with credentials.
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
