---
name: qaboard-results
description: Read QA-Board results from scripts and agents, and add metrics to runs: the runs a web app page shows (metrics, parameters, output files), run.log() to add what a script computed, a commit compared with its reference, and whether a change improved things. Use when given a QA-Board URL, when asked to post-process runs, compute a metric on existing outputs, or check a change before claiming it's better.
---

# Read QA-Board results, add metrics to runs

QA-Board is an experiment tracker: **runs** (one input, some configurations) in **batches**, on **commits**, compared
with the same runs on a **reference** commit. People pick runs in the web app; its URL names them exactly. Docs:
https://samsung.github.io/qaboard/docs/apis

## From a web app URL
When you're given a URL like `https://qaboard.example.com/<project>/commit/<commit>?batch=ci&filter=night`, use it as is:

```python
import qaboard as qb                              # pip install qaboard; experimental API, names may change

for run in qb.runs(url):
    run.input            # 'slices/outdoor', relative to run.database; run.input_path is absolute
    run.configurations   # ['int8', 'size-320']
    run.params           # every parameter: the configurations' mappings, tuning parameters, what the run reported
    run.metrics          # {'map': 0.31, 'latency_ms': 21.3, 'is_failed': False, ...}
    run.output_dir       # Path to its files (shared storage); None if deleted
    run.state            # 'pending' | 'running' | 'finished'; run.is_failed
    run.id, run.commit, run.batch, run.project, run.url, run.input_metadata, run.data, run.created_at
```

- The filter in the URL is applied like the web app does, so you see exactly the runs the person saw. Add
  `status:success` to the filter to skip failed and unfinished runs (they may have no files).
- Without a URL: `qb.runs(project="group/repo", commit="main", batch="ci", filter="night")`. `commit` can be a branch
  or tag; `branch=` gives the latest commit with results on it. `side="reference"` gives the reference bar's runs.
- Deleted runs and `qa optimize` iterations are left out unless `include_deleted=True` / `include_hidden=True`.
- Shell: `qa runs "<url>"` prints one output folder per line; `--json` prints everything above. Works outside a project.
- Auth: `qa auth login <server>` once, or `QABOARD_TOKEN` (only sent to the configured server). A server behind a
  path prefix needs `server="https://host/prefix"`.

### Add metrics to runs
```python
from qaboard import Metric
for run in qb.runs(url + "%20status:success", dry_run=True):   # finished runs only; dry_run prints, drop it to send
    run.log({"sharpness": Metric(measure(run.output_dir / "output.png"), smaller_is_better=False)})
```
The server merges the metrics into the run's and records who (the token's user), when and which script
(`run.data["added_metrics"]`). Needs `qa auth login` (a token with the `ingest` scope, developer role). Values: finite
numbers, booleans, short texts, None. A metric the run itself returned is refused unless `overwrite=True` (the run's
value is kept as `replaced`); if the run runs again and returns the name, its value wins. Nothing is written in the
run's folder: never write there yourself. For metrics the project's code should own, add them to `postprocess()` and
run `qa batch <batch> --action-on-existing postprocess`.

## Did my change help? (before saying so)
A change is better when its runs beat the *same* runs on the reference, not when a mean moved.

1. Run the batch the project uses in CI, shared under a label:
   `qa --share --label <topic> batch ci` (prints the results URL). Local-only: `qa batch ci` writes to `output/`.
2. Ask the gate: `qa gate --json` compares the current commit's CI batch with the reference (`gate:` in
   `qaboard.yaml`, else `project.reference_branch`). Exit `0` pass, `1` fail, `2` can't decide (reference missing or
   still running). Read `batches[].checks[]` for each rule's `status` (pass/fail/skip), new and reference values.
3. For other batches or labels, use the compare API the gate uses:
   ```bash
   curl "$QABOARD_URL/api/v1/commit/<sha>/compare?project=<project>&reference=main&batch=<label>"
   ```
   `metrics[<name>]`: new and reference medians, `delta`, `delta_relative`, share of runs meeting the target.
   `tests[]`: each run, its reference run and the change per metric; `reference_mismatch` when the pairing isn't exact.
   `status` must be `complete`; `running`/`missing` say why.
4. Report per test: which inputs improved, which regressed, which failed; the metric's direction
   (`smaller_is_better`); and the link to the Metrics Diff
   (`<server>/<project>/commit/<sha>?batch=<label>&selected_views=table-compare`). Say when a reference run is
   missing or the comparison is partial.

## The HTTP API, when the SDK isn't enough
Base: `$QABOARD_URL/api/v1`. Reading is anonymous unless the server restricts the project; send
`Authorization: Bearer $QABOARD_TOKEN` otherwise.

| Need | Call |
|---|---|
| Recent commits with results | `GET /commits?project=<p>&limit=20&only_ci_batches=true` (`?q=branch:release -wip`, `?from=&to=`, `?with_outputs=true`) |
| A commit's batches and runs | `GET /commit/<sha or branch>?project=<p>` → `batches[label].outputs[id]` (`test_input_path`, `configurations`, `extra_parameters`, `metrics`, `is_failed`, `output_dir_url`) |
| Latest commit with results on a branch | `GET /commit?project=<p>&branch=<b>` |
| A run's files | `GET /output/<id>/manifest` (paths, sizes, hashes); files are at `<server>/s<path>` from `output_dir_url` |
| Compare with a reference | `GET /commit/<sha>/compare?project=<p>&reference=<ref>&batch=<label>` |
| Milestones | `GET /milestones?project=<p>` |
| Projects, branches | `GET /projects?summary=true`, `GET /project/branches?project=<p>` |

Details: https://samsung.github.io/qaboard/docs/apis#http-api. Starting runs or batches needs a token with the `act`
scope: prefer `qa batch` from a checkout.

## Don'ts
- Don't modify or delete anything under the results storage (`/mnt/qaboard`-like paths from `output_dir`): folders
  are shared with everyone; write your own outputs elsewhere.
- Don't compute statistics across runs with different inputs or configurations as if they were the same test.
- Don't claim "better" from a single run or from `compute_time` alone; latency needs a quiet machine and repeats.
- Don't paste tokens into URLs (`?token=` is read-only and logged).
