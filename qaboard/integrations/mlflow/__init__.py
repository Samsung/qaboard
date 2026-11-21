"""
Code that logs with MLflow's tracking API logs to QA-Board, without changes: a tracking store plugin.

    MLFLOW_TRACKING_URI=qaboard: python train.py                          # QA-Board only
    MLFLOW_TRACKING_URI=qaboard+http://mlflow.example:5000 python train.py  # MLflow's server, and a copy in QA-Board

MLflow finds tracking stores, model registry stores and artifact repositories by the scheme of their URI, with the
entry points of pyproject.toml (`mlflow.tracking_store`...), which point to `plugin.py`: it imports nothing until
MLflow asks for a store, because MLflow loads the entry points of every installed plugin when it is imported.

- `recorder.py`: an MLflow run as a QA-Board run (`qaboard.start_run()`), created lazily so that the parameters
  logged first identify it (its configurations), and what MLflow logs mapped to series, metrics, parameters, files.
- `store.py`: `QABoardStore`, the tracking store of `qaboard:` (QA-Board only: runs, experiments and logged models
  live in this process's memory), and `MirrorStore`, which wraps the store of the URI after `qaboard+`: it stays the
  source of truth, and copies what it is told to the recorder, never failing because of it.
- `artifacts.py`: the artifact repository of `qaboard-artifacts:/<run or model id>/...`, the runs' artifact URI: it
  saves files in the QA-Board run's folder, and in mirror mode also in the real artifact store.

Docs, and the compatibility matrix that `unsupported`'s warnings match: website/docs/from-mlflow.mdx.
"""
from .._common import Unsupported

SCHEME = 'qaboard'
MIRROR_PREFIX = 'qaboard+'
ARTIFACTS_SCHEME = 'qaboard-artifacts'

# What MLflow code did that QA-Board doesn't keep: said once, listed when a run ends
unsupported = Unsupported("MLflow")
