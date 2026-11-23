# Inputs and collections: M1 contract (revised)

This replaces the first contract of the branch. M1 is lean: the foundation input management grows on (annotations,
derived inputs, imports from other tools come later), not those features. Backend, CLI and web app are built against it.

## User journeys M1 must pass

Check every change against these. If one doesn't work end to end, M1 isn't done.

1. **New data, no runs yet.** Someone adds a folder (on disk or S3) as a source of the project. A few minutes later the
   Inputs page shows its inputs with thumbnails and the metadata of their sidecars. They filter (`sensor=IMX766`,
   `lux<10`), select 40 inputs, save them as a personal collection, and run `qa batch hard-cases` on it.
2. **Inputs found by runs.** A project that never set up a source still sees the inputs its runs used, as now.
3. **Personal to shared.** A collection starts personal. Its owner shares it with the project, and teammates use it
   in their batches.
4. **Per-input settings.** A collection member carries settings, like a crop, that the run receives.
5. **From code.** A script adds inputs and their metadata (import API), and another one reads a collection
   (`qaboard.collections.get()`) to train or evaluate.
6. **Another site.** It all works on a server with S3 sources and no shared storage with users, without
   SIRC-specific code (site formats are plugins).

## What ships

- **Sources**: folders of a project's inputs (`file://` or `s3://`, through the storage locations admins add,
  `backend/backend/locations.py`), with globs and sidecar rules. Scanned incrementally, on demand and on a schedule.
- **The Inputs page**: the project's inputs (from sources and from runs), thumbnails, search, folders, metadata filters,
  fast on a million inputs.
- **Collections**: named lists of inputs, owned by a user, personal or shared with the project, with settings per
  member. Batches and scripts use them.
- **Import API**: add inputs and their metadata from scripts.

Not in M1: versions of collections, pins and favorites, collections inherited from parent projects or named across
projects, offline use, notifications on new inputs, annotations, derived inputs.

## Data model

Inputs stay global (`test_inputs`: `database` + `path`, an integer `id`). Members of collections reference inputs by id.
For S3 sources `database` is the source's root URL (`s3://bucket/prefix/`). Never `Path()` it: resolve it with
`locations.local_path` like runs' locations.

```
input_projects           kept as on the branch: which projects have which input, the Inputs page reads only this
  test_input_id, project_id     primary key
  first_seen_at, last_run_at    last_run_at null for inputs only a source found
  runs int                       how many outputs were created (not decremented)
  source_id int null             FK input_sources: the source that found it, null if only runs did

input_sources
  id, project_id FK projects
  url            "s3://bucket/captures/night/", "file:///mnt/data/night/"
  globs          jsonb ["**/*.raw", "**/*.jpg"]
  sidecars       jsonb ["{stem}.json", "{stem}.xmp", "{name}.meta"]   files attached to each input, relative to it
  metadata_from  jsonb ["{stem}.json"]   sidecars parsed (JSON/YAML) into the input's metadata
  created_by, created_at, archived_at
  last_scan      jsonb {started_at, finished_at, status, found, new, gone, errors}

test_inputs (existing)
  data           JSON → JSONB (GIN index for metadata filters), namespaced:
                   data.sidecar   what scans read from sidecars (scans only write here)
                   data.run       what runs report (input_metadata(), qaboard/iterators.py; runs only write here)
                   data.files     {sidecar rule → relative path} of the attached files found
  fingerprint    str null        mtime+size on disks, ETag on S3: rescans skip unchanged inputs, thumbnails key on it

collections
  id, project_id FK projects
  name           "night/hard-cases": "/" nests groups, normalized like milestone groups
  description    text
  user_id        FK users ON DELETE SET NULL: the owner
  shared         bool            false: only its owner lists it; true: everyone on the project (like milestones)
  created_at, updated_at, archived_at
  unique (project_id, name)

collection_members
  collection_id FK ON DELETE CASCADE, position int    primary key (collection_id, position)
  test_input_id FK test_inputs (ON DELETE RESTRICT)
  params        jsonb null       settings the run receives for this input, e.g. {"crop": [0, 0, 1920, 1080]}
```

Metadata never has to be merged: scans and runs write their own namespaces, filters read both. A rescan updates only
`data.sidecar`, `data.files` and `fingerprint`, and only for inputs whose fingerprint changed.

Versions can come later without rewriting this: a `collection_snapshots` table that copies the members. Until then,
each run already records its input, and the audit log records every edit of a collection.

## Scans

- A background job (`backend/backend/jobs/`), started from the source's page, by the import API, or on a schedule per
  source. Lists the files (`os.scandir` or S3 `ListObjectsV2`), matches globs, attaches sidecars, parses `metadata_from`,
  upserts `test_inputs` and `input_projects` in batches of ~1000, then makes the missing thumbnails.
- Incremental: an unchanged fingerprint skips the input. Inputs that are gone are marked (`data.gone_at`), not deleted:
  collections and runs may use them.
- No notifications. The source's page shows the last scan: `+312 new, 4 gone, 2 errors`, and its errors.

## Thumbnails

- Made when scanning (and on first view for inputs only runs found), with the decoders of the branch: the
  `qaboard.thumbnails` entry point for site formats, then Pillow, then the first frame of videos.
- Stored as files and kept: `QABOARD_THUMBNAILS_ROOT/<id % 1000>/<id>-<fingerprint>.webp`, 256 px. The grid only
  loads these static files, served by nginx with long cache headers. A changed fingerprint makes a new file.
- The full screen viewer keeps using the image viewer (IIIF) on the file itself.

## Performance

