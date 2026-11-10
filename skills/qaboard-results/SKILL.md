---
name: qaboard-results
description: Read QA-Board results from scripts and agents, and add metrics and files to runs: the runs a web app page shows (metrics, parameters, output files), run.log_metrics() to add what a script computed, a commit compared with its reference, and whether a change improved things. Use when given a QA-Board URL, when asked to post-process runs, compute a metric on existing outputs, or check a change before claiming it's better.
---

# Read QA-Board results, add metrics and files to runs

QA-Board is an experiment tracker: **runs** (one input, some configurations) in **batches**, on **commits**, compared
with the same runs on a **reference** commit. People pick runs in the web app; its URL names them exactly. Docs:
https://samsung.github.io/qaboard/docs/apis

## From a web app URL
When you're given a URL like `https://qaboard.example.com/<project>/commit/<commit>?batch=ci&filter=night`, use it as is:

```python
import qaboard as qb                              # pip install qaboard

for run in qb.runs(url):
    run.input            # 'slices/outdoor', relative to run.database; run.input_path is absolute
    run.configs          # ('int8', 'size-320', {'score_threshold': 0.3}): configurations, then tuning parameters, like context.configs
    run.params           # the mappings of configs merged, plus what the run reported: like context.params
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

### Add metrics and files to runs
```python
from qaboard import Metric
for run in qb.runs(url + "%20status:success", dry_run=True):   # finished runs only; dry_run prints, drop it to send
    run.log_metrics({"sharpness": Metric(measure(run.output_dir / "output.png"), smaller_is_better=False)})
    run.log_artifact("sharpness/map.png", png_bytes_or_path)     # a file in the run's folder, shown in the web app
```
`log_metrics`: the server merges the metrics into the run's and records who (the token's user), when and which
script (`run.data["added_metrics"]`, a pencil mark in the web app). Needs `qa auth login` (a token with the `ingest`
scope, developer role). Values: finite numbers, booleans, short texts, None. A metric the run itself returned is
refused unless `overwrite=True` (the run's value is kept as `replaced`); if the run runs again and returns the name,
its value wins. `log_artifact`: writes under the run's folder as you (write access needed), never overwrites unless
`overwrite=True`, keeps your files in a subfolder of their own; the web app lists them at once. Never write in runs'
folders yourself. For metrics the project's code should own, add them to `postprocess()` and run
`qa batch <batch> --action-on-existing postprocess`.

The script's `# /// script` header must list the site's package next to `qaboard` when the server has one (the web
app's **Script** button writes it; `GET /api/v1/config` gives `cli_requirements`).

## Did my change help? (before saying so)
A change is better when its runs beat the *same* runs on the reference, not when a mean moved.

1. Run the batch the project uses in CI, shared under a label:
   `qa --share --label <topic> batch ci` (prints the results URL). Local-only: `qa batch ci` writes to `output/`.
2. Ask the gate: `qa gate --json` compares the current commit's CI results (label `default`, once CI ran on the
   pushed commit) with the reference (`gate:` in `qaboard.yaml`, else `project.reference_branch`). Exit `0` pass, `1`
   fail, `2` can't decide (reference missing, runs still running or a batch missing: the messages say which,
   https://samsung.github.io/qaboard/docs/quality-gate#undecidable). Read `batches[].checks[]` (`batches[]` has one entry per label)
   for each rule's `status` (pass/fail/skip/unknown), new and reference values,
   `batches[].reruns` for the runs that only passed after being done again, and `rules_changes` when the commit
   changed the gate's rules: report both, and never loosen a rule to make the gate pass without saying so.
   Checks with `"source": "project"` are the project owners' rules, set in the web app: nothing in the repository
   changes them, so fix the regression or ask an owner. A check with `batch` only looked at the runs of those
   `qa batch` names; `unknown` with "no runs from `qa batch perf` yet" means the results aren't complete: wait or run
   that batch, don't conclude. `qa gate --label nightly` checks other results (`gate.labels`).
3. For other labels, or another reference, use the compare API the gate uses:
   ```bash
   curl "$QABOARD_URL/api/v1/commit/<sha>/compare?project=<project>&reference=main&batch=<label>"
   ```
   `metrics[<name>]`: new and reference medians, `delta`, `delta_relative`, share of runs meeting the target.
   `tests[]`: each run, its reference run and the change per metric, and its `batch` (the `qa batch` name);
   `reference_mismatch` when the pairing isn't exact.
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
| A commit's batches and runs | `GET /commit/<sha or branch>?project=<p>` → `batches[label].outputs[id]` (`test_input_path`, `configurations`, `extra_parameters`, `metrics`, `is_failed`, `output_dir_url`; the SDK's `Run` renames them like `run()`'s context) |
| Latest commit with results on a branch | `GET /commit?project=<p>&branch=<b>` |
| A run's files | `GET /output/<id>/manifest` (paths, sizes, hashes); files are at `<server>/s<path>` from `output_dir_url` |
| Compare with a reference | `GET /commit/<sha>/compare?project=<p>&reference=<ref>&batch=<label>` |
| Milestones | `GET /milestones?project=<p>` |
| Projects, branches | `GET /projects?summary=true`, `GET /project/branches?project=<p>` |

Every parameter and field: `$QABOARD_URL/api/v1/openapi.json` (OpenAPI 3.1), or the guide
https://samsung.github.io/qaboard/docs/http-api. Starting runs or batches needs a token with the `act`
scope: prefer `qa batch` from a checkout.

## Don'ts
- Don't modify or delete anything under the results storage (`/mnt/qaboard`-like paths from `output_dir`): folders
  are shared with everyone; write your own outputs elsewhere.
- Don't build the paths of results yourself: a shared run that was done again is in `<folder>_attempt2`, `_attempt3`...
  (`<folder>/latest_attempt.txt` has the number). `run.output_dir`, `qa batch --list-output-dirs` and
  `qa get --input <input> output_dir` give the latest attempt's folder.
- Don't read reruns as repeated measurements: `run.data.get("attempt")` and `run.data.get("previous_attempts")` say a
  run was done again and how earlier attempts ended (status, metrics, who, when), e.g. after a retry; their logs are
  `run.output_dir / "log.attempt<N>.txt"`. Say so when you report a run that passed on a later attempt, and read
  the failed attempt's log before you call it flaky. For statistics, repeat the measurement inside `run()` and
  return what you computed.
- Don't compute statistics across runs with different inputs or configurations as if they were the same test.
- Don't claim "better" from a single run or from `compute_time` alone; latency needs a quiet machine and repeats.
- Don't paste tokens into URLs (`?token=` is read-only and logged).
