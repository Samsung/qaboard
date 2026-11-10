# The entrypoint: `run()`, `postprocess()`, metrics and files

`qa run --input X` imports `project.entrypoint` (usually `qa/main.py`), creates and empties `context.output_dir`,
calls `run(context)`, saves what it returns in `metrics.json` and what it prints in `log.txt`, writes a manifest of the
files, and (with `--share`, or in CI) sends the run to the server.

## The context
| Property | What it is |
|---|---|
| `input_path` | The input's absolute path. |
| `rel_input_path` | Relative to the database, as given to `qa run --input` and in batches. |
| `database` | The inputs' folder (absolute). |
| `type` | The input type, when `inputs.types` is used. |
| `input_metadata` | From the entrypoint's `metadata()` function, if any. |
| `configs` | The configurations as given (strings and mappings), then the tuning parameters. |
| `params` | The mappings of `configs` merged, last wins. Usually all you need. |
| `configurations`, `extra_parameters` | `configs` split: the configurations, and the tuning parameters. |
| `platform` | `linux`, `windows`, or what `qa --platform` set. |
| `forwarded_args` | Arguments after the input: `qa run --input A.jpg --verbose` → `['--verbose']`. |
| `output_dir` | Where to write. `pathlib.Path`. |
| `dryrun` | `True` with `qa --dryrun`: print what you would do. |
| `id` | The run's id on the server, `None` for local runs. |

## A complete `run()`
```python
"""qa/main.py: QA-Board runs this file. `qa --config int8 run --input slices/outdoor` calls run(context)."""
import json, subprocess, sys, time
from pathlib import Path

from qaboard import Metric, define_metric

sys.path.insert(0, str(Path(__file__).resolve().parent))   # helpers next to this file
import evaluate, plots                                       # noqa: E402

define_metric("map", label="mAP", smaller_is_better=False, target=0.15,
              description="COCO AP over IoU 0.50:0.95")

def run(context):
    variant = "int8" if "int8" in context.configs else "fp32"
    threshold = context.params.get("score_threshold", 0.2)        # tuning parameters override defaults
    t0 = time.time()
    detections = evaluate.detect(context.input_path, variant, threshold, out_dir=context.output_dir)
    latency_ms = 1000 * (time.time() - t0) / len(detections)
    if not detections:
        return {"is_failed": True, "reason": "no image could be read"}
    ap = evaluate.average_precision(detections, context.input_path / "labels.json")
    plots.precision_recall(ap, context.output_dir / "pr.plotly.json")   # {"data": [...], "layout": {...}}
    (context.output_dir / "detections.json").write_text(json.dumps(detections))
    return {
        "map": ap.map,
        "ap_small": Metric(ap.small, label="AP small", smaller_is_better=False),
        "latency_ms": Metric(latency_ms, suffix=" ms", smaller_is_better=True, target=25),
        "params": {"model": f"detector-{variant}-1.3"},                  # shown as configuration tags, filterable
        "badges": [{"text": "Model card", "href": "https://models.example/detector/1.3", "icon": "cube"}],
        "is_failed": False,
    }
```

## Metrics
- A flat dict. Numbers are plotted and compared; strings are tags; `is_failed` is a boolean.
- Declare with `Metric(value, label=, short_label=, description=, suffix=, scale=, precision=, smaller_is_better=,
  target=, target_passfail=, plot_scale=)`, or once with `define_metric(key, ...)` at module level, or in the metrics
  file under `available_metrics`, or from another language with `metrics_definitions.json`. Without
  `smaller_is_better`, changes show in neutral colors and gate regression rules fail.
- Definitions only apply to the metrics the run returns: `define_metric` records how to show a metric *if* it's
  returned, and declaring more is harmless. At the end of the run (after `postprocess()`), `qa` merges them
  (`metrics_definitions.json` < `define_metric` < `Metric`) and writes them to `output_dir/metrics_definitions.json`,
  next to `metrics.json`: `qa postprocess` and `qa sync` read them from there.
- `qa` adds `compute_time`. Don't name metrics `is_failed`, `params`, `badges`, `compute_time`.
- `postprocess(runtime_metrics, context)` runs after `run()`, and alone with `qa postprocess` /
  `qa batch --action-on-existing postprocess`: put slow or often-changed metric code there, reading the files `run()`
  wrote. Return `{**runtime_metrics, **new_metrics}`.

## Files and visualizations
- Write everything under `context.output_dir`. Keep names stable across commits: the web app pairs a run's files with
  the reference's by name.
- Plotly: write `{"data": [traces], "layout": {...}}` to `*.plotly.json`. HTML reports: static HTML (scripts are
  stripped). Flame graphs: what the profiler writes (`*.folded`, `*.speedscope.json`,
  `*.cpuprofile`), or `qaboard.flamegraphs.save_flame_graph()` for `perf script` and pprof. Point clouds: `.pcd`. Trajectories:
  text with a `type: 6dof/txt` visualization.
- Formats and viewer options: https://samsung.github.io/qaboard/docs/viewers

## Another language or process
```python
def run(context):
    cmd = [str(ROOT / "build" / "my_algo"), str(context.input_path), "--out", str(context.output_dir),
           *context.forwarded_args]
    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, cwd=context.output_dir)
    for line in proc.stdout:          # stream: it lands in log.txt and the terminal
        print(line, end="", flush=True)
    if proc.wait() != 0:
        return {"is_failed": True, "returncode": proc.returncode}
    return {"is_failed": False}        # qa merges output_dir/metrics.json written by the program
```

## Metadata and inputs
```python
def metadata(context):
    """Optional: called per input, before it runs (no output_dir yet). Returned keys show on the run and filter runs."""
    info = json.loads((context.input_path / "info.json").read_text())
    return {"scene": info["scene"], "lux": info["lux"], "tags": info.get("tags", [])}
```

## Checking an integration
```bash
qa run --input <input>                       # one run, metrics printed, files in output/
qa --config int8 --tuning '{"score_threshold": 0.3}' run --input <input>
qa --dryrun batch ci                         # the commands a batch would run
qa batch ci                                  # local
qa --share --label try-1 batch ci            # in the web app, under your name
qa get config                                # the merged qaboard.yaml
qa get --input <input> output_dir
```
