"""
Sample implementation of a CLI wrapper with QA-Board.
"""
import sys
import subprocess
from pathlib import Path
import click


def run(context):
  """
  Runs your code, creates files under context.output_dir, and returns metrics.
  """
  click.secho("Edit qa/main.py to run *your* code using the context", fg='blue', bold=True)
  useful_context_keys = (
    'output_dir',         # Where you're expected to save results
    'input_path',         # .database / .rel_input_path
    # 'type',             # Useful if you need to handle different input types.. Read the docs!
    # 'input_metadata',   # Read the docs to enable this!
    'configs',          # List of configurations, the meaning is 100% on your side!
    'params',             # Merge of all the dicts in `configurations` and extra_parameters
    'platform',
    'forwarded_args',     # Extra list of CLI args, eg `qa batch --my-custom-extra-flag`
  )
  cli_formatter = {}
  for key in useful_context_keys:
    value = getattr(context, key)
    cli_formatter[key] = value
    click.secho(f"  .{key}:  {value}", fg='blue')
  # A common thing to do is running an executable (your compiled code, a script...),
  # or importing your Python code and calling it.

  # To get started with minimal effort and as example,
  # we run the extra CLI flags passed by the user.
  arg_format = lambda a: a.format(**cli_formatter)
  command = " ".join([arg_format(a) for a in context.forwarded_args])

  if command:
    click.secho("Below we run the CLI flags you gave qa:", fg='blue', bold=True)
    click.secho(f"> {command}", fg='blue')
  else:
    click.secho(f"Try to run something! eg:  qa {' '.join(sys.argv[1:])}"+ " 'echo {input_path} => {output_dir}'", fg='blue', bold=True)
    return {"is_failed": False}

  if context.dryrun:
    return {"is_failed": False}

  # What the command prints is saved in the run's log.txt (on Windows, only what Python prints:
  # pass stdout=subprocess.PIPE and print its output)
  returncode = subprocess.run(command, shell=True, cwd=context.output_dir).returncode
  if returncode != 0:
    return {"is_failed": True, "returncode": returncode}
  # Next: create plots, return metrics (https://samsung.github.io/qaboard/docs/computing-quantitative-metrics)
  return {"is_failed": False}



# def postprocess(runtime_metrics, context):
#   """
#   Optionally, you can define a `postprocess` function that, just like `run()`, can:
#     1. return a dict with metrics to save in metrics.json
#     2. Create any qualitative outputs you would like to view later (images, movies...)
#   """
#   # it can be as simple as....
#   return runtime_metrics

#   ## Sample ##
#   # You should know what files your code writes to, and what they mean
#   output_path = context.output_dir / 'my-output.txt'
#   metrics = {"is_failed": not output_path.exists()}
#   if metrics["is_failed"]:
#     return metrics

#   outputs = parse(output_path)
#   create_plots(outputs, context.output_dir)
#   # QA-Board shows all metrics. Say which way is better to see improvements in green, regressions in red
#   from qaboard import Metric
#   return {
#     **runtime_metrics,
#     **my_metrics(outputs),
#     "error_rate": Metric(my_error_rate(outputs), suffix="%", scale=100, smaller_is_better=True),
#   }
