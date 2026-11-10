# RFC: creating runs from Python (`start_run`), logging during training

Status: draft for discussion, November 2026. Not implemented. Owner: the maintainers, with the MLOps team.
Related: the roadmap's "Log from your code" section; `qaboard/results.py` (what shipped: `runs(url)`,
`run.log_metrics()`, `run.log_artifact()`); `docs/dag-pipelines-proposal.md`.

## Why
Today `qa` is the entrypoint: `qa run` calls your `run(context)` on one input and `qa batch` on many. That fits
evaluation code, pipelines and benchmarks. It doesn't fit code that is already running when results appear:
training loops, notebooks, test suites, long services. Teams doing deep learning keep a second tracker for those and
only bring the final evaluation to QA-Board, so the training history, the model and the evaluation live in two
tools with two logins and two vocabularies.

This RFC proposes the Python API to create and fill runs from your own code, so that QA-Board can be the one place
where an algorithm team looks at results, for teams coming from the usual experiment trackers. The last section lists
what such teams would miss on day one, to decide how far to go.

## Goals
1. `pip install qaboard`, a few lines in a training script, and the run shows in the web app like a `qa run`.
2. The same `Run` object as `qaboard.runs(url)`: one vocabulary (`configs`, `params`, `metrics`, `output_dir`,
   `input`), one JSON.
3. Method names people already know: `log`, `log_metrics`, `log_params`, `log_artifact`, `finish`, `with` lifecycle,
   so that moving a script takes a rename, not a rewrite.
4. Logging never blocks or crashes the training: buffered, retried, degrades to local files when the server is away.
5. Keep what makes QA-Board useful: runs compared with a reference, per-input results, files viewed in place. A
   training run is not a special object; it is a run whose "input" is the training set and whose files include the
   series logged at each step.

Non-goals for the first version: hyperparameter sweeps from the SDK (`qa optimize` exists), a model registry, system
metrics (GPU, CPU), team dashboards beyond the History page.

## API sketch
```python
import qaboard as qb

run = qb.start_run(
    project="kitefin/detector",          # default: the qaboard.yaml found upward, else required
    input="train/coco-mini",             # what this run processes; the dataset, as a path relative to the database
    configs=["resnet50", {"lr": 1e-3}],  # strings and mappings, like qa --config / batches
    batch="exp-lr-sweep",                # the experiment's name in the web app; default "default"
    commit=None,                         # default: git HEAD of the code; a dirty tree is recorded
    output_dir=None,                     # default: like qa run's, under the storage (--share) or output/
)
with run:                                # or run.finish() / run.fail(error)
    run.log_params({"optimizer": "adamw", "epochs": 30})      # shown with the configuration, filterable
    for step, batch in enumerate(loader):
        loss = train_step(batch)
        run.log({"loss": loss, "lr": sched.lr}, step=step)   # a series: kept in the run's folder
        if step % 1000 == 0:
            run.log_artifact("checkpoints/last.pt", path)    # a file, under output_dir
    metrics = evaluate(model)
    run.log_metrics({"mAP": Metric(metrics.map, smaller_is_better=False)})   # the run's metrics, in the database
    run.log_artifact("predictions.json", preds)
```

- `start_run()` returns an `ActiveRun`: a `Run` (the same dataclass as `runs(url)` gives) plus the writer: the buffer,
  the flush thread, `__enter__`/`__exit__`. `active.run` is the plain `Run`; reading code keeps its read-only object.
- `log(values, step=None)`: a point in a series per key, appended to `output_dir/series/<key>.jsonl` (or one parquet
  file per flush), and the last value of each key mirrored into the run's metrics as `<key>` (the database stores
  scalars, the files store history). `step` defaults to a counter; wall time is always recorded.
- `log_metrics(values)`: the run's metrics, as today for finished runs. During a run, it updates them (the run is
  `running` until `finish()`).
- `log_params(values)`: adds to `params` and to `data.params`, which the web app shows as configuration tags.
- `log_artifact(name, path_or_bytes)`: as shipped for finished runs (copies or writes under `output_dir`, never
  overwrites); for an active run, the manifest refresh waits for `finish()`. `log_image(name, array)` can come later
  as sugar.
