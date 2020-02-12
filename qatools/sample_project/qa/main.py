"""
Sample implementation of a CLI wrapper using qatools.
"""
import sys
import subprocess
from pathlib import Path
import click

# We provide an easy way to know in which environment your code executes
from qatools.config import on_windows, on_linux, on_lsf, on_vdi
# Whis will identify runs through GitlabCI or Jenkins.
from qatools.config import is_ci


def run(context):
  """
  Runs you code, creates files under context.obj["output_directory], and returns metrics.
  """
  # The API asks us to give an list of configurations, and gives us tuning parameters separately,
  # but it's often simpler to aggregate everything... 
  # You will want to customize to e.g. allow deep merges...
  context.obj["parameters"] = {}
  for c in context.obj["configurations"]:
    if isinstance(c, dict):
      context.obj["parameters"].update(c)
  if context.obj["extra_parameters"]:
      context.obj["parameters"].update(context.obj["extra_parameters"])


  click.secho("TODO: Run *your* code using...", fg='cyan', bold=True)
  useful_context_keys = (
    'absolute_input_path',# Also: = database / input_path
    # 'input_type',       # Useful if you need to handle different input types.. Read the docs!
    # 'input_metadata',   # Read the docs to enable this!
    'configurations',     # List of configurations, the meaning is 100% on your side!
    'extra_parameters',   # Tuning parameters
    # 'tuning_filepath',  # JSON file with the extra_parameters... 
    'parameters',         # Merge of all the dicts in `configurations` and extra_parameters
    'platform',
    'output_directory',   # Where you're expected to save results
    'forwarded_args',     # Extra list of CLI args, eg `qa batch --my-custom-extra-flag`
  )
  for key in useful_context_keys:
    click.secho(f" * {key}:  {context.obj[key]}", fg='cyan')

  # A common thing to do is running an executable: compiled code, python2.7 code
  # or import some python code and run it!

  # To get started with minimal effort and as example,
  # we run the extra CLI flags passed by the user.
  arg_format = lambda a: a.format(**{**globals(), **locals(), **context.obj, **context.obj["parameters"]})
  click.secho("Until then we run the extra CLI flags you gave qa. (e.g. qa run --input my/input.jpg echo OK)", fg='cyan', bold=True)
  command = " ".join([arg_format(a) for a in context.obj['forwarded_args']])

  if command:
    click.secho(command)
  else:
    click.secho(f"Try to run something! eg '{' '.join(sys.argv[:1])}"+ "echo {absolute_input_path}'", fg='yellow')
    return {"is_failed": False}

  if context.obj['dryrun']:
    return

  pipe = subprocess.PIPE
  with subprocess.Popen(command, shell=True,
                        cwd=context.obj["output_directory"],
                        encoding='utf-8',
                        stdout=pipe, stderr=pipe) as process:
    for line in process.stdout:
      print(line)
    process.wait()

    if process.returncode:
      return {"is_failed": True, "returncode": process.returncode}
    return {"is_failed": False}

  click.secho("TODO: Create plots/graphs...", fg='cyan', bold=True)
  click.secho("TODO: Return metrics...", fg='cyan', bold=True)
  return {"is_failed": False}



# def postprocess(runtime_metrics, context):
#   """
#   Optionnaly, you can define a `postprocess` function that, just like `run()`, can:
#     1. return a dict with metrics to save in metrics.json
#     2. Create any qualitative outputs you would like to view later (images, movies...)
#
#
#    args:
#     context: Click.Context, context.obj has information from the CLI arguments
#     runtime_metrics: metrics from the run
#   """
#   # it can be as simple as....
#   return runtime_metrics

#   ## Sample ##
#   # You should know what files you algo writes to, and what they mean
#   output_path = context.obj["output_directory"] / 'my-output.txt'
#   metrics = {"is_failed": not output_path.exists()}
#   if metrics["is_failed"]:
#     return metrics

#   outputs = parse(output_path)
#   create_plots(outputs, context.obj['output_direectory'])
#   return {
#     **runtime_metrics,
#     **my_metrics(outputs),
#   }
