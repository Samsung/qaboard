# Inputs and collections (rollout 1 of 5)

The full design, with the later rollouts (annotations, training caches, kept outputs, imports), is in the
"Input catalog and collections" design doc. This page is the contract for rollout 1: what ships, the data model,
the API, and what's left for later. Backend, CLI and web app are built against it.

## What ships

- **An Inputs tab per project**: every input that runs of the project (and of its subprojects) used, with a thumbnail,
  searchable by path, filtered by folder (path prefix) and by database, by default only inputs that still have runs
  that weren't deleted. Clicking an input opens it full screen in the image viewer, with the runs that used it.
- **Collections**: select inputs, save them as a named collection of the project (`night/hard-cases`). Collections are
  versioned: saving changes makes a new version, older versions never change (`night/hard-cases@2`). They belong to
  a project, subprojects see them too. They are archived, never deleted. Who created each version is recorded.
- **A page per collection**: its inputs (same grid as the Inputs tab), its versions, how to use it from Python and
  from qaboard.yaml.
- **Favorites and team pins**: users star collections; developers pin a collection for one of their groups,
  owners for everyone on the project. The sidebar lists pinned and favorite collections, like milestones.
- **`collection:` in qaboard.yaml batches** and `qaboard.collections.get()` in Python, resolved by the server.

Not in rollout 1: annotations and crops (rollouts 2-3), training caches `inputs.load()` (3), kept outputs, labels,
drafts (4), imports, derivatives, "Used in runs" filters by origin/team, retiring (5).

## Data model

Inputs stay global (`test_inputs`: `database` + `path`, an integer `id`). We expose that id: collections reference
inputs by id, never by path, so namespaces can be added later.

```
input_projects            which projects used which input: the Inputs tab reads only this table
  test_input_id  int  FK test_inputs.id ON DELETE CASCADE   ┐ primary key
  project_id     str  FK projects.id    ON DELETE CASCADE   ┘
  first_run_at   timestamp
  last_run_at    timestamp      index (project_id, last_run_at desc)
  runs           int            how many outputs were created (not decremented on delete)

collections
  id            serial
  project_id    str FK projects.id ON DELETE CASCADE
  name          str             "night/hard-cases": "/" nests groups, normalized like milestone groups
  description   text
  created_by    int FK users.id ON DELETE SET NULL
  created_at, updated_at
  archived_at   timestamp null  archived: hidden by default, still resolvable
  latest_version int
  unique (project_id, name)

collection_versions       immutable once written
  id, collection_id FK ON DELETE CASCADE, version int, unique (collection_id, version)
  created_by, created_at, notes text, size int

collection_members
  version_id FK collection_versions.id ON DELETE CASCADE, position int   primary key (version_id, position)
  test_input_id FK test_inputs.id  (ON DELETE RESTRICT: inputs of collections are never removed)
  region jsonb null               reserved for annotations (rollout 2), always null now

collection_favorites      (user_id, collection_id) primary key, created_at
collection_pins           (collection_id, group_id) unique, group_id null = everyone; pinned_by, created_at
```

`input_projects` is upserted when an output is created (`api/outputs.py`, where `TestInput.get_or_create` runs, and
runs imported from storage scans, `jobs/storage_actions.py`), for the batch's project: in a savepoint of the run's
transaction, only for new outputs (a run's status updates don't touch it). The migration backfills it from outputs →
batches → ci_commits (one `INSERT ... SELECT ... GROUP BY`, `ON CONFLICT DO UPDATE` with the earliest first run, the
latest last run and the most runs: the app may have recorded runs before the migration). A project's inputs are those
of `input_projects` rows for the project or its subprojects (`project_id = P or project_id LIKE 'P/%'`, escaped).

"Has live runs" (the default filter) is `EXISTS (ci_commits c JOIN batches JOIN outputs o WHERE project in scope AND
o.test_input_id = ... AND NOT o.deleted)`, driven by the scope's batches: one index-only probe each in the partial
index `ix_outputs_live_test_input_id_batch_id` (`outputs (test_input_id, batch_id) WHERE deleted IS NOT TRUE`, built
CONCURRENTLY by the migration). Measured on 7.6M outputs: an input with 2.3M runs in other projects and only deleted
ones in scope answers in 3 ms (2.2 s when driven by `outputs.test_input_id`); a first page with 50k inputs in scope ~0.4 s.

## Names, versions, inheritance

- Names: 1-200 characters, `[A-Za-z0-9._ -]` segments joined by `/`, normalized (`" night / hard "` → `night/hard`).
- A reference is `name`, `name@3` or `name@latest`. From project P it resolves to P's collection, else to the nearest
  ancestor project's (`a/b/c` looks in `a/b/c`, `a/b`, `a`). A reference can also name the owner explicitly:
  `a/b:night/hard@2` (project, colon, name).
- Saving changes to a collection creates version N+1 with the full list of inputs (no diffs), and fails with 409 if the
  client's `base_version` isn't the latest (someone saved meanwhile): the web app then asks to reload or save anyway.
- Archived collections are hidden from lists unless asked, keep resolving, and can be unarchived.

## Permissions

New permission `collections.write`: (`developer`, `act`), like `milestones.write`.

- Read inputs, collections, versions: `project.read` on the project asked about. A collection of an ancestor project
  is readable from a subproject the user can read.
- Create, save a version, rename, describe, archive: `collections.write` on the collection's project.
- Favorite: anyone who can read it.
- Pin for a group: `collections.write` and membership of the group; pin for everyone: `project.access` (owner).

## API (all under `/api/v1`, JSON, documented in `backend/backend/openapi.yaml`)

Project ids contain slashes, so they're passed as `?project=`.

