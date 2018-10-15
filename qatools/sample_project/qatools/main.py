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


# To access the CLI arguments from the user, use the context object passed to run() and postprocess().
# Reference: http://click.pocoo.org/6/complex/
#
# In short, context.obj is a dict with all the information you need:
# - input_path: Pathlib Path: path to your test input, relative to the database
# - database: Pathlib Path: absolute path to your database
# - platform: string: eg linux, android, windows...
# - configuration: string: represents optionnal partial configurations over the default (default/base, low-light, low-light:extra-low-light)
# - output_directory: Pathlib Path, 1. the only directory you should write to when running your algorithm, 2. where to read results when doing post-processing
# - etc
#
# TODO: yes we could create some ad hoc class to document those fields. Is it worth it?

def run(context):
  """Sample implementation of a run() function."""
  command = ' '.join([
       f"{find_executable()}",
       # sometimes your binary uses a working directory specified on the command line
       # f'--working_directory "{find_working_directory(context)}"',

       # you MUST implement a way to override the default configuration with diffs/deltas, from a base configuration
       # with partial configurations, corresponding to settings from an upstream block, or modes of operation
       f'--paramfile configurations/base.json',
       # you will often want to disable debug features in CI runs       
       f'--no-live-view --no-movie' if is_ci else '',
       # you MUST support arrays of :-separeted configurations, eg --configuration low_light:very_low_light
       ' '.join([f'--paramfile configurations/{c}.json' for c in context.obj["configuration"].split(':')]),
       # you MUST support parameter tuning via a JSON file
       f'--paramfile {context.obj["tuning_filepath"]}' if 'tuning_filepath' in context.obj else '',

       # that the absolute path to the test
       f'--input "{context.obj["database"]/context.obj["input_path"]}"',
       # that where you should save your results
       f'--output "{context.obj["output_directory"]}"',
       # extra flags are passed here
       ' '.join(context.obj['forwarded_args']),
  ])
  print(command)
  if context.obj['dryrun']: return
  out = subprocess.run(command,
                       shell=True,
                       encoding='utf-8',
                       stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
  print(out.stdout)
  # you could return various metrics: cpu usage, max memory, etc
  return {}


from utils import read_poses, drift_after_loop_metrics, objective_metrics

def postprocess(runtime_metrics, context):
  """
  Postprocessing functions should
    1. return a dict with metrics to save in metrics.json
    2. Create any qualitative outputs you would like to view later (images, movies...)
  args:
    context: Click.Context, context.obj has information from the CLI arguments
    runtime_metrics: metrics from the run
  """
  poses_path = context.obj["output_directory"] / 'camera_poses_debug.txt'
  # ideally we should get our program's return code via runtime_metrics
  metrics = {"is_failed": not poses_path.exists()}
  if metrics["is_failed"]: return metrics

  poses_estimated = read_poses(poses_path)
  metrics = {
    **metrics,
    **runtime_metrics,
    **drift_after_loop_metrics(poses_estimated),
  }

  # You are responsible knowing where the groundtruth is (if it exists)
  ground_truth_path = context.obj['database'] / context.obj["input_path"].parent / 'GT_final.txt'
  if ground_truth_path.exists():
    print('INFO: found ground truth')
    poses_groundtruth = read_poses(ground_truth_path)
    # you may need to do more work, eg 6dof alignment...
    metrics = {
      **metrics,
      **objective_metrics(poses_estimated, poses_groundtruth),
    }

  # Depending on the input type, you could implement different postprocessing flows
  # if context.obj["output_type"] == 'cis/siemens-star':
  #   resolution_from_center = find_resolution_from_center(context["output_directory"]/'image.bmp')
  #   create_plot(resolution_from_center, context["output_directory"]/'resolution.jpg')
  #   ...

  # those will be written into metrics.json
  return metrics


