"""
Sample implementation of a CLI wrapper using qatools.
"""
import subprocess
import time

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
  if is_ci or is_lsf or is_vdi:
    executable = 'build_lsf/psp_swip_test'
  elif on_windows:
    executable = 'x64/release/UnitTests.exe'
  else:
    executable = 'build/psp_swip_test'
  return Path(executable)

def find_working_directory(context):
  """
  It's usually best to execute programs from what "should" be their working directory.
  The QA tools are executed from the project's root; but maybe you expect a different location.
  If you need this, either cd into it in your CLI invokation, or pass it as some "working_directory" to your executable.
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
# - recording_path: Pathlib Path: path to your test input, relative to the database
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
       f"{find_executable(context)}",
       f'--working_directory "{find_working_directory(context)}"',
       # you MUST implement a way to override the default configuration with diffs/deltas, from a base configuration
       # with partial configurations, corresponding to settings from an upstream block, or modes of operation
       f'--paramfile params.json', # default (TODO: rename base.json)
       # you could support only 1 configuration
       f'--paramfile {context.obj["configuration"]}',
       # you could support arrays of configurations, eg --configuration low_light:very_low_light
       ' '.join([f'--paramfile {c}' for c in configuration.split(':')])
       # you MUST support parameter tuning
       f'--paramfile {context.obj["tuning_filepath"]}' if 'tuning_filepath' in context.obj else '',
       # that the absolute path to the test
       f'--input_path "{context.obj['database'] / context.obj['recording_path']}"',
       # that where you should save your results
       f'--output_path "{context.obj["output_directory"]}"',
       # extra flags are passed here
       context.obj['forwarded_args'],
  ])
  print(command)
  if dryrun: return
  start = time.time()
  pipes = subprocess.Popen(command,
                           shell=True,
                           encoding='utf-8',
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE)
  std_out, std_err = pipes.communicate()
  print(std_err.strip(), std_out.strip())
  # some metrics like compute_time might not be determinable by the postprocessing
  # NOTE: if convenient, you can also directly write into metrics.json,
  #       postprocesing metrics will be merged.
  return {'compute_time': time.time()-start}



# from my_metrics import my_favorite_metric # ....

def postprocess(context, runtime_metrics):
  """
  Example of a postprocessing function.
  context: Click.Context, context.obj has information from the CLI arguments
  runtime_metrics: metrics that the 
  """
  # you are responsible knowing where the groundtruth is (if it exists)
  ground_truth = database / context.obj["recording_path"].parent / 'groundtruth.txt'
  # metrics = my_favorite_metric(context["output_directory"], ground_truth)


  # Depending on the input type, you could implement different postprocessing flows
  # if context.obj["recording_path"] == 'cis/siemens-star':
  #   resolution_from_center = find_resolution_from_center(context["output_directory"]/'image.bmp')
  #   create_plot(resolution_from_center, context["output_directory"]/'resolution.jpg')
  #   ...

  # those will be written into metrics.json
  return {**runtime_metrics, **metrics}
  return {}



# FYI: if needed, this gives you direct access to the the qatools.yaml configuration, parsed
from qatools.config import config
# TODO: document what's availble
