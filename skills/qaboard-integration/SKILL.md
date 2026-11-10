---
name: qaboard-integration
description: Integrate a project with QA-Board (quality tracking that compares each commit's outputs and metrics with a reference's, for algorithms, ML, performance, test suites and agents) or change an existing integration. Use when asked to track results with QA-Board, add qaboard.yaml, write qa/main.py, declare metrics or visualizations, add batches, run `qa batch` in CI, or set up a quality gate.
---

# Integrate a project with QA-Board

QA-Board tracks runs: your code on one **input** (an image, a dataset slice, a test case) with some
**configurations**, on a **commit**, in a **batch**. The `qa` CLI wraps your code and sends results to a server; the
web app compares each run with the same run on a reference commit. Docs: https://samsung.github.io/qaboard/docs/

Do the integration right rather than fast: the people reviewing results will live with your names for years.

## 0. Before you start

- **Find the server**: `qa auth status` says which server `qa` uses and whether you're signed in. Without one, ask the
  user for `QABOARD_URL` (and `QA_STORAGE`, the shared folder the server reads). Without a server you can still
  integrate: results stay in `output/` until someone runs `qa --share`.
- **Install**: `pip install qaboard` (or `uv add qaboard`). The project's requirements file should list it.
- **Look at what exists**: a `qaboard.yaml` means an integration exists; read it and `qa/main.py` before changing
  anything. `qa --dryrun batch <name>` shows what a batch would run without running it.
