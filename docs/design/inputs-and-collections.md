# Inputs and collections (rollout 1 of 5)

The full design, with the later rollouts (annotations, training caches, kept outputs, imports), is in the
"Input catalog and collections" design doc. This page is the contract for rollout 1: what ships, the data model,
the API, and what's left for later. Backend, CLI and web app are built against it.

## What ships

- **An Inputs tab per project**: every input that runs of the project (and of its subprojects) used, or that was
  added before any run (`qa inputs add`, `qaboard.inputs.add()`, `POST /inputs`), with a thumbnail,
  searchable by path, filtered by folder (path prefix) and by database, by default only inputs that still have runs
  that weren't deleted. Clicking an input opens it full screen in the image viewer, with the runs that used it.
- **Collections**: select inputs, save them as a named collection of the project (`night/hard-cases`). Collections are
  versioned: saving changes makes a new version, older versions never change (`night/hard-cases@2`). They belong to
  a project, subprojects see them too. They are archived, never deleted. Who created each version is recorded.
- **A Collections page**, its own entry in the sidebar next to Inputs (they are two concepts): the project's collections
  and its ancestors', searchable, grouped by name prefix, pinned and favorites first.
- **A page per collection**: its inputs (same grid as the Inputs tab), its versions, how to use it from Python and
  from qaboard.yaml.
- **Favorites and team pins**: users star collections; developers pin a collection for one of their groups,
  owners for everyone on the project. The sidebar lists pinned and favorite collections, like milestones.
- **`collections:` in batches** (next to `inputs`) and `qaboard.collections.get()` in Python, resolved by the server.

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
  shared        bool            default true; false: personal, only created_by sees it
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

Inputs can be added before any run (`input_catalog.add_inputs`): rows with `runs = 0`, whose `first_run_at` and
`last_run_at` are when they were added, until their first run sets both. They pass the "has live runs" filter (it
hides inputs whose runs were all deleted, not inputs waiting for their first run), and collections can have them.

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
- **Personal collections** (`collections.shared` false, like personal milestones): anyone signed in who reads the
  project makes them, and only their creator (`created_by`) sees them: in lists, pages, `/collections/resolve` (their
  own `qa batch` and scripts), and as a way to see an input. Their creator edits them without `collections.write`.
  They share one with the project (`PATCH {shared: true}`), which needs `collections.write`, or make it personal
  again; nobody else can. Names stay unique per project, personal ones included: a name someone else's personal collection has answers 409 without its id. Making one personal removes its pins. The web app saves personal ones by
  default ("Who sees it": Only me / Everyone on the project). Pins are for shared collections only.
- Favorite: anyone who can read it.
- Pin for a group: `collections.write` and membership of the group; pin for everyone: `project.access` (owner).

## API (all under `/api/v1`, JSON, documented in `backend/backend/openapi.yaml`)

Project ids contain slashes, so they're passed as `?project=`.

| Method | Path | What |
|---|---|---|
| GET | `/inputs?project=&q=&folder=&database=&live=1&sort=last_run\|path&limit=100&offset=0&facets=` | `{inputs: [Input], total, databases: [{database, count}], folders: [{folder, count}]}`: `folders` are the next path level under `folder`. `total`, `databases`, `folders` are counted on the first page only (null after, unless `facets=1`) |
| GET | `/inputs?...&fields=id` | the same filters, `{ids, total, too_many, max}`: the ids of every match in the list's order, for "Select all matching" (no page, no facets). At most 50,000 (`max`, a version's limit): more, and `ids` is empty, `total` null, `too_many` true |
| POST | `/inputs` `{project, inputs: [{database, path, metadata?}]}` | adds inputs before any run: `{inputs: [{id, database, path, new}], added, known}`. `path` relative to `database` like runs send them, `metadata` merged into `data.metadata` (where runs write theirs; inputs are shared by projects, see docs/warts.md). `database` normalized like runs send it (`/mnt//data/` is `/mnt/data`). 10,000 per request, `collections.write` |
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
`Collection`: `{id, project, name, description, created_by: {id, user_name, full_name}, updated_by (who saved the latest version), created_at, updated_at,
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
  configurations: [base]
  collections:                         # or `collections: night/hard-cases@2`
    - night/hard-cases@2               # or night/hard-cases: the latest version when the batch starts
    - name: hdr/regression             # a mapping: the ref under `name`, then settings like inputs'
      configurations: [{gain: 2}]
      lsf: {memory: 16000}
  inputs:                              # optional
    - charts/slanted-edge.png
```

