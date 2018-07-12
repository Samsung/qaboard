"""
Sample implementation of a CLI wrapper using qatools.
"""
import subprocess
import time

# Direct access to the the qatools.yaml configuration, parsed
from qatools.config import config
from qatools.config import database
# We provide an easy way to know in which environment your code executes
from qatools.config import on_windows, on_linux, on_lsf, on_vdi
# Whis will identify runs through GitlabCI or Jenkins.
from qatools.config import is_ci

def find_executable():
  """Returns the executable's path.
  The only different between running on Windows, Linux, LSF or the CI
  should be where the executable is located.
  Of course, if your code is pure python, you don't have to play this game...
  """
  if is_ci:
    executable = 'build_lsf/psp_swip_test'
  elif on_windows:
    executable = 'x64/release/UnitTests.exe'
  else:
    executable = 'build/psp_swip_test'
  return Path(executable)

def find_working_directory(context):
  """
  It's usually best to execute programs from what "should" be their working directory.
  Since the QA tools are typically executed from the project's root, you may need to pass a different path to your program.
  Also, if you run on Android, you may also need a concept like this (do you?)
  """
  if is_ci:
    working_directory = ''
  else:
    working_directory = 'swip_slam/UnitTests/RunningTime'
  return Path(working_directory)


# To access the CLI arguments from the user, use the context object passed to run() and postprocess().
# Reference: http://click.pocoo.org/6/complex/
#
# In short, context.obj is a dict with all the information you need:
# - recording_path: Pathlib Path
# - database_path: Pathlib Path
# - platform: string
# - configuration: string
# - output_directory: Pathlib Path, where you should:
#   1. write when running your algorithm
#   2. read when doing post-processing
# - etc

def run(context):
  """Sample implementation of a run() function."""
  command = ' '.join([
       f"{find_executable(context)}",
       f'--working_directory "{working_directory}"',
       f'--paramfile params.json',
       f'--paramfile {context.obj["configuration"]}',
       f'--paramfile {context.obj["tuning_filepath"]}' if 'tuning_filepath' in context.obj else '',
       f'--input_path "{database / context.obj['recording_path']}"',
       f'--output_path "{context.obj["output_directory"]}"',
       # extra flags are passed here
       context.obj['forwarded_args'],
  ])
  print(command)
  if dryrun: return
  start = time.time()
  pipes = subprocess.Popen(command, shell=True,
                           encoding='utf-8',
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE)
  std_out, std_err = pipes.communicate()
  print(std_err.strip(), std_out.strip())
  return {'compute_time': time.time()-start}


# from my_metrics import my_favorite_metric
def postprocess(context, runtime_metrics):
  ground_truth = database / context["recording_path"].parent / 'groundtruth.txt'
  # metrics = my_favorite_metric(context["output_directory"], ground_truth)
  # save_metrics({**runtime_metrics, **metrics})
  return {}