- `finish(status=None)`: flushes, marks `finished` (or `failed` with the exception's message in the log), refreshes
  the manifest. Exiting the `with` block calls it.
- `qb.current_run()` for library code that logs from deep inside a model, set by `start_run`.
- Reading series back: `run.series("loss")` returns `(step, value, time)` rows, from `runs(url)` runs too.

### Identity
A QA-Board run is `(project, commit, batch, input, configs, platform)`. Training runs map onto it:

| Tracker concept | QA-Board | Notes |
|---|---|---|
| project | `project` | the git repository's name |
| experiment / group | `batch` | one batch per experiment; the web app's batch selector |
| run name | `input` + `configs` | the dataset and the settings make the run unique and comparable across commits |
| config | `configs` and `params` | strings name config files, mappings are parameters |
| run id | `id` | the server's |
| tags | `data.tags` | existing field; filterable |
| notes | `data.notes` | |

Starting the same `(input, configs)` twice on the same commit and batch replaces the previous run, as `qa run` does.
Teams wanting several attempts pass a seed or an attempt number in `configs`: it is then visible and comparable.

### Commit, dirty trees, notebooks
`commit` defaults to git HEAD of the current directory's repository. When the tree is dirty, the run records
`data.dirty = true` and the diff's hash; the web app already marks local runs (not CI) as unverified code. Without a
repository (a notebook on a shared drive), `project` is required and the commit is a placeholder like the one `qa`
uses for local runs. A run can also attach to a commit explicitly (the model's training code).

### Where results go, permissions
`output_dir` follows `qa`'s conventions (`qaboard/conventions.py`) under the storage when `share=True`
(default when a server is configured), else under `output/`. Files are written by the user's process, as today for
`qa run`; metrics and params go through the server. This keeps the storage model unchanged: nothing new runs as the
server's user.

### Transport
- A background thread drains a queue to the server: `log()` and `log_metrics()` return immediately. Payloads are
  batched (at most every 2 s or 500 points), retried with backoff, and dropped with a warning after N minutes with
  the series still written to files. `finish()` waits for the queue with a timeout.
- The server gets: `POST /output` to create the run (as `qa run` does: pending → running → finished), the existing
  `PATCH /output/<id>/metrics` for metrics and params, and `POST /output/<id>/manifest` refresh at the end. Series
  don't go through the server at all.
- Offline: `QA_OFFLINE=1` or no server: everything goes to files, and `qa sync --input <input>` (extended to read the
  series' last values) sends it later.

### Web app
- A series viewer for `series/*.jsonl`: one plot per key, several runs overlaid, log scale, smoothing, the reference's
  dashed. Mostly the existing Plotly viewer with a loader.
- Run cards show the last values; the History page plots the final metrics over commits as today.
- A "running" run shows its live series (the files grow; the viewer polls).

### Security
Creating runs needs what `qa run --share` needs. The SDK sends the token `qa auth login` saved; CI uses
`QABOARD_TOKEN`. Metrics and params go through the server with the `ingest` policy. Files are the user's.

## Migration from other trackers
- A thin shim module (`qaboard.compat.wandb`) that exposes `init`, `log`, `config`, `finish` with the same signatures,
  mapping to the API above, so that existing scripts run with an import change. Listed on the roadmap as
  "A wandb.log shim".
- An importer for past runs is out of scope here (roadmap: "Importers").

## Open questions
1. **`log()` vs `log_metrics()`.** Two names for "numbers": one for series during the run, one for the run's final
   metrics. Alternatives: a single `log()` where values are final unless `step` is given (what some trackers do),
   or `summary` for the final values. Which reads best to someone coming from another tracker?
2. **Series storage format.** JSON lines per key is simple and streams; Parquet is compact and fast to read back but
   needs a dependency and can't be appended. Start with JSONL and a size cap?
3. **Replace or keep attempts.** Decided with `docs/rfcs/rerun-directories.md`: same `(input, configs)` on the same
   commit is a new attempt of the same run. `start_run()` reserves its directory with `qaboard/attempts.py`, like
   `qa run`: shared runs get `<run>_attemptN`, the row keeps the latest attempt's results and a record of the earlier
   ones (status, metrics, logs). Still open: do training teams need the earlier attempts' files kept, e.g. their
   checkpoints?
4. **Runs without an input.** Some training jobs have no meaningful "input" path. A synthetic input per batch
   (`"train"`) works but shows up in the inputs table; the coming richer inputs table may give a better home
   (a dataset record with its version).
5. **Live runs in the web app.** How much polling and partial-file reading do we accept for a run that logs for
   days?
6. **Sweeps.** `qa optimize` searches parameters by starting `qa run`s; with `start_run`, a sweep is a loop in the
   user's script. Do we offer a sweep helper, or document the loop?

## What teams would miss on day one
To be a good first approximation for a team that uses a hosted experiment tracker today, the features below are
the ones users mention first. Each is a decision: build, defer, or say no.

| Need | Today in QA-Board | Gap |
|---|---|---|
| Training curves, several runs overlaid, smoothing, log scale | Plotly plots per run, side by side | The series viewer above; overlaying N runs on one axis; smoothing |
| Final metrics compared across experiments and commits | Summary, Metrics Diff, History page | Fine. Add "group by a param" on the History page |
| Hyperparameters as first-class, filter and group by them | `configs`/`params` tags, filter box | Fine. Tables could show params as columns |
| Logged images, image grids per step | Image viewer, dynamic visualizations (`:step`) | `log_image()` sugar writing to the dynamic path |
| Artifacts and model files, versioned, downloadable | Output files, `qa save-artifacts` for builds | A per-run "model" file with a badge; a registry is out of scope |
| Live view of a running job | Pending/running states, logs view | The live series viewer |
| System metrics (GPU memory, utilization) | None | A small sampler in the SDK writing a series; low cost |
| Reports and notes shared with a team | Milestones with notes, sharable URLs | Fine for reviews; no free-form report editor |
| Sweeps | `qa optimize` (Optuna) with analysis in the web app | Fine for `qa run`-shaped code; see open question 6 |
| Notebook support | None specific | `start_run` from a notebook, commit placeholder, `<notebook>` provenance |
| Offline and resume | `--offline`, `qa sync` | Series files make offline natural; resume = reopen the same run |
| Alerts (a metric crossed a threshold) | Emails when a batch ends; the gate in CI | A rule on `log()` values is a later addition |
| Access control, SSO, audit | Projects' roles, LDAP/SAML, audit log | Fine |
| Cost | Self-hosted; storage is yours | The reason to ask the question |

A reasonable first release: the API above with the series viewer, overlay and smoothing, `log_image()`, the dirty-tree
record and the notebook path. System metrics and alerts after feedback. A registry only if asked twice.