Measured in the PRs, with a seeding script, on a project with 1M inputs and 10k runs:
first page of the Inputs page < 300 ms, next pages < 100 ms, facets (folders, databases, top metadata values) < 1 s.

- Paging by cursor (`?after=` on the sort key and id), never `OFFSET`.
- Facets have their own endpoint, so the grid doesn't wait for them.
- The default list is all the project's inputs. "Only inputs with runs" is an opt-in filter: it is what was slow.

## Permissions

- Read inputs, sources, shared collections: `project.read`. Personal collections: their owner only (and admins).
- Add or edit sources, start scans, import: `inputs.write` (`developer`).
- Create a collection: `project.read` (it is personal). Edit, share, archive: its owner, or `collections.write`
  (`developer`) for shared ones.
- Every change is audited (`audit('source.create')`, `collection.update`...), registered in `audit_actions.py`.

## API (under `/api/v1`, documented in `backend/backend/openapi.yaml`)

| Method | Path | What |
|---|---|---|
| GET | `/inputs?project=&q=&folder=&source=&where=&live=&sort=&after=&limit=` | `{inputs: [Input], next}`. `where`: `key=value`, `key<10`, `key>=2`, joined by spaces, on `data.sidecar`/`data.run` |
| GET | `/inputs/facets?project=&...same filters` | `{total, folders, databases, sources, metadata: {key: [{value, count}]}}` |
| GET | `/inputs/<id>?project=` | `Input` + its files + the latest runs that used it |
| POST | `/inputs/import` `{project, inputs: [{database, path, files?, metadata?}]}` | upsert, metadata into `data.sidecar`. Up to 10k per call |
| GET/POST/PATCH | `/inputs/sources`, `/inputs/sources/<id>` | sources |
| POST | `/inputs/sources/<id>/scan` | starts a scan |
| GET | `/collections?project=` | the shared ones and yours |
| POST | `/collections` `{project, name, description?, shared?, members: [{input, params?}]}` | 201, 409 if the name exists |
| GET | `/collections/<id>`, `/collections/<id>/members?after=&limit=` | |
| PUT | `/collections/<id>/members` `{members: [...], updated_at}` | replaces the members, 409 if `updated_at` is stale |
| PATCH | `/collections/<id>` `{name?, description?, shared?, archived?}` | |
| GET | `/collections/resolve?project=&name=` | for the CLI: `{collection, members: [Input + params]}` |

`Input`: `{id, database, path, url, name, folder, files, metadata: {sidecar, run}, runs, last_run_at, thumbnail_url}`.

## CLI and Python

Online only: collections are resolved by the server, `--offline` doesn't support them. No hidden `qa` options.

```yaml
# a batch file listed in qaboard.yaml's inputs.batches
hard-cases:
  inputs:
    - collection: night/hard-cases
  configurations: [base]
```

- `qa batch` resolves each collection once, and runs record `collection_id` and the name in their data (as on the branch,
  without the version). Members' `params` reach the run as extra parameters (`run_context.params`).
- When the server lists batches with the project's code (`qa batch --list`), it resolves the collections in-process
  before, as the viewer, and gives them to the listing the simplest way that needs no new `qa` option.
- `qaboard.collections.get("night/hard-cases", project=None) -> Collection`, `.inputs: list[Input]`. `Input` has
  `id, database, path, url, absolute_path, files (dict of sidecar paths), metadata, params` and `.run_context(**overrides)`,
  so scripts can start runs on them (`start_run()` accepts an `Input` too).
- `qaboard.inputs.add([...])`: the import API from Python.
- `qa collections list | show <name> [--json] | save <name> --from paths.txt [--shared]`, and `qa inputs import <file.jsonl>`.

## Web app

- `/<project>/inputs`: search, folder breadcrumb, source and database selects, metadata filters (the facets' top values
  as suggestions), the virtualized grid, selection bar ("Save as collection", "Add to collection"), the full screen viewer
  with the sidecars' metadata and the runs.
- Sources: a tab of the Inputs page, to add one, see its last scan and start one.
- `/<project>/collections/<id>`: members (same grid, with their params), edit (add, remove, set params on the selected
  members), share, archive, and the snippets to use it in a batch file and in Python.
- The sidebar lists your collections and the shared ones, by name groups, like milestones.

## From the current branch (`feature/inputs-and-collections`)

Keep, adapted: `input_projects` and its backfill, `input_catalog.py` (with cursor paging), the thumbnail decoders,
`- collection:` in `iterators.py`, runs recording the collection, the Inputs page and grid, the collection page and
dialogs, the audit events, the tests (`test_migrations.py` included).

Remove: versions (`collection_versions`, `base_version`, `@N` references, the version picker), pins and favorites,
parent-project resolution and `project:name` references, `QABOARD_RESOLVED_COLLECTIONS` and its file, the hidden
`--collection*` options of `qa`, `export.yaml`, the on-request thumbnail cache. Move the `serviceAccounts.js` rename to
its own PR.

## How it lands

Stacked PRs, each reviewable on its own:

1. **Backend**: sources, scans, `test_inputs.data` as JSONB, stored thumbnails, the inputs and import endpoints, the
   seeding script and the timings above.
2. **Web app**: the Inputs page and sources.
3. **Collections**: tables, endpoints, batch files, the SDK, `qa collections`, the collection page and sidebar.

## Open questions

- S3 inputs in runs: do scripts get a URL and read it themselves, or does the SDK download and cache them
  (`Input.local_path()`)? M1 can give URLs only.
- Folders as inputs (`inputs.type` with `use_parent_folder`): a source rule that makes a folder one input?
- Routes `/<project>/inputs` and `/<project>/collections` take the short URL of projects named like `team/inputs`:
  accept it, or find routes that don't collide.
