"""
Log to QA-Board with code written for other trackers, without changing it.

- `qaboard.integrations.wandb`: code that calls `wandb.init()`, `wandb.log()`... (website/docs/from-wandb.mdx)
- `qaboard.integrations.mlflow`: code that calls MLflow's tracking API, through a tracking store plugin
  (`MLFLOW_TRACKING_URI=qaboard:`), see website/docs/from-mlflow.mdx

Both create runs with `qaboard.start_run()` (qaboard/active_run.py). What they can't mirror, they say once, and list
when the run ends (`_common.Unsupported`): the compatibility matrices in the docs list the same.
"""