| Method | Path | What |
|---|---|---|
| GET | `/inputs?project=&q=&folder=&database=&live=1&sort=last_run\|path&limit=100&offset=0&facets=` | `{inputs: [Input], total, databases: [{database, count}], folders: [{folder, count}]}`: `folders` are the next path level under `folder`. `total`, `databases`, `folders` are counted on the first page only (null after, unless `facets=1`) |
| GET | `/inputs/<id>?project=` | `Input` + `runs`: the 50 latest outputs of the project using it (`id, batch, commit, branch, user, origin, created_date, deleted, is_failed, output_dir_url`) |
| GET | `/inputs/<id>/thumbnail?size=256` | a JPEG, cached; 404 when no decoder reads the input (the web app shows a placeholder) |
| GET | `/inputs/<id>/file` | redirect/serve the input's file for the image viewer, when it is an image format the viewer reads |
| GET | `/collections?project=&archived=0` | `{collections: [Collection]}`: the project's and its ancestors', with `favorite`, `pinned_for: [group]` |
| POST | `/collections` `{project, name, description?, inputs: [id], notes?}` | creates it with version 1 → `Collection` (201), 409 if the name exists |
| GET | `/collections/<id>?version=` | `Collection` + `version: {version, created_by, created_at, notes, size}` + `versions: [...]` |
| GET | `/collections/<id>/inputs?version=&q=&limit=&offset=` | members as `Input`s, in their order |
| POST | `/collections/<id>/versions` `{inputs: [id], base_version, notes?}` | new version → 201, 409 if `base_version` is stale |
| PATCH | `/collections/<id>` `{name?, description?, archived?}` | |
| PUT/DELETE | `/collections/<id>/favorite` | |
| PUT/DELETE | `/collections/<id>/pins` `{group: id \| null}` | |
| GET | `/collections/resolve?project=&ref=night/hard@2` | for the CLI: `{collection, version, project, inputs: [{id, database, path}]}` |
| GET | `/collections/<id>/export.yaml?version=` | the YAML shown in the web app |

`Input`: `{id, database, path, name, folder, data, runs, first_run_at, last_run_at, thumbnail_url}`.
`Collection`: `{id, project, name, description, created_by: {id, user_name, full_name}, created_at, updated_at,
archived, latest_version, size, favorite, pinned_for, ref}` (`ref`: `name` or `project:name` when inherited).

Limits: 50,000 inputs per version (413 above), names 200 characters, descriptions and notes 20,000.

### Thumbnails

`backend/backend/thumbnails.py`: decoders are tried in order: site decoders from the entry point group
`qaboard.thumbnails` (a callable `(abs_path: str, size: int) -> PIL.Image | None`: SIRC reads its raws with `cde`
there), then Pillow for the formats it opens, then the first frame of videos with `av`. Thumbnails up to 256 px (the grid's)
are cached for a day in the hybrid cache keyed by (path, mtime, size); bigger ones (the viewer's) aren't, browsers keep
them (ETag, a week). Unreadable or missing inputs answer 404 quickly (negative cache). At most 4 decodes at a time per
process (`QABOARD_THUMBNAIL_DECODES`): others wait 5 s, then get 503 with Retry-After (the grid tries again).
The input file must be under a storage location the server reads (same check as the existing file endpoints).

## CLI and qaboard.yaml

```yaml
# qa/batches.yaml, a batch file that qaboard.yaml lists in inputs.batches
hard-cases:
  inputs:
    - collection: night/hard-cases@2   # or night/hard-cases: the latest version when the batch starts
  configurations: [base]
```

`qaboard/input_collections.py` (`qaboard.collections`, a lazy alias: a `collections.py` would shadow the standard library): `get(ref, project=None) -> Collection` (`.inputs`: list of `(database, path)`, `.version`)
over `GET /collections/resolve`, with the server and credentials `qa` already uses. `iterators.py` expands
`collection:` entries into `(input_path, database)` like other inputs; a missing collection is an error like a missing
input. The batch records which version it used in the run's data (`outputs.data`: `collection`, `collection_version`):
`qa batch` passes them to `qa run` with hidden options (`qa --collection night/hard --collection-version 2 run ...`),
and `qaboard/payloads.py` sends them in `data`, that the server keeps as it is.
When the server lists a batch with the project's code (`qa batch --list`, a custom `iter_inputs`), that `qa` has no
token: the server resolves the batch files' collections first and gives them in a file (`QABOARD_RESOLVED_COLLECTIONS`).
`qa collections show <ref>` prints the inputs (for scripts).

## Web app

- Route `/<project>/inputs` ("Inputs" in the project's navigation) and `/<project>/collections/<id>`.
- Inputs page: search box, folder breadcrumb + folder list (next level, with counts), database select, "Only inputs with
  runs" switch (on by default), sort; a virtualized thumbnail grid (TanStack Virtual if present, else windowing by
  rows) with the name under each thumbnail; click selects, shift/ctrl-click ranges, double-click or Enter opens the
  viewer; a selection bar: "Save as collection", "Add to collection".
- Viewer: full screen, the image viewer on the input's file (or the thumbnail when the viewer can't read the format),
  arrows for previous/next, the runs that used it (links to the runs).
- Save as collection dialog: name (with the project prefix shown), description, the count; on 409 offers to open it.
- Collection page: header (name, version picker, created by/at, favorite star, pin menu, archive), tabs "Inputs",
  "Python", "qaboard.yaml" (code to copy). Editing: remove selected inputs, add from the Inputs tab, then "Save
  version N+1" with notes.
- Sidebar: a collections panel under milestones, like `milestones/MilestonesPanel.jsx`: pinned, favorites, then
  groups by name prefix.
- First visit with no collections: an empty state saying what collections are for, with one action.
