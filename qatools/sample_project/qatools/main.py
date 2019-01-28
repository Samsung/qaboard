"""
Sample implementation of a CLI wrapper using qatools.
"""
import subprocess
import time
from pathlib import Path

# We provide an easy way to know in which environment your code executes
from qatools.config import on_windows, on_linux, on_lsf, on_vdi
# Whis will identify runs through GitlabCI or Jenkins.
from qatools.config import is_ci




# To access the CLI arguments from the user, use the context object passed to run() and postprocess().
# Reference: http://click.pocoo.org/6/complex/
#
# In short, context.obj is a dict with all the information you need:
# - absolute_input_path: pathlib Path: absolute path to your test
# - configurations: array of string/objects: eg ["base"]
# - platform: str: eg linux, android, windows...
# - output_directory: pathlib Path: where to write results/files
# - tuning_filepath: tuning parameters
#
# It also contains...:
# - input_path: pathlib Path: path to your test input, relative to the database
# - database: pathlib Path: absolute path to your database
# - forwarded_args: other unrecognized CLI arguments
def run(context):
  """Sample implementation of a run() function."""
  command = ' '.join([
       f"{find_executable()}",

       # you will often want to disable debug features in CI runs       
       f'--no-live-view --no-movie' if is_ci else '',

       # you MUST implement a way to override the default configuration with diffs/deltas, from a base configuration
       # with partial configurations, corresponding to settings from an upstream block, or modes of operation
       f'--paramfile configurations/base.json',
       ' '.join([f'--paramfile configurations/{c}.json' for c in context.obj["configurations"]]),

       # you should support parameter tuning, given to your via a JSON/YAML
       f'--paramfile {context.obj["tuning_filepath"]}' if 'tuning_filepath' in context.obj else '',

       f'--input "{context.obj["absolute_input_path"]}"',
       f'--output "{context.obj["output_directory"]}"',
       # extra flags are passed here
       ' '.join(context.obj['forwarded_args']),
  ])
  print(command)
  if context.obj['dryrun']: return

  with subprocess.Popen(command,
                        cwd=output_directory,
                        encoding='utf-8',
                        stdout=subprocess.PIPE, stderr=subprocess.STDOUT) as process:
    for line in iter(process.stdout.readline, ''):
      print(line)
    process.wait()

    if process.returncode:
      return {"is_failed": True, "returncode": process.returncode}
    return {"is_failed": False}


  # you could return various metrics: cpu usage, max memory, etc
  return {}




def find_executable():
  """Returns the executable's path.
  The only different between running on Windows, Linux, LSF or the CI
  should be where the executable is located.
  Of course, if your code is pure python, you don't have to worry about this.
  """
  if is_ci or on_lsf or on_vdi:
    executable = 'build/sample_project'
  elif on_windows:
    executable = 'x64/release/sample_project.exe'
  else:
    executable = 'build/sample_project'
  return Path(executable)




def postprocess(runtime_metrics, context):
  """
  Postprocessing functions should
    1. return a dict with metrics to save in metrics.json
    2. Create any qualitative outputs you would like to view later (images, movies...)
    
  It can be as simple as:
    return runtime_metrics

  args:
    context: Click.Context, context.obj has information from the CLI arguments
    runtime_metrics: metrics from the run
  """
  # You should know what files you algo writes to, and what they mean
  metrics = {"is_failed": not poses_path.exists()}
  if metrics["is_failed"]: return metrics

  poses_path = context.obj["output_directory"] / 'camera_poses_debug.txt'
  poses_estimated = read_poses(poses_path)

  # You could also get metadata about your test to decide to compute, or not, some metrics 
  metrics = {
    **metrics,
    **runtime_metrics,
    **drift_after_loop_metrics(poses_estimated),
  }

  # You are responsible knowing where the groundtruth is (if it exists)
  ground_truth_path = context.obj['database'] / context.obj["input_path"].parent / 'GT_final.txt'
  if ground_truth_path.exists():
    poses_groundtruth = read_poses(ground_truth_path)
    metrics = {
      **metrics,
      **objective_metrics(poses_estimated, poses_groundtruth),
    }

  # Depending on the input type, you could implement different postprocessing flows. You could do something like:
  # metadata_path = context.obj['absolute_input_path"].parent / 'metadata.json'
  # metadata = ...
  # if 'siemens-start' in metadata.get('type', []):
  #   resolution_from_center = find_resolution_from_center(context["output_directory"] / 'image.bmp')
  #   create_plot(resolution_from_center, context["output_directory"] / 'resolution.jpg')
  #   ...

  return metrics




