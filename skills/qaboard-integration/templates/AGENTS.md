<!-- Add this section to the project's AGENTS.md or CLAUDE.md, with your batch names and metrics. -->

## Results with QA-Board
This project's results are tracked with QA-Board (https://samsung.github.io/qaboard/docs/). `qaboard.yaml` and
`qa/main.py` define what runs; `qa/batches.yaml` the batches.

- **Run the CI batch before claiming a change is better**: `qa --share --label <short-name> batch ci`, then read the
  results against the reference branch's: `qa gate --json` for the verdict, or
  `qaboard.runs(<url>)` / `qa runs <url> --json` for each run's metrics (the command prints the results' URL).
  A median that moved is not enough: check the per-test changes and the failed runs.
- **Metrics that matter here**: <!-- e.g. `map` (higher is better, target 0.15), `latency_ms` (lower is better) -->.
- **Never** edit or delete files under the results storage (<!-- e.g. /mnt/qaboard -->): runs' folders are shared.
- **Don't** add metrics or visualizations without declaring them (`Metric`, `define_metric` or `qa/metrics.yaml`).
- Local runs: `qa run --input <input>` writes to `output/`; `qa --dryrun batch ci` lists what a batch would run.
