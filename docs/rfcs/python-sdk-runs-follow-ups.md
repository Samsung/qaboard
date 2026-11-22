# Follow-ups to "creating runs from Python": what is left for training teams

Status: notes for discussion, November 2026. Nothing here is implemented or decided.
Follows `docs/rfcs/python-sdk-runs.md`, whose first version shipped as experimental (`qaboard.start_run()`, the series
viewer on run cards, the comparison of a batch's runs in the Summary view).
Three parts: (A) a run-centric view of a project, (B) the screenshots the new docs miss, (C) the gaps against a
hosted experiment tracker, with what to do about each.

## A. A run-centric view of a project

### The problem
QA-Board's pages are organized as project → commit → batch → runs, because its first question is "what did this
commit change?". Someone who trains models asks other questions first:

- "Where are my runs from this week?", whatever the commit: they change a parameter, not the code, or the code is
  dirty, or they run from a notebook with no commit at all.
- "Which of these 30 runs is the best, and what did it use?", across batches and commits.
- "How does today's run compare with Tuesday's?", two runs that are not new and reference of anything.

Today they can do it, with friction: the home page and the project page list *batches* ("Yours"), each opening one
commit's page; the Summary's comparison plots the runs of one batch; History plots a metric over *commits*. A sweep
done over three days on three commits is three pages. Runs outside the CI also land in a batch per user
(`@user| <batch>`), which helps "mine" and hides "the team's experiment".

### What is already there to build on
- Runs are rows with their commit, batch, input, configurations, reported parameters (`data.params`), metrics, who
  ran them and where from (`data.origin`, `submitted_by`), when (`created_date`, `started_at`, `finished_at`), and
  `data.sdk` for runs started from code.
- `GET /api/v1/batches` already lists batches across commits, by scope (mine, others) and origin, with aggregated
  metrics (`docs/home-and-project-pages-proposal.md`): the pattern for a list that is not commit-first.
- The series viewer's comparison (`webapp/src/viewers/SeriesComparison.jsx`) takes a list of runs, not a batch: it
  names them by what differs, colors them by a parameter, and only needs each run's folder.
- **Tuning Analysis** already has a parameters-and-metrics table, parallel coordinates and parameter importance,
  for the runs of one tuning experiment.
- Filters (`qaboard/filters.py`, shared with the web app) already match runs by input, configuration, parameters,
  status and id.

### Decided in discussion (November 2026)
- **A separate page**, not a mode of the commits list. A project then has three ways in, by what you look for:
  **Commits** (what did a change do), **Batches** (what did I run, today's "Yours"), **Runs** (my experiments).
- **Shown when the project has runs started from code, and put forward for projects that train**: for those, the
  sidebar has **Runs** above **Commits**, and the project opens on it. Other projects don't see it.
- **Experiments are a hierarchy, by their name.** People name things with slashes
  (`detector/backbone/lr-sweep`) and expect to open a level, see everything under it, and delete from there.
- **The commit stays.** It matters less than on the commit page, but teams that train from clean commits rely on
  it: it is a column, a filter and a link, never hidden.
- **A run opens like any run**: its visualizations and output files, with every viewer, as on the commit page.

### Naming: one project, experiments with slashes
Today a QA-Board project is a repository, or a subfolder of one: `group/repo/subproject`, each a row in the
database with its own storage folder, access rules and settings. That hierarchy is about code. Experiments are
another hierarchy, and should not become projects: a project per experiment would scatter access, settings and
references, and thousands of rows.

- **The project is the umbrella**: the repository (`kitefin/detector`), as today. `start_run()` finds it from the
  *qaboard.yaml*, or takes `project=`.
- **The experiment is the batch**, as today (`start_run(batch=...)`), and **its name can have slashes**:
  `batch="backbone/lr-sweep"`. Nothing new is stored: batches are already free text, and their folder name is a
  slug of the label (`conventions.batch_folder_name`), so slashes are safe on disk. To check before promising it:
  every place the web app puts a batch's label in a URL or splits it, and the `@user| ` prefix (below).
- **In `start_run()`, call it what users call it.** Add `experiment=` as the documented name, keep `batch=` as its
  alias: "batch" means nothing to someone who trains, and the docs' table already has to translate it.
- **Who ran it is not part of the name.** Outside the CI, runs go to `@user| <batch>` so that people don't write in
  the CI's batch. For the tree, the experiment is the label without that prefix, and the user is a column and a
  filter: `backbone/lr-sweep` is one node whoever ran each run. The stored label doesn't change.
- **Encourage the hierarchy in the docs**: `<area>/<question>` (`backbone/lr-sweep`, `quantization/int8-calibration`),
  with the seed or trial in `configs`, not in the name.

### Proposal: a **Runs** page per project
`/<project>/runs`, and `/<project>/runs/<experiment path>` for a level of the tree, so that every level has an
address to share.

1. **On the left, the experiments as a tree**, folded by the slashes of their names, each node with its number of
   runs, how many are running or failed, and when it last ran. Clicking a node shows its runs and everything under
   it: the most natural filter there is. A node's menu has what people do to a whole experiment: copy its link,
   export, and **delete its runs' files** (the existing deletion of batches, with its confirmation and storage
   numbers, applied to the batches under the node, for who has the role).
2. **On the right, the runs of the selected node, the latest first, across commits.** One row per run: status,
   name (what differs in its configuration, as in the Summary's comparison), experiment (the part of the path below
   the node), who, when, duration, commit (short id, a mark when the code differed from it, link to the commit
   page), then one column per parameter that varies and per chosen metric. Scope tabs like the commits list:
   **Yours**, **Everyone's**; the CI's runs off by default.
3. **Above the table, the runs' series on the same plots**: the comparison of the Summary view, fed with the rows
   shown, so that opening an experiment answers "how did these trainings go" before any click. One plot per
   series, a few at first (the project's main metrics, else the first logged), the others on demand.
4. **The table drives the plots, so that people see what they work on.** This is where the page succeeds or
   fails:
   - every row has an eye, like the comparison's list: hidden runs leave the plots and gray out in the table;
   - **selecting rows shows only those**, in the plots and in the table's metrics columns' highlights; clearing the
     selection brings back everything visible;
   - hovering a row brings its curves forward (the restyle the comparison already does);
   - filters (text, status, user, a time range, a parameter's value) and "group by" a parameter fold the rest away;
     grouped, a group is one line with a band (the mean and spread over seeds, gap table below);
   - "only running", "only mine" and "hide failed" as one-click chips, since they are most of what people hide.
   The eye, the selection, the filters and the grouping live in the URL.
5. **A run opens in place.** Clicking a row opens a panel (or the page `/<project>/runs/<id>`) with what the commit
   page's card has: its metrics, its series against its reference, its visualizations and output files with every
   viewer, its logs, its parameters, its attempts. It is the same card component, with the same view options. From
   there, **Open on the commit page** goes to the commit's batch with the run filtered, and **Compare with…** picks
   another run as its reference: two runs as new and reference, with every viewer the product has, is QA-Board's
   strength and a link that works today (`/<project>/commit/<a>?reference=<b>&filter=id:…`).
6. **Pin a selection.** A milestone today is a commit and a batch (and a filter). Let a milestone hold a set of
   runs, or an experiment node ("the candidates for 1.5"), so that it has a name, notes and a link, and can be a
   reference.
7. **Live.** Running runs first, with their last logged step and how long they have run; the table and the plots
   refresh while any is running.

How hosted trackers lay this out, from general knowledge and to check before copying anything: a runs table next
to a workspace of panels, where the table's visibility toggles and grouping drive the panels (Weights & Biases),
or a table with compare and chart views, runs grouped by a namespace-like path and custom views saved (Neptune).
The proposal keeps that coupling, table drives plots, and adds what they don't have: the tree from names, and a run
that opens with its outputs in full viewers and against a reference.

### What it needs
- **Server**: `GET /api/v1/runs?project=&scope=&origin=&batch=&branch=&filter=&since=&limit=&offset=`, returning
  runs with their commit and batch. The filter is applied in Python today (the web app's rules, on a batch's runs):
  across a project it needs SQL for the selective parts (user, origin, dates, status, batch) before the text filter,
  and indexes on `outputs (created_date desc)` joined to batches' commit and project. Parameters and metrics are
  JSONB: sorting by a metric across a large project needs care (a limit on the window, or an expression index per
  project's main metrics). Measure on a production copy before choosing.
- **Web app**: the page, the table (virtualized, like the benchmark viewer's), the selection in the URL, and the
  comparison component accepting runs from several commits (it already only needs `output_dir_url`). The sidebar
  gets **Runs** (`SIDEBAR.md`).
- **Python**: `qaboard.runs(project=..., since=..., scope="mine")` without a commit, on the same endpoint, so that
  notebooks can do their own analysis.
- **Docs**: a user guide page, and the deep learning page rewritten around it.

### Open questions
1. **Which projects "train"?** The page shows when a project has runs started from code. Putting it first in the
   sidebar and opening the project on it needs a stronger signal: a share of recent runs started from code, or a
   project setting (`project.home: runs` in *qaboard.yaml*, or in the project's admin page). Lean: automatic for
   showing it, a setting for making it the home.
2. **Three units in one sidebar.** Commits, batches and runs are three lists of the same results. The home and
   project pages already mix commits and batches (`docs/home-and-project-pages-proposal.md`): decide whether
   **Batches** stays a tab of the commits list while **Runs** is its own page, and say in one sentence each what
   they are for.
3. **Which reference does a training run have?** The reference bar compares with a commit's batch. For a training,
   the useful references are "the same configuration at the release", "my previous attempt" (kept in
   `data.previous_attempts`, without its files) and "the best run so far". The last two need product decisions:
   keep an earlier attempt's series (small) when a run is done again, and let a milestone be a run.
4. **Slashes in existing batch names.** Some projects already have labels with slashes or with `|`: the tree must
   not surprise them. Fold only on `/`, show names as they are, and keep the flat list one click away.
5. **Deleting from a node** removes many batches at once, on several commits: it needs the storage numbers first,
   the roles of batch deletion, and probably the retention rules' dry run (`website/docs/storage/deleting-old-data`).
6. **Scale.** Samsung's server has more than 40 million runs: the page must never scan a project's runs. The tree
   is a query on batches (labels, counts, dates), cheap and cacheable; the table is paged within a node and a time
   window; the plots take the first 40 visible rows, as today.

### A possible order
1. The endpoints: runs with scope, origin, experiment prefix, dates and paging; the experiments of a project with
   their counts. With `qaboard.runs(project=, experiment=, since=)`. Useful alone, for scripts and agents.
2. `experiment=` in `start_run()`, slashes checked end to end, the naming advice in the docs.
3. The Runs page: tree, table, quick filters, a run opening in place with its card. No plots yet.
4. The plots above the table, driven by visibility, selection and hover; the URL state.
5. Group by with mean and band; delete from a node; milestones that hold runs; the page as a project's home.

## B. Screenshots the docs miss

The new pages have no pictures: `website/docs/logging-from-code.mdx`, **Logged series** and **Compare all the runs
on the same plots** in `website/docs/user-guide/other-viewers.mdx`, and the `series` section of
`website/docs/viewers.mdx`. Screenshots come from the demo projects (`docs-media/README.md`): a shot needs a story
that produces its data, an entry in `docs-media/shots.yaml`, and a spec.

To do, in order:

1. **A training in a demo project.** `examples/detection-eval` evaluates models; none of the examples trains.
   Add a small, deterministic trainer to it (seconds on a CPU, fixed seeds: e.g. the calibration or distillation of
   the detector's head on its mini set) that calls `qaboard.start_run()`, logs `train/loss`, `val/loss`, `val/mAP`
   and `lr`, and saves the weights the existing evaluation reads. Story states (`examples/detection-eval/story.yaml`,
   `examples/STORY.md`):
   - a learning-rate sweep, 5 to 6 runs in one batch, one of them diverging (a NaN gap) and one clearly best;
   - the same configuration on the reference commit, so cards show new against reference;
   - one run left "running" when the snapshot is taken, for the Live state (or a spec that stubs `is_running`).
   `docs-media/seed.py` replays stories with real `qa` commands: check it can run a plain `python train.py` step.
2. **Shots** (`docs-media/shots.yaml`, status `planned`, `experimental: true`, a new feature key `logged-series`):

   | Id | Shows | Pages |
   |---|---|---|
   | `commit/logged-series` | A training's card: `train/loss` and `val/loss` against the reference run's, dashed; the toolbar | user-guide/other-viewers, log-from-code, viewers |
   | `commit/logged-series-smoothing` (clip) | Dragging **Smoothing**: the noisy curve becomes readable, the values stay behind | user-guide/other-viewers |
   | `commit/series-comparison` | The Summary's **Logged series**: the sweep's runs in colors, the best and the diverging one obvious | user-guide/other-viewers, log-from-code, deep-learning, use-cases (see C) |
   | `commit/series-comparison-color-by` | The same, colored by learning rate, one group shown alone | user-guide/other-viewers |
   | `commit/series-live` | A running run: the **Live** tag, curves that stop mid-way | log-from-code |
   | `cli/start-run` (tape) | `python train.py` printing the run's folder and address, then "finished" | log-from-code |

3. **Use them** with `<Shot>` in the pages above, with captions that say what to notice (`website/STYLE.md`), and
   add the feature to the user guide's overview if it lists viewers.
4. Until then the pages are text only; they don't use stand-ins.

## C. Gaps against a hosted experiment tracker, and what to do

For a team whose daily work is training, compared with Weights & Biases as of late 2026 (the public product: runs,
workspaces, sweeps, artifacts, reports). Sizes are rough: S days, M a couple of weeks, L more. "Decide" means a
product decision before any work. Their side of the table is from general knowledge of the product, not checked
against their current documentation: check it before publishing any of it in `website/docs/alternatives.mdx`.

| What they have | QA-Board today | Gap | Next step |
|---|---|---|---|
| A runs table across a project: sort, filter, group, columns per config and summary; runs organized by a namespace or path | Runs per commit and batch; batches across commits; experiment names are flat | **The main gap**: no run-centric view, no hierarchy of experiments | Part A. L |
| A workspace of panels: any metrics, any runs, saved per user and shared | One plot per series, on a card or in the Summary; options in the URL | No custom panels (two series on one plot, a chosen x axis such as epoch, pinned plots) | Let people pick the x axis from a logged series, and put several series on one plot, in the comparison. M |
| Hundreds of runs on one plot, grouped with mean and spread over seeds | 40 runs of one batch, colored by a parameter | No averaging over a group; no runs from several batches | Mean and min/max band per color group (the files already have what it needs). S. Several batches: with part A |
| Two lines to start, anywhere, hosted | `start_run()` in a project with a server and shared storage | Setup: a server to run, a storage the server reads, a *qaboard.yaml* | Decide: uploads over HTTP (`docs/design/http-upload.md`) would remove the shared storage for small files; a hosted service is out of scope |
| Rich media per step: images, tables, audio, with a step slider | **Shipped, experimental (November 2026)**: `run.log({...: qaboard.Image(...)})` and `run.log_image/audio/video/table/histogram/text()`, `qaboard/media.py` (*media.jsonl* and *media/&lt;key&gt;/&lt;step&gt;_&lt;index&gt;.&lt;ext&gt;*); the card's **Logged media** with one step slider, each item next to the reference run's at the same step; an audio viewer, a table viewer, histograms over steps | Masks, a media panel across runs (with A), downsampling of long runs' media: `docs/warts.md` (Logged media) | — |
| System metrics: GPU, memory, CPU, logged by default | None | Missing | A sampler thread in the SDK logging `system/…` series (`pynvml` and `psutil` optional), `summary="none"`. S |
| Sweeps with early stopping (Hyperband), launched from the UI | `qa optimize` (Optuna) for `qa run`-shaped code | No sweeps for code that calls `start_run()`; no pruning | Document the loop; then an Optuna pruner fed by `run.log()`. Decide if it is worth it. M |
| Artifacts: versioned datasets and models, lineage, a registry with aliases | Output files; badges linking to a registry | No versions, no lineage | Decide. A "model" file per run with a badge is S; a registry is a product of its own, likely no |
| Resume, offline mode with a later sync | `resume=True`; logging survives a server that is away | A run the server never heard of is not sent later | `qa sync <run folder>` reading *run.json*, *metrics.json* and the series. S |
| Alerts (a metric crossed a line, a run crashed), Slack and email | Emails when a `qa batch` ends; the quality gate in the CI | Nothing for runs started from code | A notification when such a run ends or fails, through the existing channel. S. Rules on logged values: later |
| Reports: text with live panels, shared by link | Milestones with notes; every page's address restores its state | No report editor | Decide. Probably no: link from your own documents |
| Integrations: Lightning, Hugging Face, Keras callbacks | None | Each framework needs a few lines by hand | A `qaboard.integrations.lightning` logger and a Transformers callback: thin, S each, once the API has settled. The `wandb`-shaped shim is in the RFC's left-outs |
| Notebook experience: a run's panel inline | Works from notebooks, untested; prints a link | No inline view | Test in Jupyter first (docs/warts.md). An `_repr_html_` with the link and last metrics. S |
| Runs that crashed are marked as such | A killed process stays "running" | Stale runs | A heartbeat with the progress report, and the server marking runs silent for N minutes. S to M |
| Compare a run with any other in two clicks | New against reference, by commit and batch | See part A, point 3 | Part A |

Where QA-Board is ahead for the same team, to keep in the story (`website/docs/alternatives.mdx`): every commit
against the release by default, heavy outputs in synced viewers (images, video, point clouds, flame graphs),
per-input results on a test set, the quality gate in the CI, evaluations started from the browser on your own
cluster, self-hosted with your data in place.

### A use case page, when part A and the shots exist
`website/docs/use-cases/` has one page per kind of regression, each with a demo project and screenshots; there is
none for training. Add **"The loss looked fine, the model got worse"** (working title): a learning-rate sweep where
the run with the best validation loss is not the one with the best mAP on the hard slice. It walks from the runs'
curves (Summary) to the evaluation of the two best checkpoints on the test set (the existing detector evaluation),
to the gate. It needs B.1's trainer and shots, and reads better with the Runs page. Until then, the deep learning
page (`website/docs/deep-learning.mdx`) carries the feature, and the comparison table in `alternatives.mdx` says
what is experimental.

### Suggested order across the three parts
1. Verify what shipped against a real server, in Jupyter and on Windows; fix what that finds (`docs/warts.md`).
2. Small gaps that make daily use safe: stale runs' heartbeat, `qa sync` for a run folder, the end-of-run
   notification, mean and band per group.
3. The demo trainer and the screenshots (B).
4. The runs endpoint and the Runs page (A.1 to A.3).
5. ~~`log_image()` and system metrics~~: shipped (media per step, November 2026; system metrics before).
6. The use case page; then decide on sweeps, artifacts and reports with users' feedback.

## D. Migrating from other trackers (November 2026)

### Shipped (experimental)
- **W&B**: `qaboard/integrations/wandb/`: `python -m qaboard.integrations.wandb train.py` (zero change: patches the
  real wandb, or stands in for it when it isn't installed), `mirror()` in code, or `import qaboard.integrations.wandb
  as wandb`. Docs and compatibility matrix: `website/docs/from-wandb.mdx`.
- **MLflow**: a tracking store plugin, `qaboard/integrations/mlflow/`: `MLFLOW_TRACKING_URI=qaboard:` (QA-Board only)
  or `qaboard+<uri>` (the real MLflow store first, a copy to QA-Board). Docs and matrix: `website/docs/from-mlflow.mdx`.
- Both start the QA-Board run lazily, so that the config (wandb) or the params logged before the first metric
  (MLflow) are its configurations, and say once what they can't keep (`_common.Unsupported`). Limits: `docs/warts.md`.

What QA-Board lacks as a product, by how often trackers' code hits it (both shims warn about these):
1. ~~Media per step~~: shipped, through `run.log_media()`. Left: masks, wandb.plot.* drawn as charts (their tables are logged), MLflow's several images per key and step.
2. A custom x axis (`define_metric(step_metric=)`): one step axis per run. → C's "workspace of panels" row.
3. A model registry and artifact versions/lineage. → decide (C).
4. Reading past runs from the tracker API (`wandb.Api()`, `mlflow.search_runs`) across processes. → A.1's runs endpoint.
5. Sweeps (`wandb.sweep/agent`), alerts, datasets (`log_input`), tracing/GenAI: point to `qa optimize`, nothing else.

### MLflow's REST API on the server: evaluated, not now
The plugin covers MLflow's Python client, where nearly all MLflow logging code is. The server-side API would add R,
Java and JS clients, and logging with no install (a URL). It needs a Flask blueprint with ~15 endpoints (experiments,
runs create/get/update/search, log-batch/metric/param, set-tag, metric history, the `mlflow-artifacts` routes), a
table from MLflow run ids to outputs, the same lazy identity (outputs are keyed by batch, input, configurations and
platform at creation, `backend/backend/api/outputs.py`), the server writing *series.jsonl* and artifacts in the run's
folder (`uploads.run_dir`), and `MLFLOW_TRACKING_TOKEN` mapped to QA-Board tokens. Rough size: L (one to two weeks).
Do it when a team with non-Python MLflow clients asks.

### Importers of past runs: not done, what's missing
An importer reads a tracker's past runs and creates QA-Board runs with their params, metrics, series and files: a
`qa import wandb <entity/project>` / `mlflow <experiment>` / `tensorboard <logdir>` on top of `start_run()` (the series
format already takes past `_time`s). What blocks a faithful import, and how to bridge it:

| Gap | Why it matters | Bridge |
|---|---|---|
| **Times**: the server stamps `created_date`, `started_at`, `finished_at` when it receives the run | Imported runs all look like today's; History and "latest" sort them wrong | Accept them in `POST /output` for imports only (`data.imported`, the original times), bounded and audited. S |
| **Who**: `submitted_by` is the token's user | Every run is the importer's | Keep the original user as `data.origin.imported_from_user`, shown on the card; don't impersonate. S |
| **Commit**: QA-Board needs one; W&B records `git.commit` only when the code ran in a repo, MLflow its tag, TensorBoard none | Runs without one have nowhere to go; commits unknown to the repository | A synthetic commit per import (`import/<tool>/<date>`) or `--commit`; commits are created on demand already (`CiCommit.get_or_create`), their git metadata stays empty. S-M |
| **Identity**: W&B/MLflow runs are ids with random names; QA-Board compares (input, configs) | 30 runs of a sweep with identical configs collapse into attempts of one run | Same lazy mapping as the shims (config/params as configurations), the original id as a param, and a `--input-from name|id|<config key>` option. S |
| **Volume**: W&B's API is rate-limited; projects have 10k+ runs and GBs of artifacts | Imports that take hours, a storage filled with checkpoints | Resumable imports (a journal of imported ids), `--since`, `--filter`, files off by default except small ones (`--artifacts '*.json'`). M |
| **History resolution**: W&B's `scan_history` is exact but slow, `history()` is sampled | Curves that differ from the tracker's | `scan_history`, written straight to *series.jsonl* (the summary file buckets it anyway). S |
| **Media per step, tables, custom x axes** | Same as the shims | Media and tables through `run.log_media()`, at their step; custom x axes: say so in the import's report |
| **TensorBoard**: event files only (scalars, images, histograms, hparams plugin), no commit or user | Little identity | One run per run folder, the folder path as input, hparams as configurations; needs the `tensorboard` package (or `tbparse`) as an extra. S-M |

Order if we do it: times and user on the server (needed by every importer), then MLflow (its client lists runs
cheaply, the plugin's mapping is reused), then W&B, then TensorBoard.