###############################################################################
## Sample functions for the sample project ####################################
###############################################################################
## Remove them from your project :)
import numpy as np
import pandas as pd
from pandas.api.types import CategoricalDtype

def read_poses(path):
  """Load a monoslam output file into a pandas dataframe describing tracked poses."""
  df = pd.read_csv(
      str(path),
      sep='\t', header=None, 
      names=['a','b','c','x','y','z','t','confidence','is_tracking_good'],
      index_col=6, #time
  )
  df = df[~df.index.duplicated(keep='first')]
  # good, imu6, imu3, lost
  is_tracking_good_type = CategoricalDtype(categories=[1,3,2,0], ordered=True)
  df['is_tracking_good'] = df['is_tracking_good'].astype(is_tracking_good_type)
  return df



def drift_after_loop_metrics(poses):
  """Returns the drift accuracy in % of the distance traveled, and the distance traveled.
  We assume the path is a loop, and the distance traveled is computed as:
    $$L = \sum{\sqrt{dx^2+dy^2+dz^2}} $$
  """
  poses_ = poses[['x', 'y', 'z']]
  poses_delta = poses_.shift(1)-poses_ 
  poses_delta2 = poses_delta**2
  poses_dl2 = np.sum(poses_delta2, axis=1)
  poses_dl = np.sqrt(poses_dl2)
  loop_length = np.sum(poses_dl.tail(-1))

  if loop_length < 0.0001:
    return {'loop_drift_pc': 0.0, "loop_translation_rmse": 0.0, 'dvs_trajectory_length': 0}

  start, end = poses_.head(1), poses_.tail(1)
  delta = start.iloc[0]-end.iloc[0] # note: we don't assume that we start at (0,0,0)
  error = np.sqrt(np.sum(delta**2))
  return {'loop_drift_pc': float(error/loop_length), "loop_translation_rmse": error, 'dvs_trajectory_length': float(loop_length)}


def trajectory_length(poses):
  poses_ = poses[['x', 'y', 'z']]
  poses_delta = poses_.shift(1)-poses_
  poses_delta2 = poses_delta**2
  poses_dl2 = np.sum(poses_delta2, axis=1)
  poses_dl = np.sqrt(poses_dl2)
  return float(np.sum(poses_dl.tail(-1)))


def objective_metrics(poses_est, poses_gt):
  """
  Computes various metrics quantifying the error of a trajectory estimation versus a ground truth.
  parameters:
  - poses_est: pandas dataframe
  - poses_est: pandas dataframe
  """
  metrics = {
    # this won't work if compute "only when the tracking is good"
    'trajectory_length': trajectory_length(poses_gt),
  }
  errors_xyz = poses_est[['x', 'y', 'z']] - poses_gt[['x', 'y', 'z']]
  errors_abc = poses_est[['a', 'b', 'c']] - poses_gt[['a', 'b', 'c']]

  rad_to_degree = 360/(2*np.pi)
  # This is an approximation when the results are good
  metrics['rotation_rmse'] = np.linalg.norm((errors_abc**2).mean()) * rad_to_degree

  # AAPE: average over trajectory of distance between estimate and ground-truth
  #       we pick the L2 distance, although AAPE suggests L2 distance
  #       it's a slightly easier metric
  metrics['translation_aape'] = np.linalg.norm(errors_xyz, axis=1, ord=2).mean()
  metrics['translation_aape_pc'] = metrics['translation_aape'] / metrics['trajectory_length'] if metrics['trajectory_length']>0 else 0
  # RMSE: we sum the squares of all the errors over the trajectory for all components
  #       then we normalize by dividing by the trajectory length
  metrics['translation_rmse'] = np.linalg.norm(errors_xyz, ord='fro') / np.sqrt(errors_xyz.shape[0])
  metrics['translation_rmse_pc'] = metrics['translation_rmse'] / metrics['trajectory_length'] if metrics['trajectory_length']>0 else 0
  # (final) drift
  # we don't assume that we start at (0,0,0)
  start = errors_xyz.head(1).iloc[0]
  end = errors_xyz.tail(1).iloc[0]
  metrics['translation_drift'] = np.sqrt(np.sum((start-end)**2))
  metrics['translation_drift_pc'] = metrics['translation_drift'] / metrics['trajectory_length'] if metrics['trajectory_length']>0 else 0

  return metrics