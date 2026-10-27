"""
Writes tuning.json: automated tunings as the API returns them, for webapp/e2e/tuning.spec.js.

The searches are real: `qa optimize`'s engine (qaboard/optimization.py) runs on a made-up objective shaped like
examples/detection-eval's (int8 quantization settings and post-processing thresholds against AP and model size),
and the batches' data is what `qa optimize` sends for them. Run it again when that data changes:
  uv run python webapp/e2e/fixtures/make_tuning.py
"""
import json
import math
import random
import zlib
from pathlib import Path

from qaboard.optimization import (
  describe_search_space, make_study, parse_options, parse_search_space, run_optimization, study_summary,
)

CONFIG = {
  "evaluations": 40,
  "parallel_sampling": 2,
  "early_stopping": {"patience": 20},
  "solver": {"sampler": "tpe", "seed": 42, "n_startup_trials": 8},
  "objective": {
    "ap_small": "max",
    "map": "max",
    "model_mb": {"goal": "min", "weight": 0.005},
  },
  "search_space": [
    {"Categorical": {"name": "quant_percentile", "categories": [99.9, 99.99, 99.999]}},
    {"Categorical": {"name": "quant_keep_fp32", "categories": ["none", "first-conv", "head", "first-conv+head"]}},
    {"Real": {"name": "score_threshold", "low": 0.2, "high": 0.45}},
    {"Real": {"name": "nms_iou", "low": 0.4, "high": 0.7}},
  ],
}
INPUTS = ["slices/outdoor", "slices/small-objects"]


def metrics(params, rng, input_index=None):
  """The made-up detector: small objects need a low score threshold, NMS has a sweet spot, fp32 nodes help but cost MB"""
  percentile = {99.9: 0.0, 99.99: 0.6, 99.999: 1.0}[params["quant_percentile"]]
  keep = params["quant_keep_fp32"]
  first_conv, head = "first-conv" in keep, "head" in keep
  st, nms = params["score_threshold"], params["nms_iou"]
  noise = lambda scale: rng.gauss(0, scale)  # noqa: E731
  ap_small = 0.17 + 0.05 * percentile + 0.035 * first_conv + 0.01 * head - 0.32 * (st - 0.2) - 0.45 * (nms - 0.56) ** 2 + noise(0.004)
  map_ = 0.29 + 0.02 * percentile + 0.012 * first_conv + 0.025 * head - 0.6 * (st - 0.27) ** 2 - 0.35 * (nms - 0.5) ** 2 + noise(0.004)
  if input_index is not None:  # the slices differ
    ap_small += (-0.04, 0.05)[input_index]
    map_ += (0.03, -0.03)[input_index]
  model_mb = 6.4 + 2.3 * first_conv + 4.1 * head
  return {"ap_small": round(ap_small, 4), "map": round(map_, 4), "model_mb": round(model_mb, 2)}


def loss(options, value):
  return options["weight"] * (value if options["goal"] == "min" else -value)