- **Pick the shape** (decide, say why):
  - **Wrap** (default): `qa run --input X` calls your `run(context)` once per input. Use it for evaluation code,
    pipelines, simulators, benchmarks: anything that processes an input and writes files.
  - **Import**: results already exist (a benchmark, a vendor's outputs): `run()` copies or links them and computes
    metrics. See https://samsung.github.io/qaboard/docs/running-your-code#import-existing-results
  - **Import a benchmark suite**: the project has pytest-benchmark, Google Benchmark, hyperfine, Criterion, JMH or
    `go test -bench`. Don't convert results by hand: `run()` runs the harness, saves its file in `output_dir`, lists
    it in `outputs.visualizations`, and returns `benchmark_metrics(path)` (`from qaboard.benchmarks import
    benchmark_metrics`). One input per suite or binary is enough. Configure the harness to repeat measurements:
    QA-Board calls changes within the reported spread noise, it doesn't repeat runs.
    https://samsung.github.io/qaboard/docs/benchmarks
  - **Training loops and notebooks** don't fit a wrapper yet: evaluate the trained model with a `run()` that takes
    the model id as a tuning parameter (https://samsung.github.io/qaboard/docs/deep-learning). Creating runs from code
    (`start_run`) is on the roadmap.

## 1. Create the files
`qa init` writes a commented `qaboard.yaml` and `qa/main.py`; prefer editing those to writing from scratch. Minimal
`qaboard.yaml`:

```yaml
# yaml-language-server: $schema=https://samsung.github.io/qaboard/qaboard.schema.json
project:
  name: group/repo             # as on the git host, lowercase
  url: https://git.example.com/group/repo
  entrypoint: qa/main.py
  reference_branch: main       # commits are compared with the latest results on this branch
inputs:
  database:
    linux: inputs              # inputs are paths relative to this folder (absolute paths are fine, {project} and $VARS expand)
  globs: labels.json           # how to recognize an input when a batch lists a folder
  use_parent_folder: true      # the input is the folder containing the matched file
  batches: qa/batches.yaml
outputs:
  metrics: qa/metrics.yaml     # optional: which metrics to show by default
  visualizations: []           # what each run card shows, see step 4
storage:
  linux: /mnt/qaboard          # where --share and CI runs save files; the server reads this path
```

Every key: `references/qaboard-yaml.md`. Check the file in the editor with the schema above, or run `qa get config`.

## 2. Write `run()` in `qa/main.py`
```python
from qaboard import Metric

def run(context):
    result = my_code(context.input_path, params=context.params)     # your code
    result.image.save(context.output_dir / "output.png")           # files to look at
    return {
        "psnr": Metric(result.psnr, label="PSNR", suffix=" dB", smaller_is_better=False, target=30),
        "runtime": Metric(result.seconds, suffix=" s", smaller_is_better=True),
        "is_failed": False,
    }
```
- `context.input_path` (absolute), `context.output_dir` (created and emptied by `qa`), `context.params` (the merge of
  the configurations' mappings and tuning parameters), `context.configs` (the list), `context.platform`,
  `context.forwarded_args`. Full list: https://samsung.github.io/qaboard/docs/running-your-code#useful-context-properties-reference
- `qa/main.py`'s folder is on the import path: keep helpers next to it, import the project's own code.
- Return a flat dict of numbers. Wrap them in `Metric(...)` where they're returned (the default), or call
  `define_metric("psnr", ...)` once at module level for a metric returned from many places: the web app then knows the
  unit, the target and which way is better, and the gate can use them. Only the metrics a run returns get definitions:
  `define_metric` for a metric the run doesn't return does nothing. Don't write `metrics_definitions.json` from
  Python: `qa` writes it at the end of the run. Strings become tags; `"params": {...}` adds configuration tags (e.g.
  the model evaluated), `"badges": [...]` links (model card, training run).
- Return `"is_failed": True` when the output is unusable; don't raise for expected failures.
- Code in another language: run it with `subprocess`, stream its output (it goes to the run's `log.txt`), and read
  its `metrics.json` from `output_dir` (`qa` merges it). It can write `metrics_definitions.json` next to it (your
  Python's `Metric`/`define_metric` win over it).
- Expensive metrics from files: put them in `postprocess(runtime_metrics, context)`, which `qa postprocess` and
  `qa batch --action-on-existing postprocess` can redo without rerunning. Metrics a one-off script adds to existing
  runs (`run.log_metrics()`, see the `qaboard-results` skill) don't belong in the project's code; metrics the project should
  always have do.

Details and a complete example: `references/entrypoint.md`.

## 3. Batches
`qa/batches.yaml`: named lists of inputs and configurations. Name the CI batch `ci`, keep it small enough to run on
every push, and give it the inputs that matter for the decision ("does this commit regress?").

```yaml
ci:
  inputs: [slices/indoor, slices/outdoor]
  configs: ['${matrix.model}', size-320]
  matrix:
    model: [fp32, int8]
nightly:
  inputs: [slices/*]
  configs: [fp32]
```

Configurations are strings or mappings; the project decides what they mean (names of config files, mappings merged
into `context.params`). Check with `qa --dryrun batch ci`, then run `qa batch ci` (local, results in `output/`), then
`qa --share batch ci` to see them in the web app. https://samsung.github.io/qaboard/docs/batches-running-on-multiple-inputs

## 4. Visualizations
List the files `run()` writes that people should see, in `outputs.visualizations`. The extension picks the viewer:
images (`.png`, `.jpg`, `.tif`...), videos, Plotly plots (`*.plotly.json`: `{"data": [...], "layout": {...}}`), flame
graphs (profilers' files as they are: `*.folded`, `*.speedscope.json`, `*.cpuprofile`; `perf script` and pprof through
`qaboard.flamegraphs.save_flame_graph`, https://samsung.github.io/qaboard/docs/flame-graphs), benchmark files
(`*.benchmarks.json`, `*-bench.json`...), HTML reports (no scripts), point clouds (`.pcd`), text (diffed).
`path: "frames/:frame.png"` makes one visualization with a slider over the files; `default_hidden: true` for debug
files. https://samsung.github.io/qaboard/docs/visualizations

Write the files people need to judge a run next to the reference's: the output, the input, an error map or a plot.
Don't write hundreds of MB per run by default.

## 5. CI and the quality gate
Add a job that installs `qaboard`, builds, and runs `qa batch ci` with `QABOARD_URL` set (results are always sent in
CI; `QABOARD_TOKEN` with the `ingest` scope marks them verified). Run it on the reference branch too, or there is
nothing to compare with. Templates: https://samsung.github.io/qaboard/docs/ci-integration

Then `qa gate` after `qa batch`, with rules in `qaboard.yaml` (experimental):
```yaml
gate:
  reference: main
  labels: [default]            # the results to check (`qa --label`); the CI's label is "default"
  expect_batches: [ci]         # undecidable until `qa batch ci` has runs
  rules:
    - {metric: map, min: 0.15}
    - {metric: ap_small, max_regression: 10%}
    - {metric: map, per_test_max_regression: 25%}
  max_failed_runs: 0
```
Rules about regressions need the metric's `smaller_is_better`. A rule with `batch: perf` checks only the runs of
`qa batch perf`: the gate can't decide until those exist. `qa gate --post-status github --post-comment github`
reports on the pull request. https://samsung.github.io/qaboard/docs/quality-gate

## 6. Tell the agents of the project
Add the snippet in `templates/AGENTS.md` to the project's `AGENTS.md` or `CLAUDE.md`: how to run the batch, and that a
change is "better" only after comparing its runs with the reference's in the Metrics Diff. Pair it with the
`qaboard-results` skill.

## Checklist before saying it's done
- [ ] `qa run --input <one input>` works from a clean checkout, prints the metrics, exits 0; `output/...` has the files.
- [ ] `qa --dryrun batch ci` lists the expected runs; `qa batch ci` passes; a failing input returns `is_failed: True`.
- [ ] Metrics are declared (`Metric`/`define_metric`/metrics file) with `smaller_is_better`, units and targets where
      they exist. Names are stable snake_case keys; labels are for people.
- [ ] `qa --share batch ci` shows the runs in the web app with their visualizations (ask the user to look, or use the
      `qaboard-results` skill to read them back).
- [ ] CI job added; the reference branch runs it; `qa gate` has rules for the metrics that matter.
- [ ] `qaboard.yaml` has no secrets, no absolute user paths; `output/` is in `.gitignore`.
- [ ] Nothing in the repository deletes or rewrites files under `storage`: runs' folders are shared.

## Mistakes to avoid
- Using the metric key as its label (`psnr_db_mean_over_frames`): keys are code, labels are UI.
- Returning nested dicts as metrics: flatten (`ap_small`, not `ap: {small: ...}`).
- Writing outputs anywhere but `context.output_dir`.
- Making `run()` depend on the current directory: `qa` changes to the project's root.
- Big inputs in the repository: the database is a path, keep data where it is.
- One huge batch: CI should answer in minutes; nightly batches can be large.