Collections have their own key, next to `inputs`: inside `inputs`, a mapping is always an input with its settings
(a folder named `collection` is an input). A collection mapping accepts `name`, `configurations` (`configuration`,
`configs`), `platform`, `type` and runner options (`lsf:`, `local:`...); anything else, like `database` or `globs`, is
a `BatchError` (a collection knows where its inputs are), as are a missing name and an empty `collections`. The
collections' runs come first, then the inputs'; without `inputs`, a batch runs only on its collections (not on the
whole database). `only`/`exclude` filter the collections' inputs too.

`qaboard/input_collections.py` (`qaboard.collections`, a lazy alias: a `collections.py` would shadow the standard library): `get(ref, project=None) -> Collection`
over `GET /collections/resolve`, with the server and credentials `qa` already uses. A `Collection` has `.version`,
`len()`, `.inputs`, and iterates over `CollectionInput` objects, not tuples, so that they can say more later (per-input
options, regions): `id`, `database`, `path`, `absolute_path`, `data` (`{}` unless the server sends one) and `region`
(None unless sent). `for item in collection: item.path` is the documented way. `iterators.py` (`parse_collections`)
expands a batch's collections into `(input_path, database)` like other inputs; a missing collection is an error like a
missing input, at the line of the collection in the batch file. The batch records which version it used in the run's data (`outputs.data`: `collection`, `collection_version`,
`collection_id`): `qa batch` sends them when it creates the runs (`qaboard/payloads.py` puts them in `data`, that the
server keeps as it is), with nothing on the runs' command lines, and nulls for runs of plain inputs: a run redone from
a plain input forgets the collection of before. `qa run` never sends them, so it can't erase them, whatever the runner
forwards of the environment. Left: a `qa run` of its own that updates a run a collection's batch made keeps saying
that collection. The run's own `RunContext.collection` is None: what runs on an input doesn't depend on which
collection listed it.
When the server lists a batch with the project's code (`qa batch --list`, a custom `iter_inputs`), that `qa` has no
token: the server resolves the refs of the batch files' `collections` keys first (`api/tuning.py` `collection_refs`) and gives them in a file (`QABOARD_RESOLVED_COLLECTIONS`).
`qa collections show <ref>` prints the inputs (for scripts).

`qaboard/inputs.py` (`qaboard.inputs`): `add(paths, database=, project=, metadata=)` over `POST /inputs`, and
`qa inputs add <batches or paths>`, which adds the inputs `qa batch` would run on (same `iter_inputs`, so the same
databases and globs as the runs that use them later), without running. `qa --dryrun inputs add` lists them.

## Decisions

- **Creating collections, in this milestone: from the Inputs page's selection, and from the API.** Filtering on the
  Inputs page is a view you save: search, folder, database and "only inputs with runs", then "Select all N matching",
  and the version's notes record the filters. There is no separate page to create a collection from filters, edit a
  collection's filters, or sample/balance inputs (e.g. 100 per scene type across several collections): that page risked
  overbuilding before we know the workflows. Sampling and balancing belong to the SDK/API later (Python builds the
  list, `POST /collections` saves it); collections stay explicit lists of inputs, never stored queries.
- **Per-input options: "option C", for a later rollout, nothing to build now.** Facts about an input, true whatever
  runs on it (regions, mappings to its ground truth, calibration or sensor files), live on the collection member:
  `collection_members.region` (reserved, null now) and a `data` mapping later, exposed as `CollectionInput.region` and
  `.data`. How to run (runner options, configurations) stays in batch files, next to `collections:`, with per-input
  overrides there. A collection says *what* to run on, a batch *how*: the same collection runs with other settings in
  another batch, and no run setting hides in a collection's version.