def run_search(label, config, fail_at=(), stop_after=None, pareto=False):
  options = parse_options(config)
  distributions = parse_search_space(config["search_space"])
  metric_names = options["objective_metrics"]
  study = make_study(config["solver"], n_objectives=len(metric_names) if pareto else 1,
                     parallel_sampling=options["parallel_sampling"])
  rng = random.Random(1)
  measured = {}

  def objective(params, number):
    if number + 1 in fail_at:
      return None
    m = metrics(params, rng)
    measured[number] = m
    return {name: loss(options["objective"][name], m[name]) for name in metric_names}

  reports = []
  run_optimization(
    study, distributions, objective,
    evaluations=stop_after or options["evaluations"],
    # one at a time: with threads the order of the evaluations would change, and the fixture with it
    parallel_sampling=1,
    patience=options["patience"],
    metric_names=metric_names if pareto else None,
    on_trial=lambda number, params, losses, total, is_best: reports.append((number, params, losses, total, is_best)),
  )

  outputs, data = {}, {
    "optimization": True,
    "iterations": options["evaluations"],
    "optimization_started_at": "2026-10-26T08:00:00+00:00",
    "optimization_config": {
      "search_space": describe_search_space(distributions),
      # like qa optimize: each metric's settings, with which way is better
      "objective": {m: {k: v for k, v in o.items() if v is not None} for m, o in options["objective"].items()},
      "pareto": pareto,
      "sampler": "tpe",
      "n_startup_trials": config["solver"]["n_startup_trials"],
      "parallel_sampling": options["parallel_sampling"],
      "early_stopping": options["patience"],
      "preset_params": {},
      "config": config,
      "batches": ["quant-search"],
    },
  }
  best = None
  for number, params, losses, total, is_best in reports:
    iteration = number + 1
    failed = losses is None
    output_id = f"{label}-iter{iteration}"
    outputs[output_id] = {
      "id": output_id, "output_type": "optim_iteration", "platform": "linux",
      "test_input_database": "/", "test_input_path": "quant-search", "test_input_metadata": {},
      "configurations": ["int8", "size-320"], "extra_parameters": {k: v for k, v in params.items()},
      "metrics": {"iteration": iteration, **({} if failed else {"objective": round(total, 5), **measured[number]})},
      "is_pending": False, "is_running": False, "is_failed": failed, "deleted": False,
      "output_dir_url": f"/s/outputs/{label}/iter{iteration}", "data": {},
      "created_date": f"2026-10-26T{8 + iteration // 6:02d}:{(iteration * 9) % 60:02d}:00+00:00",
    }
    data.update({"iteration": iteration, "iteration_label": f"{label}|iter{iteration}"})
    if is_best:
      best = (iteration, params, total)
      data.update({
        "is_best_iter": True, "best_iter": iteration, "best_params": params,
        "best_metrics": {"objective": round(total, 5), **measured[number]},
      })
  data.update(study_summary(study, metric_names if pareto else None))

  # the best iteration's runs, moved into the batch by the server
  iteration, params, _ = best
  for index, input_path in enumerate(INPUTS):
    output_id = f"{label}-best-{index}"
    outputs[output_id] = {
      "id": output_id, "output_type": "", "platform": "linux",
      "test_input_database": "/", "test_input_path": input_path, "test_input_metadata": {},
      "configurations": ["int8", "size-320"], "extra_parameters": params,
      "metrics": metrics(params, random.Random(index), input_index=index),
      "is_pending": False, "is_running": False, "is_failed": False, "deleted": False,
      "output_dir_url": f"/s/outputs/{label}/best/{index}",
      "data": {"optimization_best": f"{label}|iter{iteration}"},
      "created_date": "2026-10-26T12:00:00+00:00",
    }
  return outputs, data, study


def batch(label, outputs, data):
  failed = sum(1 for o in outputs.values() if o["is_failed"])
  return {
    "id": zlib.crc32(label.encode()) % 10000, "label": label, "batch_dir_url": f"/s/outputs/{label}",
    "data": data, "outputs": outputs,
    "valid_outputs": len(outputs) - failed, "running_outputs": 0, "pending_outputs": 0,
    "failed_outputs": failed, "deleted_outputs": 0, "aggregated_metrics": {},
  }


if __name__ == "__main__":
  batches = {}

  outputs, data, _ = run_search("tune-int8", CONFIG, fail_at=(13,))
  data.update({"optimization_status": "stopped_early" if data["iteration"] < CONFIG["evaluations"] else "done",
               "optimization_ended_at": "2026-10-26T15:42:00+00:00"})
  batches["tune-int8"] = batch("tune-int8", outputs, data)

  # the same search, still running
  outputs, data, _ = run_search("tune-int8-running", CONFIG, fail_at=(13,), stop_after=17)
  data.update({"optimization_status": "running"})
  batches["tune-int8-running"] = batch("tune-int8-running", outputs, data)

  # trade-offs: AP on small objects against model size, with no weights to guess
  pareto = {**CONFIG, "evaluations": 30, "pareto": True, "early_stopping": None,
            "objective": {"ap_small": "max", "model_mb": "min"}}
  outputs, data, _ = run_search("tune-int8-tradeoffs", pareto, pareto=True)
  data.update({"optimization_status": "done", "optimization_ended_at": "2026-10-26T17:10:00+00:00"})
  batches["tune-int8-tradeoffs"] = batch("tune-int8-tradeoffs", outputs, data)

  def plain(value):
    if isinstance(value, float) and not math.isfinite(value):
      return None
    return value
  path = Path(__file__).parent / "tuning.json"
  path.write_text(json.dumps(batches, indent=1, default=plain) + "\n")
  for label, b in batches.items():
    d = b["data"]
    print(f"{label}: {d['iteration']} iterations, best #{d.get('best_iter')} ({d.get('best_metrics', {}).get('objective')}),"
          f" importances {d.get('importances')}, front {len(d.get('pareto_front') or [])}")