- **Thumbnails: made on request by the backend, nothing stored on disk, until measured.** The backend decodes an input
  when the web app asks (4 decodes at a time per process), and Redis keeps grid sizes for a day. Thumbnails are never
  written next to inputs (they're read-only and belong to others) nor on users' quotas. Measure with the site's
  decoder on real raws first: if a cold folder of ~40 thumbnails fills in a second or two, keep this. If not, add a
  disk cache on the server's own volume, capped and pruned oldest first; and only if cold folders are still slow,
  make thumbnails in the background when runs record new inputs.
- **Sidecar files (e.g. `.imgprops` next to a `.raw`): known, not stored.** A collection lists the main files;
  sidecars stay where they are. QA-Board finds them when asked (`qaboard.input_collections.sidecars`), with patterns
  relative to the input's folder by input suffix: `{stem}.metadata.yaml` and `{stem}.yaml` by default, and a site's
  in `QABOARD_INPUT_SIDECARS` (site package or environment, read by `qa` and the server alike), e.g. SIRC's
  `{".raw": ["{stem}.imgprops", "{stem}/{stem}.cde"]}` (partial configurations). Exact names cost a stat each; globs
  are allowed but list a folder. `CollectionInput.sidecars` gives them to scripts, `GET /inputs/<id>` lists them
  (`sidecars`: `[{name, size, url}]`, `name` relative to the input's folder, each file checked like the file
  browser's, null when the server can't read the input) and the viewer shows them under "Files with it".
  No table, no scan: it gets more complicated only if collections were exposed as folders, sidecars versioned, or
  their content indexed as metadata for filters (the likely next step, at import or scan time).

## Web app

- Routes `/<project>/inputs` ("Inputs" in the project's navigation), `/<project>/collections` ("Collections", right
  after it, active on the list and on a collection's page) and `/<project>/collections/<id>`.
- Inputs page: search box, folder breadcrumb + folder list (next level, with counts), database select, "Only inputs with
  runs" switch (on by default), sort; a virtualized thumbnail grid (TanStack Virtual if present, else windowing by
  rows) with the name under each thumbnail; click selects, shift/ctrl-click ranges, double-click or Enter opens the
  viewer; a selection bar: "Save as collection", "Add to collection".
- Select all matching: next to "Select all loaded" (Ctrl+A), when the filters match more inputs than are loaded,
  "Select all N matching", and once the loaded ones are all selected a banner like mail apps': "All 200 loaded inputs are
  selected. Select all 2,431 matching". It asks `GET /inputs?fields=id` and selects ids: the selection is a
  `Map(id → Input | null)` (`gridSelection.js`), the dialogs take `ids` (and the loaded `inputs` for their thumbnails),
  so nothing needs every Input loaded. Over 50,000 matches it is disabled and says to narrow the filters. Ctrl-click,
  Escape and Clear work as before; "Copy paths" needs the paths, so it is off until they're all loaded.
- Provenance: the dialogs prefill the version's notes with how the inputs were chosen, editable, e.g. `From Inputs:
  search "night", folder night/street, only inputs with runs — 212 inputs` (`selection_provenance` in `api.js`; "picked
  by hand" without Select all, "211 of the 212 matching" after unselecting some). Adding to a collection prefixes "Added N
  inputs." and says before saving how many are already in it. No new columns: it's the version's `notes`.
- Viewer: full screen, the image viewer on the input's file (or the thumbnail when the viewer can't read the format),
  arrows for previous/next, the runs that used it (links to the runs).
- Save as collection dialog: name (with the project prefix shown), description, the count; on 409 offers to open it.
- Collections page: search, "Show archived", pinned, favorites, then the project's by name prefix (folded like
  milestone groups), then each ancestor's, marked; each row: name, description, latest version, size, updated by/at,
  a favorite toggle. "New collection" explains that collections are made from inputs, with a link to the Inputs page.
- Collection page: breadcrumb back to Collections; header (name, version picker, created by/at, favorite star, pin menu, archive), tabs "Inputs",
  "Python", "Batch file" (code to copy). Editing: remove selected inputs, add from the Inputs tab, then "Save
  version N+1" with notes.
- Sidebar: "Collections" after "Inputs", with the pinned and favorite collections under it. The Inputs page keeps a
  quick picker (`CollectionsPanel.jsx`, like `milestones/MilestonesPanel.jsx`).
- First visit with no collections: an empty state saying what collections are for, with one action.
